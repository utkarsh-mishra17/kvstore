import { useState } from 'react'
import { Lock, Play, ShieldCheck, ShieldAlert, Users, Workflow, ArrowRight } from 'lucide-react'
import { Badge, Btn, Card, Empty, Field, Note, NumIn, Seg, Stat, useAction, hex } from '../components/ui'
import { Gantt } from '../components/Gantt'
import { api } from '../lib/api'
import { useApp } from '../lib/store'
import { OP_COLORS, n0 } from '../lib/fmt'

export default function SyncPage() {
  const { live } = useApp()
  const s = live.stats
  if (!s) return <Empty text="Waiting for server data" />
  const q = live.snapshot?.queue || []
  const cap = s.queue.capacity
  const locks: Record<number, any> = {}
  ;(live.snapshot?.locks || []).forEach((l: any) => (locks[l.block] = l))
  const lockEvents = live.events.filter(e => e.type === 'LOCK').slice(-14).reverse()
  const nb = s.server.num_blocks

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
        <Stat accent="sync" label="Producers (clients)" value={s.clients.active} sub={`${s.queue.blocked_producers} blocked on full queue`} icon={<Users size={15} />} />
        <Stat accent="sync" label="Queue size / capacity" value={`${s.queue.size} / ${cap}`} sub={`max ${s.queue.max_depth}`} />
        <Stat accent="sync" label="Consumers busy" value={`${s.workers.busy} / ${s.workers.count}`} sub="worker threads" icon={<Workflow size={15} />} />
        <Stat accent="sync" label="Concurrent readers" value={s.sync.active_readers} sub={`${n0(s.sync.read_acquisitions)} read locks taken`} />
        <Stat accent="sync" label="Active writers" value={s.sync.active_writers} sub={`${n0(s.sync.write_acquisitions)} write locks taken`} />
        <Stat accent="sync" label="Lock contention" value={n0(s.sync.contended_acquisitions)} sub={`${s.sync.deadlocks_detected} deadlocks detected`} icon={<Lock size={15} />} />
      </div>

      <Card title="Bounded producer–consumer queue (semaphores)" icon={<Workflow size={16} />} accent="sync" action={<Badge tone="sync">{s.queue.paused ? 'dispatch paused' : 'running'}</Badge>}>
        <div className="flex items-stretch gap-3 overflow-x-auto">
          <div className="rounded-lg border border-line p-3 min-w-[120px]"><div className="text-[11px] text-mute">Producers</div><div className="num text-xl font-semibold">{s.clients.active}</div><div className="text-[11px] text-mute">client threads call <b>P(slots)</b></div></div>
          <ArrowRight className="self-center text-mute shrink-0" />
          <div className="flex-1 min-w-[320px] rounded-lg border border-sync/40 bg-sync/5 p-3">
            <div className="flex justify-between text-[11px] text-mute mb-2"><span>semaphore <b>items</b> = {s.queue.size} · <b>slots</b> = {cap - s.queue.size} free</span><span>mutex protects the list</span></div>
            <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${Math.min(cap, 32)}, minmax(0,1fr))` }}>
              {Array.from({ length: Math.min(cap, 64) }, (_, i) => { const r = q[i]; return <div key={i} title={r ? `#${r.id} ${r.op}` : 'free slot'} className="h-5 rounded-sm border border-line" style={r ? { background: OP_COLORS[r.op], borderColor: OP_COLORS[r.op] } : {}} /> })}
            </div>
            {cap > 64 && <div className="text-[10px] text-mute mt-1">first 64 of {cap} slots shown</div>}
          </div>
          <ArrowRight className="self-center text-mute shrink-0" />
          <div className="rounded-lg border border-line p-3 min-w-[170px]"><div className="text-[11px] text-mute mb-1">Consumers (<b>P(items)</b>)</div>
            <div className="flex flex-wrap gap-1.5">{(live.snapshot?.workers || []).map((w: any) => <span key={w.id} className={`num text-[11px] rounded px-1.5 py-0.5 border ${w.req ? 'border-cpu/60 bg-cpu/15' : 'border-line text-mute'}`}>W{w.id}{w.req ? ' #' + w.req : ''}</span>)}</div></div>
        </div>
        <p className="text-[11px] text-mute mt-2">Live from the server: each square is a queue slot coloured by operation. When all {cap} slots fill, new producers block on the <b>slots</b> semaphore (counted above).</p>
      </Card>

      <div className="grid lg:grid-cols-3 gap-4">
        <Card title="Per-block readers–writers locks" icon={<Lock size={16} />} accent="sync" className="lg:col-span-2">
          <div className="grid gap-[3px]" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(18px, 1fr))' }}>
            {Array.from({ length: nb }, (_, b) => { const l = locks[b]; return <div key={b} title={l ? `block ${b}: ${l.readers} reader(s), ${l.writers} writer(s)` : `block ${b}`} className="aspect-square rounded-[3px] border border-line/60"
              style={l ? { background: l.writers ? hex.sync : hex.disk, borderColor: 'transparent' } : {}} /> })}
          </div>
          <div className="flex gap-4 text-[11px] text-mute mt-2"><span><i className="inline-block h-2 w-2 rounded-sm bg-disk mr-1" />read-locked</span><span><i className="inline-block h-2 w-2 rounded-sm bg-sync mr-1" />write-locked (exclusive)</span><span>{Object.keys(locks).length} of {nb} blocks locked right now</span></div>
        </Card>
        <Card title="Lock events (live)" icon={<Lock size={16} />} accent="sync">
          {lockEvents.length === 0 ? <Empty text="No lock activity" /> : <div className="space-y-1 max-h-48 overflow-auto">{lockEvents.map(e => <div key={e.id} className="text-[11px] num"><span className="text-mute">{e.time.slice(14, 23)}</span> {e.msg}</div>)}</div>}
        </Card>
      </div>
      <div className="grid lg:grid-cols-2 gap-4"><RWDemo /><DeadlockDemo /></div>
    </div>
  )
}

