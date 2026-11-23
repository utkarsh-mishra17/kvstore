"""KVStore dashboard backend (FastAPI).

Every number served here comes from the real C++ server over TCP (STATSJSON, SNAPSHOT, POOL, EVENTS, REQS,
GANTT, DISKLOG, SIM* commands) or from the real kvbench / test-suite processes. There is no synthetic data.
"""
import asyncio
import csv
import io
import json
import os
import re
import subprocess
import threading
import time
from collections import deque
from typing import List, Optional

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import tests_runner
from kvclient import ControlConnection, KVConn

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
KV_HOST = os.environ.get("KV_HOST", "127.0.0.1")
KV_PORT = int(os.environ.get("KV_PORT", "7070"))
SERVER_BIN = os.path.join(ROOT, "build", "kvserver")
BENCH_BIN = os.path.join(ROOT, "build", "kvbench")
SERVER_ARGS = os.environ.get("KV_SERVER_ARGS", f"--port {KV_PORT} --workers 8 --queue 64 --frames 8").split()

app = FastAPI(title="KVStore Dashboard API", version="1.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
ctl = ControlConnection(KV_HOST, KV_PORT)


# ------------------------------------------------------------------------------------------ live monitor
class Monitor:
    """Polls the C++ server once per second and keeps rolling buffers for the dashboard."""

    def __init__(self):
        self.lock = threading.Lock()
        self.history = deque(maxlen=600)
        self.events = deque(maxlen=4000)
        self.reqs = deque(maxlen=1500)
        self.gantt = deque(maxlen=800)
        self.disklog = deque(maxlen=600)
        self.last = {"ev": 0, "rq": 0, "gt": 0, "dk": 0}
        self.latest = {"connected": False}
        self.prev = None
        self.subs = set()
        self.loop = None
        self.last_now_us = 0

    def reset_buffers(self):
        self.history.clear(); self.events.clear(); self.reqs.clear(); self.gantt.clear(); self.disklog.clear()
        self.last = {"ev": 0, "rq": 0, "gt": 0, "dk": 0}
        self.prev = None

    def poll_once(self):
        try:
            stats = ctl.request("STATSJSON").json()
            snap = ctl.request("SNAPSHOT").json()
            pool = ctl.request("POOL").json()
            if stats["server"]["now_us"] < self.last_now_us:  # server restarted: its counters/ids start over
                self.reset_buffers()
            self.last_now_us = stats["server"]["now_us"]
            ev = ctl.request(f"EVENTS {self.last['ev']} 600").json()
            rq = ctl.request(f"REQS {self.last['rq']}").json()
            gt = ctl.request(f"GANTT {self.last['gt']}").json()
            dk = ctl.request(f"DISKLOG {self.last['dk']}").json()
        except Exception as e:
            self.latest = {"connected": False, "error": str(e)}
            self.broadcast({"type": "tick", "connected": False, "error": str(e)})
            return
        now = time.time()
        cur = {"t": now, "uptime": stats["server"]["uptime_s"], "completed": stats["requests"]["completed"]}
        rps = 0.0
        if self.prev and cur["uptime"] > self.prev["uptime"]:
            rps = max(0.0, (cur["completed"] - self.prev["completed"]) / (cur["uptime"] - self.prev["uptime"]))
        self.prev = cur
        bp, cpu = stats["buffer_pool"], stats["cpu"]
        point = {"t": int(now * 1000), "rps": round(rps, 1), "active": stats["clients"]["active"], "hits": bp["hits"], "misses": bp["misses"],
                 "hit_ratio": bp["hit_ratio"], "avg_turnaround_us": cpu["avg_turnaround_us"], "avg_wait_us": cpu["avg_wait_us"],
                 "queue": stats["queue"]["size"], "completed": stats["requests"]["completed"], "seek": stats["disk"]["total_seek"],
                 "busy": stats["workers"]["busy"], "occupied": bp["occupied"], "frames": bp["frames"]}
        with self.lock:
            self.history.append(point)
            for lst, items, key, idk in ((self.events, ev, "ev", "id"), (self.reqs, rq, "rq", "seq"), (self.gantt, gt, "gt", "seq"), (self.disklog, dk, "dk", "seq")):
                lst.extend(items)
                if items:
                    self.last[key] = items[-1][idk]
            self.latest = {"connected": True, "stats": stats, "snapshot": snap, "pool": pool}
        self.broadcast({"type": "tick", "connected": True, "stats": stats, "snapshot": snap, "pool": pool, "point": point,
                        "events": ev, "reqs": rq, "gantt": gt, "disklog": dk})

    def broadcast(self, msg):
        if not self.loop:
            return
        for q in list(self.subs):
            self.loop.call_soon_threadsafe(self._put, q, msg)

    @staticmethod
    def _put(q, msg):
        if q.full():
            try:
                q.get_nowait()
            except asyncio.QueueEmpty:
                pass
        q.put_nowait(msg)

    def run(self):
        while True:
            t0 = time.time()
            self.poll_once()
            time.sleep(max(0.05, 1.0 - (time.time() - t0)))

    def bootstrap(self):
        with self.lock:
            return {**self.latest, "history": list(self.history), "events": list(self.events)[-1500:], "reqs": list(self.reqs),
                    "gantt": list(self.gantt), "disklog": list(self.disklog)}


mon = Monitor()


@app.on_event("startup")
async def _startup():
    mon.loop = asyncio.get_running_loop()
    threading.Thread(target=mon.run, daemon=True).start()
    if os.path.isdir(FRONTEND_DIST):
        app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="ui")


