"""Automated validation of the synopsis test cases (TC-01 .. TC-09) plus the 100-client target (TC-10).

Every test starts its OWN fresh kvserver process (separate port, temp data file), drives it over TCP and
compares the observed behaviour with a hand-computed expectation. Nothing here is mocked.
"""
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time

from kvclient import KVConn

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SERVER_BIN = os.path.join(ROOT, "build", "kvserver")
BENCH_BIN = os.path.join(ROOT, "build", "kvbench")
NUM_BLOCKS = 200


def block_of(key: str) -> int:
    h = 2166136261
    for b in key.encode():
        h ^= b
        h = (h * 16777619) & 0xFFFFFFFF
    return h % NUM_BLOCKS


def key_for_block(block, prefix="k"):
    for i in range(100000):
        k = f"{prefix}{i}"
        if block_of(k) == block:
            return k
    raise RuntimeError("no key found")


def distinct_block_keys(n, prefix="d"):
    keys, seen, i = [], set(), 0
    while len(keys) < n:
        k = f"{prefix}{i}"
        b = block_of(k)
        if b not in seen:
            seen.add(b)
            keys.append(k)
        i += 1
    return keys


class TestServer:
    def __init__(self, port, workdir, **opts):
        self.port, self.workdir, self.opts = port, workdir, opts
        self.data = os.path.join(workdir, "data.db")
        self.proc = None

    def start(self):
        args = [SERVER_BIN, "--port", str(self.port), "--data", self.data, "--log", os.path.join(self.workdir, "kv.log")]
        for k, v in self.opts.items():
            args += ["--" + k, str(v)]
        self.proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(100):
            try:
                KVConn(port=self.port, timeout=1).close()
                return self
            except OSError:
                time.sleep(0.05)
        raise RuntimeError("server did not start")

    def conn(self, name=None):
        return KVConn(port=self.port, name=name)

    def stop(self, graceful=True):
        if not self.proc:
            return
        if graceful:
            try:
                with self.conn() as c:
                    c.request("SHUTDOWN")
            except Exception:
                pass
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        else:
            self.proc.kill()
        self.proc = None

    def __enter__(self):
        return self.start()

    def __exit__(self, *a):
        self.stop()


def sim(c, cmd):
    r = c.request(cmd)
    if not r.ok:
        raise AssertionError(r.text)
    return r.json()


# ----------------------------------------------------------------------------------------------- tests
def tc01(ctx):
    """Priority dispatch: Normal(t=0), High(t=1), Admin(t=2) -> Admin first."""
    with TestServer(ctx.port(), ctx.tmp(), workers=2, cpu="priority") as s:
        ctl = s.conn()
        ctl.request("PAUSE")  # keep every request queued so the scheduler can choose among all three
        results = {}

        def send(label, prio, delay):
            time.sleep(delay)
            with s.conn() as c:
                results[label] = c.request(f"@prio={prio} SET tc01:{label} 1")

        threads = [threading.Thread(target=send, args=a) for a in (("normal", 1, 0.0), ("high", 2, 0.15), ("admin", 3, 0.30))]
        for t in threads:
            t.start()
        time.sleep(0.6)
        qsize = ctl.request("STATSJSON").json()["queue"]["size"]
        ctl.request("RESUME")
        for t in threads:
            t.join()
        order = sorted(results, key=lambda k: int(results[k].meta["dispatch"]))
        ctl.close()
        return {"input": "Normal prio=1 (t=0), High prio=2 (t=1), Admin prio=3 (t=2), dispatch paused until all queued",
                "expected": "dispatch order: admin, high, normal", "actual": f"queued={qsize}; dispatch order: {', '.join(order)}",
                "passed": qsize == 3 and order == ["admin", "high", "normal"],
                "details": [f"{k}: dispatch#{results[k].meta['dispatch']} wait={results[k].meta['wait_us']}us" for k in order]}


