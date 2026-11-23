# KVStore – A Multi-user Key-Value Storage Server

Jaypee Institute of Information Technology, Noida · Dept. of CSE & IT · Operating Systems project 2026-27
Roushan Kumar Sharma · Utkarsh Mishra · Shashwat Mishra · Ashutosh Kumar — Batch F14 — Submitted to Dr. Anubhuti Mohindra

KVStore is a C++17 TCP key-value server in which four Operating System subsystems each do real work:
**CPU scheduling** orders client requests, **disk scheduling** orders block I/O on a persistent file,
**memory management** runs a buffer pool with page replacement, and **synchronization** protects the shared queue,
blocks and cache frames. A React dashboard lets you watch and drive all of it live.

## 1. Architecture

```
Client layer (kvcli · kvbench · dashboard)          React UI  ⇄  FastAPI (REST + WebSocket)
        │ TCP text protocol                                           │ TCP text protocol
        ▼                                                             ▼
Network handler (1 pthread per client, parses/validates)   ◄── same C++ server ──►
        ▼
Bounded request queue   (POSIX semaphores slots/items + mutex)
        ▼
CPU scheduler           (FCFS · SJF · Priority · Round Robin, runtime selectable)
        ▼
Worker thread pool      (per-block pthread_rwlock · ascending-order locking for MSET)
        ▼
Buffer pool             (fixed frames · FIFO · LRU · Clock · dirty write-back)
        ▼  miss / write-back
Disk scheduler          (FCFS · SSTF · SCAN · C-SCAN · LOOK · C-LOOK, own thread)
        ▼
Storage engine          (data.db: 200 blocks × 4 KB, key → block by FNV-1a hash)
```

```
kvstore/
├── Makefile · start.sh · README.md
├── server/src/   common.hpp  event_log.hpp  request.hpp  request_queue.hpp  cpu_scheduler.hpp
│                 sync.hpp  storage.hpp  disk_scheduler.hpp  buffer_pool.hpp  server.hpp/.cpp  main.cpp
├── client/       client_lib.hpp  kvcli.cpp  kvbench.cpp
├── tests/        run_tests.py            (CLI runner; the suite itself is dashboard/backend/tests_runner.py)
└── dashboard/    backend/ (FastAPI)   frontend/ (React + TS + Vite + Tailwind + Recharts + Framer Motion)
```

Algorithms are shared between the live server and the demonstrations: `pick_index()` (CPU), `HeadScheduler`
(disk) and `choose_victim()` (page replacement) are the same functions used for real requests and for the
simulators, so dashboard demonstrations are produced by the real code, not re-implemented in JavaScript.

## 2. Features

* Commands: `SET GET DEL LIST MSET STATS` (+ `STATSJSON`, `POLICY`, `DISK`, `CACHE`, `SETFRAMES`, `PAUSE/RESUME`, `FLUSH`, `SHUTDOWN`, `HELP` …). Optional prefix `@prio=1..9` (1 Normal, 2 High, 3 Admin).
* Every response ends with `END key=value …` metadata: request id, worker, dispatch order, wait / service / turnaround µs, slices, cache hits/misses, block locks taken.
* Persistence: dirty frames are written back on eviction and on graceful shutdown (`SIGINT`, `SIGTERM`, `SHUTDOWN`). A `kill -9` can lose frames not yet written (inherent to write-back caching).
* Round Robin time-slices long `LIST` scans (quantum = blocks per slice); `MSET` is not preempted (it must hold all its locks atomically).
* Deadlock prevention: `MSET` takes its distinct block locks in ascending block order. `LOCKORDER off` is a demonstration mode that uses lock timeouts to *detect* the circular wait.
* Dashboard (11 pages): Overview, Key-Value Explorer, CPU, Disk, Memory, Synchronization, Benchmark, Validation Tests, Logs/Stats, Architecture, Settings; dark/light themes; CSV export of logs, requests and benchmarks.
* Demo knobs (all labelled in the UI, default 0/off): `DELAY` (synthetic service time per cost unit), `IODELAY` (simulated seek latency), `DISKWINDOW` (batching window so concurrent misses queue up), `LOCKHOLD`.