FRONTEND_DIST = os.path.join(ROOT, "dashboard", "frontend", "dist")


@app.websocket("/ws")
async def ws(sock: WebSocket):
    await sock.accept()
    q = asyncio.Queue(maxsize=20)
    mon.subs.add(q)
    try:
        while True:
            await sock.send_json(await q.get())
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        mon.subs.discard(q)


# ------------------------------------------------------------------------------------------ helpers
def kv(cmd: str):
    """Run a command on the control connection; raise a clean HTTP error if the server is unreachable."""
    try:
        return ctl.request(cmd)
    except Exception as e:
        raise HTTPException(503, f"KVStore server unreachable at {KV_HOST}:{KV_PORT}: {e}")


def kv_json(cmd: str):
    r = kv(cmd)
    if not r.ok:
        raise HTTPException(400, r.text)
    return r.json()


def kv_ok(cmd: str):
    r = kv(cmd)
    if not r.ok:
        raise HTTPException(400, r.text)
    return r


def stats():
    return kv_json("STATSJSON")


# ------------------------------------------------------------------------------------------ basic API
@app.get("/api/health")
def health():
    return {"connected": ctl.available(), "host": KV_HOST, "port": KV_PORT}


@app.get("/api/bootstrap")
def bootstrap():
    return mon.bootstrap()


class Cmd(BaseModel):
    command: str = Field(min_length=1, max_length=2000)
    client: str = "explorer"


@app.post("/api/cmd")
def run_cmd(body: Cmd):
    """Run one protocol command over a fresh TCP connection (appears as its own client in the server)."""
    c = body.command.strip()
    if "\n" in c or "\r" in c:
        raise HTTPException(400, "single-line commands only")
    if c.split(" ", 1)[0].upper() == "SHUTDOWN":
        raise HTTPException(400, "use /api/server/restart")
    try:
        with KVConn(KV_HOST, KV_PORT, name=body.client) as conn:
            r = conn.request(c)
    except Exception as e:
        raise HTTPException(503, f"KVStore server unreachable: {e}")
    return {"command": c, **r.as_dict()}


class Config(BaseModel):
    cpu_policy: Optional[str] = None
    quantum: Optional[int] = Field(None, ge=1, le=1000)
    disk_alg: Optional[str] = None
    cache_policy: Optional[str] = None
    frames: Optional[int] = Field(None, ge=2, le=128)
    delay_us: Optional[int] = Field(None, ge=0, le=100000)
    io_delay_us: Optional[int] = Field(None, ge=0, le=10000)
    disk_window_us: Optional[int] = Field(None, ge=0, le=1000000)
    disk_head: Optional[int] = Field(None, ge=0, le=199)
    lock_ordered: Optional[bool] = None
    lock_hold_us: Optional[int] = Field(None, ge=0, le=2000000)