def tc02(ctx):
    """Round Robin, quantum 4, scans of cost 6, 4, 9 (virtual-time run of the real scheduler code + live slicing check)."""
    with TestServer(ctx.port(), ctx.tmp(), cpu="rr") as s:
        c = s.conn()
        r = sim(c, "SIMSCHED rr 4 S1:0:6:1 S2:0:4:1 S3:0:9:1")
        got = {j["name"]: (j["completion"], j["waiting"], j["turnaround"]) for j in r["jobs"]}
        # hand-computed slices: S1 0-4, S2 4-8(done), S3 8-12, S1 12-14(done), S3 14-18, S3 18-19(done)
        exp = {"S1": (14, 8, 14), "S2": (8, 4, 8), "S3": (19, 10, 19)}
        slices_ok = all(g["end"] - g["start"] <= 4 for g in r["gantt"]) and len(r["gantt"]) == 6
        c.request("POLICY rr 8")
        lr = c.request("LIST")
        live_slices = int(lr.meta["slices"])
        c.close()
        return {"input": "RR quantum=4, jobs cost 6,4,9 all arriving at t=0; then live LIST with quantum=8",
                "expected": f"(completion, waiting, turnaround) {exp}; every slice <= 4; live LIST sliced into ceil(200/8)=25 slices",
                "actual": f"{got}; gantt={[(g['name'], g['start'], g['end']) for g in r['gantt']]}; live LIST slices={live_slices}",
                "passed": got == exp and slices_ok and live_slices == 25,
                "details": [f"avg waiting={r['avg_wait']}, avg turnaround={r['avg_turnaround']}"]}


def tc03(ctx):
    """SCAN vs C-SCAN seek distance: head 50, requests 20 90 50 10 on tracks 0..199."""
    with TestServer(ctx.port(), ctx.tmp()) as s:
        c = s.conn()
        exp = {"FCFS": 180, "SSTF": 120, "SCAN": 338, "C-SCAN": 368, "LOOK": 120, "C-LOOK": 130}
        got, det = {}, []
        for alg in ("fcfs", "sstf", "scan", "cscan", "look", "clook"):
            r = sim(c, f"SIMDISK {alg} 50 199 up 20 90 50 10")
            got[r["algorithm"]] = r["total_seek"]
            det.append(f"{r['algorithm']}: order={[o['block'] for o in r['order']]} total={r['total_seek']}")
        c.close()
        return {"input": "head=50, requests 20,90,50,10, tracks 0..199, initial direction = up",
                "expected": f"SCAN=338 (50>90>199>20>10), C-SCAN=368 (incl. 199-track return); others {exp}",
                "actual": str(got), "passed": got == exp, "details": det}


def tc04(ctx):
    """SSTF picks the nearest block: head 40, requests 15 60 30 -> 30, 15, 60 (simulated and on the live disk thread)."""
    with TestServer(ctx.port(), ctx.tmp(), workers=4) as s:
        c = s.conn()
        r = sim(c, "SIMDISK sstf 40 199 up 15 60 30")
        sim_order = [o["block"] for o in r["order"]]
        # live: batch window so all three block reads are pending together, then check the order the disk executed them
        c.request("DISK sstf")
        c.request("DISKWINDOW 300000")
        c.request("DISKHEAD 40")
        c.request("RESET")
        keys = {b: key_for_block(b, "tc04_") for b in (15, 60, 30)}
        threads = []
        for b in (15, 60, 30):
            t = threading.Thread(target=lambda k=keys[b]: s.conn().request("GET " + k))
            threads.append(t)
            t.start()
            time.sleep(0.02)
        for t in threads:
            t.join()
        log = c.request("DISKLOG 0").json()
        live_order = [d["block"] for d in log if d["op"] == "READ"]
        c.close()
        return {"input": "head=40, requests 15, 60, 30",
                "expected": "order 30 -> 15 -> 60 (total seek 70)",
                "actual": f"simulated={sim_order} (seek {r['total_seek']}); live disk thread={live_order}",
                "passed": sim_order == [30, 15, 60] and r["total_seek"] == 70 and live_order == [30, 15, 60]}


