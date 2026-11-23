import { useState } from 'react'
import { motion } from 'framer-motion'
import { ChevronDown } from 'lucide-react'
import { Badge, Card, accentText } from '../components/ui'
import { useApp } from '../lib/store'
import { n0, pct, policyLabel } from '../lib/fmt'

const MODULES = [
  { id: 'client', name: 'Client layer', accent: 'net', tech: 'kvcli, kvbench, this dashboard (via FastAPI)', files: 'client/kvcli.cpp · client/kvbench.cpp', os: 'Client–server model', purpose: 'Many users connect over TCP and send text commands: SET, GET, DEL, LIST, MSET, STATS. Each connection is served by its own handler thread.' },
  { id: 'net', name: 'Network handler', accent: 'net', tech: 'POSIX TCP sockets, one pthread per client', files: 'server/src/server.cpp', os: 'Sockets, threads', purpose: 'Accepts connections, parses and validates the text protocol, turns data commands into Request objects (producers) and sends each response back with execution metadata.' },
  { id: 'queue', name: 'Bounded request queue', accent: 'sync', tech: 'POSIX semaphores (slots/items) + mutex', files: 'server/src/request_queue.hpp', os: 'Producer–consumer, semaphores', purpose: 'Classic bounded buffer: producers wait on the "slots" semaphore when full, consumers wait on "items" when empty, a mutex protects the list itself.' },
  { id: 'cpu', name: 'CPU scheduler', accent: 'cpu', tech: 'FCFS · SJF · Priority · Round Robin', files: 'server/src/cpu_scheduler.hpp', os: 'CPU scheduling', purpose: 'Chooses which queued request a free worker takes next. Policy and quantum change at runtime. Under Round Robin a long LIST scan is cut into slices and re-queued. Waiting and turnaround times are recorded per request.' },
  { id: 'workers', name: 'Worker thread pool', accent: 'cpu', tech: 'std::thread pool, pthread_rwlock per block', files: 'server/src/server.cpp · sync.hpp', os: 'Threads, readers–writers, deadlock prevention', purpose: 'Executes requests. Takes per-block readers–writers locks; MSET acquires all its block locks in ascending block order so circular wait is impossible.' },
  { id: 'pool', name: 'Buffer pool', accent: 'mem', tech: 'Fixed frames · FIFO / LRU / Clock · dirty write-back', files: 'server/src/buffer_pool.hpp', os: 'Memory management, page replacement', purpose: 'Caches 4 KB blocks in a fixed number of frames. A hit avoids disk I/O; a miss evicts a victim (writing it back if dirty) and loads the block.' },
  { id: 'disk', name: 'Disk scheduler', accent: 'disk', tech: 'FCFS · SSTF · SCAN · C-SCAN · LOOK · C-LOOK', files: 'server/src/disk_scheduler.hpp', os: 'Disk scheduling', purpose: 'A dedicated disk thread collects pending block reads and write-backs, orders them by the chosen algorithm, tracks the head position and accumulates total seek distance.' },
  { id: 'storage', name: 'Storage engine (data.db)', accent: 'sync', tech: 'Block file, pread/pwrite, FNV-1a key→block hash', files: 'server/src/storage.hpp', os: 'File systems, persistence', purpose: '200 blocks of 4 KB. A key hashes to exactly one block; records are stored inside it. Dirty frames are flushed on eviction and on graceful shutdown, so data survives restarts.' },
]
const STEPS = ['Client sends a command', 'Network handler parses it and builds a request', 'Request enters the bounded queue (semaphores)', 'CPU scheduler selects the next request', 'Worker acquires the block lock(s) in ascending order', 'Buffer pool checks the block (hit or miss + page replacement)', 'On a miss or write-back the disk scheduler orders the I/O', 'Storage engine reads or writes data.db', 'Locks are released and the response returns to the client', 'Statistics and logs are updated']