@app.post("/api/config")
def set_config(c: Config):
    out = []
    if c.cpu_policy:
        out.append(kv_ok(f"POLICY {c.cpu_policy}" + (f" {c.quantum}" if c.quantum else "")).text)
    elif c.quantum:
        out.append(kv_ok(f"QUANTUM {c.quantum}").text)
    if c.disk_alg:
        out.append(kv_ok(f"DISK {c.disk_alg}").text)
    if c.cache_policy:
        out.append(kv_ok(f"CACHE {c.cache_policy}").text)
    if c.frames:
        out.append(kv_ok(f"SETFRAMES {c.frames}").text)
    for val, cmd in ((c.delay_us, "DELAY"), (c.io_delay_us, "IODELAY"), (c.disk_window_us, "DISKWINDOW"), (c.disk_head, "DISKHEAD"), (c.lock_hold_us, "LOCKHOLD")):
        if val is not None:
            out.append(kv_ok(f"{cmd} {val}").text)
    if c.lock_ordered is not None:
        out.append(kv_ok("LOCKORDER " + ("on" if c.lock_ordered else "off")).text)
    return {"applied": out}


@app.post("/api/admin/{action}")
def admin(action: str):
    cmds = {"reset": "RESET", "flush": "FLUSH", "pause": "PAUSE", "resume": "RESUME"}
    if action not in cmds:
        raise HTTPException(404, "unknown action")
    return {"result": kv_ok(cmds[action]).text}


@app.post("/api/seed")
def seed(count: int = 50):
    count = max(1, min(count, 500))
    names = ["alice", "bob", "carol", "dave", "erin", "frank", "grace", "heidi", "ivan", "judy"]
    with KVConn(KV_HOST, KV_PORT, name="seeder") as conn:
        for i in range(0, count, 8):
            pairs = " ".join(f"user:{j} {names[j % 10]}-{j}" for j in range(i, min(count, i + 8)))
            if not conn.request("MSET " + pairs).ok:
                raise HTTPException(500, "seed failed")
    return {"seeded": count}


@app.post("/api/server/restart")
def restart_server():
    """Graceful SHUTDOWN (dirty frames flushed), then start a fresh kvserver process on the same data.db."""
    try:
        with KVConn(KV_HOST, KV_PORT, timeout=5) as c:
            c.request("SHUTDOWN")
    except Exception:
        pass
    for _ in range(100):
        time.sleep(0.1)
        if not ctl.available():
            break
    ctl.conn = None
    log = open(os.path.join(ROOT, "data", "server.out"), "ab")
    subprocess.Popen([SERVER_BIN] + SERVER_ARGS, cwd=ROOT, stdout=log, stderr=log, start_new_session=True)
    for _ in range(100):
        time.sleep(0.1)
        if ctl.available():
            return {"restarted": True}
    raise HTTPException(500, "server did not come back")


# ------------------------------------------------------------------------------------------ simulations (run by the C++ algorithms)
class SchedJob(BaseModel):
    name: str = Field(pattern=r"^[A-Za-z0-9_-]{1,12}$")
    arrival: int = Field(0, ge=0, le=100000)
    burst: int = Field(ge=1, le=10000)
    priority: int = Field(1, ge=1, le=9)


class SchedSim(BaseModel):
    policy: str
    quantum: int = Field(4, ge=1, le=1000)
    jobs: List[SchedJob] = Field(min_length=1, max_length=50)


def _sched_cmd(policy, quantum, jobs):
    return f"SIMSCHED {policy} {quantum} " + " ".join(f"{j.name}:{j.arrival}:{j.burst}:{j.priority}" for j in jobs)


@app.post("/api/sim/sched")
def sim_sched(b: SchedSim):
    return kv_json(_sched_cmd(b.policy, b.quantum, b.jobs))


@app.post("/api/sim/sched/compare")
def sim_sched_compare(b: SchedSim):
    return {p: kv_json(_sched_cmd(p, b.quantum, b.jobs)) for p in ("fcfs", "sjf", "priority", "rr")}


class DiskSim(BaseModel):
    algorithm: str = "scan"
    head: int = Field(50, ge=0, le=9999)
    max_track: int = Field(199, ge=1, le=9999)
    direction: str = Field("up", pattern="^(up|down)$")
    requests: List[int] = Field(min_length=1, max_length=200)


def _disk_cmd(alg, b):
    return f"SIMDISK {alg} {b.head} {b.max_track} {b.direction} " + " ".join(map(str, b.requests))


@app.post("/api/sim/disk")
def sim_disk(b: DiskSim):
    return kv_json(_disk_cmd(b.algorithm, b))


@app.post("/api/sim/disk/compare")
def sim_disk_compare(b: DiskSim):
    return {a: kv_json(_disk_cmd(a, b)) for a in ("fcfs", "sstf", "scan", "cscan", "look", "clook")}