def tc05(ctx):
    """LRU replacement: 3 frames, reference string 7 0 1 2 0 3 0 4 -> 6 page faults."""
    with TestServer(ctx.port(), ctx.tmp()) as s:
        c = s.conn()
        refs = "7 0 1 2 0 3 0 4"
        res = {p: sim(c, f"SIMPAGE {p} 3 {refs}") for p in ("lru", "fifo", "clock")}
        c.close()
        lru = res["lru"]
        return {"input": "3 frames, reference string 7,0,1,2,0,3,0,4",
                "expected": "LRU: 6 page faults, 2 hits (7,0,1,2,3,4 fault; the two 0 re-references hit). FIFO by hand: 7 faults.",
                "actual": f"LRU faults={lru['faults']} hits={lru['hits']}; FIFO faults={res['fifo']['faults']}; Clock faults={res['clock']['faults']}",
                "passed": lru["faults"] == 6 and lru["hits"] == 2 and res["fifo"]["faults"] == 7,
                "details": [f"{p.upper()}: final frames={res[p]['steps'][-1]['frames']}" for p in res]}


def tc06(ctx):
    """Cache hit + dirty write-back (2 frames, LRU)."""
    with TestServer(ctx.port(), ctx.tmp(), frames=2, cache="lru") as s:
        c = s.conn()
        ka, kb, kc = distinct_block_keys(3, "tc06_")
        marker = "DIRTY-VALUE-TC06-MARKER"

        def disk_has_marker():
            with open(s.data, "rb") as f:
                return marker.encode() in f.read()

        c.request("RESET")
        g1 = c.request("GET " + ka)
        g2 = c.request("GET " + ka)
        c.request(f"SET {ka} {marker}")
        st = c.request("STATSJSON").json()["buffer_pool"]
        wb0, dirty_before = st["writebacks"], st["dirty"]
        on_disk_before = disk_has_marker()
        c.request("GET " + kb)
        c.request("GET " + kc)  # 2 frames: forces eviction of the dirty block for ka
        st2 = c.request("STATSJSON").json()["buffer_pool"]
        on_disk_after = disk_has_marker()
        c.close()
        ok = (g1.meta["misses"] == "1" and g2.meta["hits"] == "1" and dirty_before >= 1 and not on_disk_before
              and st2["writebacks"] > wb0 and on_disk_after)
        return {"input": "GET k twice; SET k; GET two other keys with only 2 frames",
                "expected": "1st GET miss, 2nd GET hit; SET leaves the frame dirty (not yet in data.db); eviction writes it back to data.db",
                "actual": f"1st GET misses={g1.meta['misses']}, 2nd GET hits={g2.meta['hits']}; dirty frames={dirty_before}; marker in data.db before eviction={on_disk_before}; "
                          f"write-backs {wb0}->{st2['writebacks']}; marker in data.db after eviction={on_disk_after}",
                "passed": ok}


def tc07(ctx):
    """Readers-writers consistency: 2 writers update one key while 5 readers read it."""
    with TestServer(ctx.port(), ctx.tmp(), workers=8) as s:
        a, b = "A" * 200, "B" * 200
        ctl = s.conn()
        ctl.request("SET shared " + a)
        ctl.request("DELAY 150")  # hold block locks longer so reads and writes genuinely overlap
        bad, reads, writes = [], [0], [0]
        lock = threading.Lock()

        def writer(val):
            with s.conn() as c:
                for _ in range(120):
                    if c.request(f"SET shared {val}").ok:
                        with lock:
                            writes[0] += 1

        def reader():
            with s.conn() as c:
                for _ in range(120):
                    r = c.request("GET shared")
                    v = r.lines[0][6:] if r.lines and r.lines[0].startswith("VALUE ") else r.text
                    with lock:
                        reads[0] += 1
                        if v not in (a, b):
                            bad.append(v[:40])

        ts = [threading.Thread(target=writer, args=(a,)), threading.Thread(target=writer, args=(b,))] + [threading.Thread(target=reader) for _ in range(5)]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        sy = ctl.request("STATSJSON").json()["sync"]
        ctl.close()
        return {"input": "2 writer clients (alternating 200x'A' / 200x'B') + 5 reader clients, 120 ops each",
                "expected": "every value read is exactly the full 'A' string or the full 'B' string",
                "actual": f"{reads[0]} reads, {writes[0]} writes, corrupted/partial reads={len(bad)}; lock contention events={sy['contended_acquisitions']}",
                "passed": not bad and reads[0] == 600 and writes[0] == 240}