export default function ArchitecturePage() {
  const { live } = useApp()
  const s = live.stats
  const [sel, setSel] = useState('queue')
  const m = MODULES.find(x => x.id === sel)!
  const live1: Record<string, string> = !s ? {} : {
    client: `${s.clients.active} connected · peak ${s.clients.peak}`, net: `${n0(s.requests.total)} requests parsed`, queue: `${s.queue.size}/${s.queue.capacity} queued · max ${s.queue.max_depth}`,
    cpu: `${policyLabel[s.cpu.policy]} · ${n0(s.cpu.dispatched)} dispatched`, workers: `${s.workers.busy}/${s.workers.count} busy`, pool: `${pct(s.buffer_pool.hit_ratio)} hit · ${s.buffer_pool.policy}`,
    disk: `${s.disk.algorithm} · seek ${n0(s.disk.total_seek)}`, storage: `${n0(s.disk.reads)} reads · ${n0(s.disk.writes)} writes`,
  }
  return (
    <div className="grid lg:grid-cols-5 gap-5">
      <Card title="Request flow (click a module)" className="lg:col-span-2">
        <div className="flex flex-col items-stretch">
          {MODULES.map((x, i) => (
            <div key={x.id} className="flex flex-col items-center">
              <button onClick={() => setSel(x.id)} className={`w-full text-left rounded-xl border px-4 py-2.5 transition ${sel === x.id ? 'border-net bg-raised' : 'border-line hover:bg-raised/60'}`}>
                <div className="flex justify-between items-center"><span className={`font-bold text-sm ${accentText[x.accent]}`}>{x.name}</span><span className="text-[11px] text-mute num">{live1[x.id]}</span></div>
                <div className="text-[11px] text-mute">{x.tech}</div>
              </button>
              {i < MODULES.length - 1 && (
                <svg width="20" height="28" viewBox="0 0 20 28"><line x1="10" y1="2" x2="10" y2="20" stroke="rgb(var(--mute))" strokeWidth="2" className="flow-line" /><path d="M5 17l5 7 5-7" fill="none" stroke="rgb(var(--mute))" strokeWidth="2" /></svg>)}
            </div>))}
        </div>
      </Card>
      <div className="lg:col-span-3 space-y-5">
        <motion.div key={m.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
          <Card title={m.name} accent={m.accent} action={<Badge tone={m.accent}>{m.os}</Badge>}>
            <div className="space-y-3 text-sm">
              <p className="leading-relaxed">{m.purpose}</p>
              <div className="grid sm:grid-cols-2 gap-3"><div className="rounded-lg bg-raised/70 p-3"><div className="text-xs text-mute">Implementation</div><div className="font-semibold">{m.tech}</div></div><div className="rounded-lg bg-raised/70 p-3"><div className="text-xs text-mute">Source</div><div className="num font-semibold text-[13px]">{m.files}</div></div></div>
              {live1[m.id] && <div className="rounded-lg border border-line p-3"><div className="text-xs text-mute">Live right now</div><div className="num font-semibold">{live1[m.id]}</div></div>}
            </div>
          </Card>
        </motion.div>
        <Card title="Request lifecycle">
          <ol className="space-y-1">{STEPS.map((t, i) => (<li key={i} className="flex items-start gap-3"><span className="num grid place-items-center h-6 w-6 shrink-0 rounded-full bg-raised text-xs font-bold">{i + 1}</span><span className="text-sm pt-0.5">{t}</span>{i < STEPS.length - 1 && <ChevronDown size={0} />}</li>))}</ol>
        </Card>
        <Card title="Dashboard integration">
          <div className="text-sm text-mute leading-relaxed">React UI ⇄ FastAPI (REST + WebSocket, one tick per second) ⇄ <b className="text-ink">TCP text protocol</b> ⇄ C++ KVStore server. The API layer holds no data of its own: every figure is read from the server with <code className="num">STATSJSON</code>, <code className="num">SNAPSHOT</code>, <code className="num">POOL</code>, <code className="num">EVENTS</code>, <code className="num">REQS</code>, <code className="num">GANTT</code> and <code className="num">DISKLOG</code>.</div>
        </Card>
      </div>
    </div>
  )
}