class PageSim(BaseModel):
    policy: str = "lru"
    frames: int = Field(3, ge=1, le=64)
    refs: List[str] = Field(min_length=1, max_length=200)  # "7", "3w" (w = write -> dirty)


@app.post("/api/sim/pages")
def sim_pages(b: PageSim):
    return kv_json(f"SIMPAGE {b.policy} {b.frames} " + " ".join(b.refs))


@app.post("/api/sim/pages/compare")
def sim_pages_compare(b: PageSim):
    return {p: kv_json(f"SIMPAGE {p} {b.frames} " + " ".join(b.refs)) for p in ("fifo", "lru", "clock")}


# ------------------------------------------------------------------------------------------ live demonstrations on the real server
class LiveJob(BaseModel):
    label: str = Field(max_length=16)
    command: str = Field(max_length=300)
    priority: int = Field(1, ge=1, le=9)
    delay_ms: int = Field(0, ge=0, le=2000)


class CpuDemo(BaseModel):
    policy: str = "priority"
    quantum: int = Field(16, ge=1, le=1000)
    jobs: List[LiveJob] = Field(min_length=1, max_length=12)


@app.post("/api/demo/cpu")
def demo_cpu(b: CpuDemo):
    """Pause dispatch, submit the jobs from separate TCP clients, resume, and report the real dispatch order."""
    allowed = ("SET", "GET", "DEL", "LIST", "MSET")
    for j in b.jobs:
        if j.command.split(" ", 1)[0].upper() not in allowed:
            raise HTTPException(400, f"job '{j.label}': only data commands allowed")
    kv_ok(f"POLICY {b.policy} {b.quantum}")
    kv_ok("PAUSE")
    results = {}

    def send(j):
        time.sleep(j.delay_ms / 1000)
        try:
            with KVConn(KV_HOST, KV_PORT, name="demo-" + j.label, timeout=60) as c:
                results[j.label] = c.request(f"@prio={j.priority} {j.command}")
        except Exception as e:
            results[j.label] = None

    ts = [threading.Thread(target=send, args=(j,)) for j in b.jobs]
    try:
        for t in ts:
            t.start()
        deadline = time.time() + 5
        while time.time() < deadline:
            if stats()["queue"]["size"] >= len(b.jobs):
                break
            time.sleep(0.05)
        queued = stats()["queue"]["size"]
    finally:
        kv("RESUME")
    for t in ts:
        t.join(60)
    rows = [{"label": k, **r.meta, "response": r.lines[0] if r.lines else ""} for k, r in results.items() if r]
    rows.sort(key=lambda x: int(x["dispatch"]))
    return {"policy": b.policy, "quantum": b.quantum, "queued_before_resume": queued, "results": rows}


class DeadlockDemo(BaseModel):
    ordered: bool = True
    hold_ms: int = Field(30, ge=0, le=500)


def _pick_two_keys():
    ka = kb = None
    i = 0
    while kb is None:
        k = f"acct:{i}"
        if ka is None:
            ka = k
        elif tests_runner.block_of(k) > tests_runner.block_of(ka):
            kb = k
        i += 1
    return ka, kb


@app.post("/api/demo/deadlock")
def demo_deadlock(b: DeadlockDemo):
    """Client 1: MSET A B and Client 2: MSET B A at the same moment, with and without ascending lock ordering."""
    st0 = stats()
    ka, kb = _pick_two_keys()
    last_ev = mon.last["ev"]
    kv_ok("LOCKORDER " + ("on" if b.ordered else "off"))
    kv_ok(f"LOCKHOLD {b.hold_ms * 1000}")
    res, bar = {}, threading.Barrier(2)

    def run(label, first, second):
        with KVConn(KV_HOST, KV_PORT, name=label, timeout=30) as c:
            bar.wait(10)
            res[label] = c.request(f"MSET {first} {label}-1 {second} {label}-2")

    ts = [threading.Thread(target=run, args=("client1", ka, kb)), threading.Thread(target=run, args=("client2", kb, ka))]
    t0 = time.time()
    for t in ts:
        t.start()
    for t in ts:
        t.join(40)
    elapsed = time.time() - t0
    kv("LOCKORDER " + ("on" if st0["sync"]["ordered_locking"] else "off"))
    kv(f"LOCKHOLD {st0['sync']['lock_hold_us']}")
    ids = {r.meta.get("id") for r in res.values() if r.meta.get("id")}
    events = [e for e in kv_json(f"EVENTS {last_ev} 800") if e["type"] in ("LOCK", "ERROR") and any(f"req={i} " in e["msg"] + " " for i in ids)]
    return {"ordered": b.ordered, "keys": {"A": ka, "B": kb}, "blocks": {"A": tests_runner.block_of(ka), "B": tests_runner.block_of(kb)},
            "elapsed_ms": int(elapsed * 1000), "clients": {k: {"command": f"MSET {ka if k == 'client1' else kb} .. {kb if k == 'client1' else ka} ..", "response": r.lines[0] if r.lines else "", "meta": r.meta} for k, r in res.items()},
            "events": events}