def tc08(ctx):
    """Deadlock-free multi-key MSET: concurrent MSET A B / MSET B A."""
    with TestServer(ctx.port(), ctx.tmp(), workers=4) as s:
        ka, kb = None, None
        keys = distinct_block_keys(2, "tc08_")
        ka, kb = keys
        ctl = s.conn()
        ctl.request("LOCKORDER on")
        ctl.request("LOCKHOLD 2000")  # 2 ms between lock acquisitions: a wide window for circular wait
        fails, done = [], [0]
        lock = threading.Lock()
        barrier = threading.Barrier(2)

        def run(first, second, tag):
            with s.conn() as c:
                for i in range(60):
                    try:
                        barrier.wait(timeout=20)
                    except threading.BrokenBarrierError:
                        return
                    r = c.request(f"MSET {first} {tag}{i} {second} {tag}{i}")
                    with lock:
                        done[0] += 1
                        if not r.ok:
                            fails.append(r.text)

        t1 = threading.Thread(target=run, args=(ka, kb, "x"))
        t2 = threading.Thread(target=run, args=(kb, ka, "y"))
        t0 = time.time()
        t1.start(); t2.start(); t1.join(60); t2.join(60)
        elapsed = time.time() - t0
        events = ctl.request("EVENTS 0 2000").json()
        plans = [re.search(r"lock order=\[(\d+),(\d+)\]", e["msg"]) for e in events if e["msg"].startswith("PLAN")]
        orders = [(int(m.group(1)), int(m.group(2))) for m in plans if m]
        ascending = bool(orders) and all(x < y for x, y in orders)
        # control experiment: same traffic with ordering OFF -> circular wait is detected
        ctl.request("LOCKORDER off")
        ctl.request("LOCKHOLD 60000")
        res = []

        def ctl_run(first, second):
            with s.conn() as c:
                res.append(c.request(f"MSET {first} 1 {second} 2"))

        c1 = threading.Thread(target=ctl_run, args=(ka, kb)); c2 = threading.Thread(target=ctl_run, args=(kb, ka))
        c1.start(); c2.start(); c1.join(30); c2.join(30)
        deadlocks = sum(1 for r in res if "deadlock" in r.text)
        ctl.request("LOCKORDER on"); ctl.request("LOCKHOLD 0")
        ctl.close()
        return {"input": f"Two clients concurrently: MSET {ka} {kb} (blocks {block_of(ka)},{block_of(kb)}) and MSET {kb} {ka}, 60 rounds, 2ms lock hold",
                "expected": "all 120 MSETs complete; lock order always ascending (no circular wait)",
                "actual": f"{done[0]}/120 completed in {elapsed:.2f}s, failures={len(fails)}; logged lock orders ascending={ascending} (e.g. {orders[:2]}); "
                          f"control run with ordering OFF: {deadlocks} of 2 requests hit a detected deadlock",
                "passed": done[0] == 120 and not fails and ascending}