function lanesFrom(events: any[], order: string[]) {
  const t0 = Math.min(...events.map(e => e.t_us))
  return order.map(who => {
    const ev = events.filter(e => e.who === who)
    const a = ev.find(e => e.action === 'ACQUIRE'), r = ev.find(e => e.action === 'RELEASE')
    return { label: who, segs: a ? [{ start: (a.t_us - t0) / 1000, end: ((r ? r.t_us : a.t_us + 1000) - t0) / 1000, label: a.mode === 'READ' ? 'R' : 'W', color: a.mode === 'READ' ? hex.disk : hex.sync, title: `${who} holds ${a.mode} lock` }] : [] }
  })
}

function RWDemo() {
  const { toast } = useApp()
  const { busy, run } = useAction(toast)
  const [readers, setReaders] = useState(4)
  const [writers, setWriters] = useState(2)
  const [hold, setHold] = useState(40)
  const [res, setRes] = useState<any>(null)
  return (
    <Card title="Readers–writers demonstration" icon={<Users size={16} />} accent="sync">
      <p className="text-sm text-mute mb-3">Readers and writers hit one key (one block lock) at the same instant, each holding the lock for {hold} ms. Bars are real lock hold intervals taken from the server's lock events.</p>
      <div className="flex flex-wrap gap-3 items-end"><Field label="Readers"><NumIn className="w-20" value={readers} onChange={setReaders} min={1} max={8} /></Field><Field label="Writers"><NumIn className="w-20" value={writers} onChange={setWriters} min={1} max={4} /></Field><Field label="Hold (ms)"><NumIn className="w-20" value={hold} onChange={setHold} min={1} max={300} /></Field>
        <Btn busy={busy} icon={<Play size={14} />} onClick={() => run(async () => setRes(await api('/demo/readwrite', { readers, writers, hold_ms: hold })))}>Run on server</Btn></div>
      {res && res.events.length > 0 && <div className="mt-4"><Gantt unit=" ms" lanes={lanesFrom(res.events, Object.keys(res.clients).sort())} />
        <p className="text-[11px] text-mute mt-1">Teal = read lock, coral = write lock on block {res.block}. Readers overlap each other; each writer runs alone.</p></div>}
    </Card>
  )
}