Limits: keys ≤ 64 chars without spaces, values ≤ 256 chars, MSET ≤ 32 pairs. A block holds ~15+ records; if too many keys hash to one block the server answers `ERR block N is full` (no overflow chaining).

## 3. Dependencies and installation

| Need | Version |
|---|---|
| g++ (C++17), make | g++ 9+ on Linux, or Apple clang on macOS |
| Python | 3.9+ with `fastapi`, `uvicorn[standard]` |
| Node.js / npm | Node 18+ |

```bash
pip install -r dashboard/backend/requirements.txt
cd dashboard/frontend && npm install && cd ../..
```

## 4. Build, run, start

```bash
make                                   # builds build/kvserver, build/kvcli, build/kvbench
./build/kvserver --port 7070 --workers 8 --queue 64 --frames 8 \
                 --cpu fcfs --disk fcfs --cache lru --data data/data.db
python3 -m uvicorn main:app --port 8000        # run inside dashboard/backend   (FastAPI)
npm run dev                                     # run inside dashboard/frontend  → http://localhost:5173
```

One command for everything: **`./start.sh`** (dev UI on :5173) or **`./start.sh --prod`** (UI served by FastAPI on :8000).

CLI client: `./build/kvcli` (interactive) or `./build/kvcli -c "SET username Utkarsh"`; `nc localhost 7070` also works.

## 5. Using the dashboard

* **Overview** – live request path (queue → scheduler → workers → pool → disk), 10 metric cards, 7 charts, activity feed.
* **Explorer** – run SET/GET/DEL/LIST/MSET/STATS; see the raw server reply, timings, locks and cache result; search keys; seed demo data.
* **CPU Scheduling** – change policy/quantum/delay live, pause dispatch, watch the queue, worker slices (Gantt), per-request table. *Simulator*: edit jobs (name/arrival/burst/priority), run one policy or compare all four. *Live demo*: preset scenarios (TC-01 priority, SJF vs scan, RR slicing) executed on the real server.
* **Disk Scheduling** – choose the live algorithm; head-movement graph and I/O log; simulator with start head, request list, direction, animated path, step controls and a six-algorithm comparison (TC-03 preloaded).
* **Memory** – real frame table (block, dirty, ref bit, clock hand, replacement history); resize pool; page-replacement animation for any reference string (suffix `w` = write) and FIFO/LRU/Clock comparison.
* **Synchronization** – semaphore queue slots, producers/consumers, per-block lock heat-map, readers–writers demo, `MSET A B` vs `MSET B A` demo with ordering on/off.
* **Benchmark & Load** – clients / requests / duration / operation / policy; “Verify 100 concurrent clients”; “Compare CPU policies”; history and CSV.
* **Validation Tests** – runs TC-01…TC-10 and shows PASS/FAIL with input, expected and actual.
* **Logs** – filter by event type, search, auto-scroll, CSV export; full statistics report tab.

## 6. Benchmarks

```bash
./build/kvbench -c 100 -n 5000 -o MIXED                 # 100 concurrent clients
./build/kvbench -c 32 -n 3000 -o MIXLIST --prio         # mixed GET/SET plus long scans, random priorities
./build/kvbench -c 20 -d 10 -o SET                      # 10 seconds of SETs
```
`-o` = SET | GET | DEL | MSET | LIST | MIXED | MIXLIST. All connections are opened before the first request; output is JSON (RPS, avg/min/max/p50/p95/p99 latency, error rate).
The 100-client target is only reported as verified when the run really connected 100 clients with 0 failed requests.

## 7. Automated tests

```bash
make test           # or: python3 tests/run_tests.py [TC-01 TC-05 …]      (also: dashboard → Validation Tests)
```
TC-01…TC-09 are the synopsis test cases; TC-10 checks the 100-client requirement. Each test starts its own server on a private port
with a temporary data file and compares with hand-computed values (e.g. SCAN = 338, C-SCAN = 368, LRU = 6 faults, RR waits 8/4/10).
Race detection: `make tsan` builds a ThreadSanitizer binary (`build/kvserver_tsan`).

Notes: C-SCAN/C-LOOK seek totals include the return jump; SCAN/C-SCAN travel to the disk edge. Priority dispatch in TC-01 is checked with dispatch paused so all three requests are queued, because a non-preemptive scheduler starts a lone request immediately.