def tc09(ctx):
    """Persistence: SET 100 keys, stop, restart, GET all."""
    d = ctx.tmp()
    s = TestServer(ctx.port(), d).start()
    c = s.conn()
    for i in range(100):
        assert c.request(f"SET persist:{i} value-{i}").ok
    c.close()
    s.stop(graceful=True)
    s2 = TestServer(s.port, d).start()
    c = s2.conn()
    wrong = []
    for i in range(100):
        r = c.request(f"GET persist:{i}")
        if r.lines[0] != f"VALUE value-{i}":
            wrong.append(i)
    c.close()
    s2.stop()
    return {"input": "SET 100 keys, graceful SHUTDOWN (dirty frames flushed), restart on the same data.db, GET each key",
            "expected": "all 100 keys returned with correct values", "actual": f"{100 - len(wrong)}/100 correct" + (f"; wrong: {wrong[:10]}" if wrong else ""),
            "passed": not wrong}


def tc10(ctx):
    """Non-functional target: >= 100 concurrent clients without errors."""
    if not os.path.exists(BENCH_BIN):
        return {"input": "kvbench -c 100", "expected": "100 concurrent clients", "actual": "kvbench binary missing (run make)", "passed": False}
    with TestServer(ctx.port(), ctx.tmp(), workers=8) as s:
        out = subprocess.run([BENCH_BIN, "-p", str(s.port), "-c", "100", "-n", "5000", "-o", "MIXED"], capture_output=True, text=True, timeout=120)
        r = json.loads(out.stdout)
        with s.conn() as c:
            peak = c.request("STATSJSON").json()["clients"]["peak"]
        return {"input": "kvbench: 100 simultaneous TCP clients, 5000 mixed requests",
                "expected": "100 connected clients, 0 failed requests, no lost requests, server-side peak connections >= 100",
                "actual": f"connected={r['connected']}, requests={r['total_requests']}, failed={r['failed']}, server peak connections={peak}, {r['requests_per_sec']:.0f} req/s",
                "passed": r["connected"] == 100 and r["failed"] == 0 and r["total_requests"] == 5000 and peak >= 100}


TESTS = [
    ("TC-01", "CPU Scheduling", "Priority dispatch", tc01),
    ("TC-02", "CPU Scheduling", "Round Robin with quantum = 4", tc02),
    ("TC-03", "Disk Scheduling", "SCAN vs C-SCAN seek distance", tc03),
    ("TC-04", "Disk Scheduling", "SSTF picks nearest block", tc04),
    ("TC-05", "Buffer Pool", "LRU replacement", tc05),
    ("TC-06", "Buffer Pool", "Cache hit and dirty write-back", tc06),
    ("TC-07", "Synchronization", "Readers-writers consistency", tc07),
    ("TC-08", "Synchronization", "Deadlock-free multi-key MSET", tc08),
    ("TC-09", "Persistence", "Restart recovery", tc09),
    ("TC-10", "Performance", "100 concurrent clients", tc10),
]


class Ctx:
    def __init__(self):
        self.base = tempfile.mkdtemp(prefix="kvtests_")
        self._port = 7300
        self._n = 0

    def port(self):
        self._port += 1
        return self._port

    def tmp(self):
        self._n += 1
        d = os.path.join(self.base, f"t{self._n}")
        os.makedirs(d)
        return d

    def cleanup(self):
        shutil.rmtree(self.base, ignore_errors=True)


def run_all(on_result=None, only=None):
    """Run the suite; calls on_result(result_dict) after each test. Returns the list of results."""
    results = []
    ctx = Ctx()
    try:
        for tid, module, name, fn in TESTS:
            if only and tid not in only:
                continue
            base = {"id": tid, "module": module, "name": name}
            if on_result:
                on_result({**base, "status": "RUNNING"})
            t0 = time.time()
            try:
                r = fn(ctx)
                res = {**base, **r, "status": "PASS" if r["passed"] else "FAIL"}
            except Exception as e:  # a crash is a failure, with the reason shown
                res = {**base, "status": "FAIL", "input": "", "expected": "", "actual": f"exception: {type(e).__name__}: {e}", "details": []}
            res["duration_ms"] = int((time.time() - t0) * 1000)
            res.setdefault("details", [])
            res.pop("passed", None)
            results.append(res)
            if on_result:
                on_result(res)
    finally:
        ctx.cleanup()
    return results