class RWDemo(BaseModel):
    readers: int = Field(4, ge=1, le=8)
    writers: int = Field(2, ge=1, le=4)
    hold_ms: int = Field(40, ge=1, le=300)


@app.post("/api/demo/readwrite")
def demo_rw(b: RWDemo):
    """N readers and M writers hit ONE key (one block lock) at the same time; returns the real lock event timeline."""
    st0 = stats()
    key = "rw:demo"
    kv_ok(f"SET {key} initial")
    last_ev = mon.last["ev"]
    kv_ok(f"DELAY {b.hold_ms * 1000}")
    res, bar = {}, threading.Barrier(b.readers + b.writers)

    def run(label, cmd):
        with KVConn(KV_HOST, KV_PORT, name=label, timeout=30) as c:
            bar.wait(10)
            res[label] = c.request(cmd)

    ts = [threading.Thread(target=run, args=(f"reader{i+1}", f"GET {key}")) for i in range(b.readers)]
    ts += [threading.Thread(target=run, args=(f"writer{i+1}", f"SET {key} v{i+1}")) for i in range(b.writers)]
    for t in ts:
        t.start()
    for t in ts:
        t.join(40)
    kv(f"DELAY {st0['cpu']['service_delay_us']}")
    ids = {r.meta.get("id"): k for k, r in res.items() if r.meta.get("id")}
    events = []
    for e in kv_json(f"EVENTS {last_ev} 1000"):
        m = re.match(r"(ACQUIRE|RELEASE) req=(\d+) (READ|WRITE)", e["msg"])
        if e["type"] == "LOCK" and m and m.group(2) in ids:
            events.append({"t_us": e["t_us"], "action": m.group(1), "mode": m.group(3), "who": ids[m.group(2)], "msg": e["msg"]})
    return {"key": key, "block": tests_runner.block_of(key), "hold_ms": b.hold_ms, "events": events,
            "clients": {k: {"response": r.lines[0] if r.lines else "", "meta": r.meta} for k, r in res.items()}}


# ------------------------------------------------------------------------------------------ benchmark
bench_results: List[dict] = []
bench_lock = threading.Lock()


class Bench(BaseModel):
    clients: int = Field(20, ge=1, le=500)
    requests: int = Field(2000, ge=1, le=500000)
    duration: float = Field(0, ge=0, le=120)
    operation: str = Field("MIXED", pattern="^(?i)(SET|GET|DEL|MSET|LIST|MIXED|MIXLIST)$")
    policy: Optional[str] = None
    quantum: Optional[int] = Field(None, ge=1, le=1000)
    delay_us: Optional[int] = Field(None, ge=0, le=100000)
    priorities: bool = False