function DeadlockDemo() {
  const { toast } = useApp()
  const { busy, run } = useAction(toast)
  const [hold, setHold] = useState(30)
  const [res, setRes] = useState<any>(null)
  const [mode, setMode] = useState<'on' | 'off'>('on')
  const go = () => run(async () => setRes(await api('/demo/deadlock', { ordered: mode === 'on', hold_ms: hold })), 'MSET demo finished')
  const lanes = res ? ['client1', 'client2'].map(c => ({ label: c, segs: res.events.filter((e: any) => e.msg.includes('ACQUIRE') && res.clients[c] && e.msg.includes(`req=${res.clients[c].meta.id} `)).map((e: any, i: number, arr: any[]) => {
    const t0 = Math.min(...res.events.map((x: any) => x.t_us)); const rel = res.events.find((x: any) => x.msg.includes('RELEASE') && x.msg.includes(`req=${res.clients[c].meta.id} `) && x.msg.includes(e.msg.match(/block=\d+/)[0] + '')) 
    return { start: (e.t_us - t0) / 1000, end: ((rel ? rel.t_us : e.t_us + 2000) - t0) / 1000, label: 'B' + e.msg.match(/block=(\d+)/)[1], color: i === 0 ? hex.cpu : hex.mem, title: e.msg } }) })) : []
  return (
    <Card title="Deadlock-free multi-key MSET" icon={res && res.ordered === false ? <ShieldAlert size={16} /> : <ShieldCheck size={16} />} accent="sync">
      <p className="text-sm text-mute mb-3">Client 1 sends <code className="num">MSET A … B …</code> while Client 2 sends <code className="num">MSET B … A …</code> simultaneously. With ascending block-order locking circular wait cannot form. Switch ordering off to watch the server detect the deadlock.</p>
      <div className="flex flex-wrap gap-3 items-end"><Field label="Lock ordering"><Seg accent="sync" value={mode} onChange={setMode} options={[{ v: 'on', label: 'Ascending (safe)' }, { v: 'off', label: 'Command order (unsafe)' }]} /></Field><Field label="Hold between locks (ms)"><NumIn className="w-20" value={hold} onChange={setHold} min={0} max={500} /></Field><Btn busy={busy} icon={<Play size={14} />} onClick={go}>Run both clients</Btn></div>
      {res && (
        <div className="mt-4 space-y-3">
          <div className="flex gap-2 flex-wrap text-xs"><Badge tone="sync">A = {res.keys.A} (block {res.blocks.A})</Badge><Badge tone="sync">B = {res.keys.B} (block {res.blocks.B})</Badge><Badge>{res.elapsed_ms} ms</Badge><Badge tone={res.ordered ? 'good' : 'bad'}>{res.ordered ? 'ordered locking' : 'unordered locking'}</Badge></div>
          <div className="overflow-x-auto"><table><thead><tr><th>Client</th><th>Result</th><th>Lock order used</th></tr></thead><tbody>
            {Object.entries(res.clients).map(([k, v]: any) => <tr key={k}><td className="font-semibold">{k}</td><td><Badge tone={v.response.startsWith('OK') ? 'good' : 'bad'}>{v.response}</Badge></td><td className="num">{v.meta.locks === '-' ? 'released after abort' : v.meta.locks}</td></tr>)}</tbody></table></div>
          {res.events.length > 0 && <Gantt unit=" ms" lanes={lanes} />}
          <div className="max-h-40 overflow-auto rounded-lg bg-raised/60 p-2 space-y-0.5">{res.events.map((e: any, i: number) => <div key={i} className={`text-[11px] num ${e.type === 'ERROR' ? 'text-bad' : ''}`}>{e.msg}</div>)}</div>
          <Note tone="sync">{res.ordered ? 'Both clients acquired the lower-numbered block first, so one simply waited for the other: no circular wait, both completed.' : 'Each client held one block and waited for the other: a circular wait. The server detected it by timeout and aborted one request so the other could finish.'}</Note>
        </div>)}
    </Card>
  )
}