def _bench_once(b: Bench, label=""):
    if not os.path.exists(BENCH_BIN):
        raise HTTPException(500, "kvbench not built (run make)")
    if b.policy:
        kv_ok(f"POLICY {b.policy}" + (f" {b.quantum}" if b.quantum else ""))
    if b.delay_us is not None:
        kv_ok(f"DELAY {b.delay_us}")
    before = stats()
    cmd = [BENCH_BIN, "-h", KV_HOST, "-p", str(KV_PORT), "-c", str(b.clients), "-n", str(b.requests), "-o", b.operation.upper()]
    if b.duration > 0:
        cmd += ["-d", str(b.duration)]
    if b.priorities:
        cmd += ["--prio"]
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=int(b.duration) + 180)
    if out.returncode != 0 or not out.stdout.strip():
        raise HTTPException(500, "benchmark failed: " + out.stderr[:300])
    r = json.loads(out.stdout)
    after = stats()
    pol = after["cpu"]["policy"]
    pb, pa = before["cpu"]["per_policy"][pol], after["cpu"]["per_policy"][pol]
    dn = pa["n"] - pb["n"]
    sb, sa = before["buffer_pool"], after["buffer_pool"]
    dh, dm = sa["hits"] - sb["hits"], sa["misses"] - sb["misses"]
    r.update({
        "id": int(time.time() * 1000), "label": label, "policy": pol, "quantum": after["cpu"]["quantum"], "service_delay_us": after["cpu"]["service_delay_us"],
        "avg_wait_us": (pa["avg_wait_us"] * pa["n"] - pb["avg_wait_us"] * pb["n"]) / dn if dn else 0,
        "avg_turnaround_us": (pa["avg_turnaround_us"] * pa["n"] - pb["avg_turnaround_us"] * pb["n"]) / dn if dn else 0,
        "cache_hit_ratio": dh / (dh + dm) if dh + dm else 0, "disk_seek": after["disk"]["total_seek"] - before["disk"]["total_seek"],
        "server_peak_connections": after["clients"]["peak"], "preemptions": after["queue"]["requeued"] - before["queue"]["requeued"],
        "target_100_clients": "VERIFIED" if r["connected"] >= 100 and r["failed"] == 0 else ("NOT VERIFIED" if r["clients"] >= 100 else "n/a"),
        "time": time.strftime("%Y-%m-%d %H:%M:%S"),
    })
    with bench_lock:
        bench_results.append(r)
    return r


@app.post("/api/bench/run")
def bench_run(b: Bench):
    return _bench_once(b)


@app.post("/api/bench/compare")
def bench_compare(b: Bench):
    """Run the identical workload under FCFS, SJF, Priority and Round Robin."""
    runs = []
    prev_delay = stats()["cpu"]["service_delay_us"]
    for pol in ("fcfs", "sjf", "priority", "rr"):
        runs.append(_bench_once(b.copy(update={"policy": pol}), label="compare"))
    kv(f"DELAY {prev_delay}")
    return {"runs": runs}


@app.get("/api/bench/results")
def bench_list():
    with bench_lock:
        return list(bench_results)


# ------------------------------------------------------------------------------------------ tests
test_state = {"running": False, "results": {}, "started": None}


def _run_tests():
    test_state.update(running=True, started=time.time(), results={})

    def cb(r):
        test_state["results"][r["id"]] = r

    try:
        tests_runner.run_all(on_result=cb)
    finally:
        test_state["running"] = False


@app.post("/api/tests/run")
def tests_run():
    if test_state["running"]:
        raise HTTPException(409, "already running")
    threading.Thread(target=_run_tests, daemon=True).start()
    return {"started": True}


@app.get("/api/tests")
def tests_status():
    rows = []
    for tid, module, name, _ in tests_runner.TESTS:
        rows.append(test_state["results"].get(tid, {"id": tid, "module": module, "name": name, "status": "PENDING"}))
    return {"running": test_state["running"], "results": rows}


# ------------------------------------------------------------------------------------------ CSV export
def _csv(rows, fields):
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=fields, extrasaction="ignore")
    w.writeheader()
    w.writerows(rows)
    return PlainTextResponse(buf.getvalue(), media_type="text/csv", headers={"Content-Disposition": "attachment"})


@app.get("/api/export/logs.csv")
def export_logs():
    return _csv(kv_json("EVENTS 0 2000"), ["id", "time", "type", "t_us", "msg"])


@app.get("/api/export/requests.csv")
def export_reqs():
    return _csv(kv_json("REQS 0"), ["seq", "id", "client", "op", "key", "priority", "cost", "arrival_us", "start_us", "completion_us", "wait_us", "service_us", "turnaround_us", "slices", "worker", "hits", "misses", "policy", "locks", "ok"])


@app.get("/api/export/bench.csv")
def export_bench():
    with bench_lock:
        rows = list(bench_results)
    return _csv(rows, ["time", "label", "operation", "policy", "clients", "connected", "total_requests", "successful", "failed", "duration_s", "requests_per_sec", "avg_latency_us",
                       "min_latency_us", "max_latency_us", "p50_us", "p95_us", "p99_us", "error_rate", "avg_wait_us", "avg_turnaround_us", "cache_hit_ratio", "disk_seek", "target_100_clients"])
