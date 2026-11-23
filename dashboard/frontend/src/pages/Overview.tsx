import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend } from 'recharts'
import { Activity, Clock, Cpu, Database, GaugeCircle, HardDrive, Layers, ListOrdered, MemoryStick, Network, Percent, Users, Zap } from 'lucide-react'
import { Card, Empty, Stat, Badge, hex } from '../components/ui'
import { Pipeline } from '../components/Pipeline'
import { useLive } from '../lib/store'
import { n0, n1, pct, us, OP_COLORS, policyLabel } from '../lib/fmt'

const typeTone: Record<string, string> = { ERROR: 'bad', CLIENT: 'net', SERVER: 'good', CONFIG: 'cpu', SCHED: 'cpu', DISK: 'disk', CACHE: 'mem', PAGE: 'mem', LOCK: 'sync', QUEUE: 'net', REQUEST: 'net', WORKER: 'cpu' }
const tt = { contentStyle: { background: 'rgb(var(--panel))', border: '1px solid rgb(var(--line))', borderRadius: 8, fontSize: 12 } }
const grid = <CartesianGrid stroke="rgb(var(--line))" strokeDasharray="3 3" vertical={false} />
const tick = (t: number) => new Date(t).toLocaleTimeString([], { minute: '2-digit', second: '2-digit' })

export default function Overview({ go }: { go: (p: string) => void }) {
  const live = useLive()
  const s = live.stats
  if (!s) return <Empty text={live.ready ? 'No data from the server yet' : 'Loading…'} hint="Once the C++ server is reachable, live metrics appear here." />
  const h = live.history.slice(-120)
  const rps = h.length ? h[h.length - 1].rps : 0
  const pp = Object.entries(s.cpu.per_policy as Record<string, any>).map(([k, v]: any) => ({ name: policyLabel[k], wait: Math.round(v.avg_wait_us), tat: Math.round(v.avg_turnaround_us), n: v.n }))
  const ops = Object.entries(s.requests.by_op as Record<string, number>).map(([k, v]) => ({ name: k, value: v }))
  const disk = live.disklog.slice(-60).map((d, i) => ({ i, block: d.block }))
  const frames = (live.pool?.frames || []).map((f: any) => ({ name: 'F' + f.index, v: f.block < 0 ? 0 : f.dirty ? 2 : 1 }))
  const hm = [{ name: 'Hits', value: s.buffer_pool.hits }, { name: 'Misses', value: s.buffer_pool.misses }]
  const feed = live.events.filter(e => !['LOCK', 'CACHE', 'DISK', 'WORKER', 'QUEUE', 'REQUEST'].includes(e.type) || e.msg.startsWith('DONE') === false).slice(-14).reverse()
  const activity = live.events.slice(-12).reverse()

  return (
    <div className="space-y-5">
      <Card title="Request path, live" icon={<Network size={16} />} accent="net" action={<Badge tone="good">{n0(rps)} req/s</Badge>}>
        <Pipeline active={rps > 0} stages={[
          { name: 'Clients', accent: 'net', value: s.clients.active, sub: `peak ${s.clients.peak}` },
          { name: 'Request queue', accent: 'net', value: `${s.queue.size}/${s.queue.capacity}`, sub: `${s.queue.blocked_producers} producers blocked` },
          { name: 'CPU scheduler', accent: 'cpu', value: s.cpu.policy === 'PRIORITY' ? 'PRIO' : s.cpu.policy, sub: s.cpu.policy === 'RR' ? `quantum ${s.cpu.quantum}` : `${n0(s.cpu.dispatched)} dispatched` },
          { name: 'Worker pool', accent: 'cpu', value: `${s.workers.busy}/${s.workers.count}`, sub: 'busy workers' },
          { name: 'Buffer pool', accent: 'mem', value: pct(s.buffer_pool.hit_ratio), sub: `${s.buffer_pool.occupied}/${s.buffer_pool.frames} frames · ${s.buffer_pool.policy}` },
          { name: 'Disk scheduler', accent: 'disk', value: s.disk.algorithm, sub: `head @ ${s.disk.head} · ${s.disk.pending_count} pending` },
          { name: 'data.db', accent: 'sync', value: `${s.disk.reads}R / ${s.disk.writes}W`, sub: `${n0(s.disk.total_seek)} tracks travelled` },
        ]} />
      </Card>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <Stat label="Total requests" value={n0(s.requests.total)} sub={`${n0(s.requests.errors)} errors`} icon={<Database size={15} />} />
        <Stat label="Active connections" value={s.clients.active} sub={`${n0(s.clients.total_connections)} total`} icon={<Users size={15} />} />
        <Stat label="Requests / second" value={n0(rps)} sub="completed, last second" accent="good" icon={<Zap size={15} />} />
        <Stat label="Avg response time" value={us(s.cpu.avg_turnaround_us)} sub={`wait ${us(s.cpu.avg_wait_us)} · service ${us(s.cpu.avg_service_us)}`} accent="cpu" icon={<Clock size={15} />} />
        <Stat label="Request queue" value={`${s.queue.size} / ${s.queue.capacity}`} sub={`max depth ${s.queue.max_depth}`} icon={<ListOrdered size={15} />} />
        <Stat label="CPU policy" value={policyLabel[s.cpu.policy]} sub={s.cpu.policy === 'RR' ? `quantum ${s.cpu.quantum} units · ${n0(s.cpu.preemptions)} preemptions` : 'non-preemptive'} accent="cpu" icon={<Cpu size={15} />} />
        <Stat label="Total disk seek" value={n0(s.disk.total_seek)} sub={`${s.disk.algorithm} · avg ${n1(s.disk.avg_seek)}/IO`} accent="disk" icon={<HardDrive size={15} />} />
        <Stat label="Cache hit ratio" value={pct(s.buffer_pool.hit_ratio)} sub={s.buffer_pool.policy + ' replacement'} accent="mem" icon={<Percent size={15} />} />
        <Stat label="Cache hits / misses" value={<span>{n0(s.buffer_pool.hits)}<span className="text-mute text-lg"> / </span>{n0(s.buffer_pool.misses)}</span>} sub={`${s.buffer_pool.dirty} dirty · ${s.buffer_pool.writebacks} write-backs`} accent="mem" icon={<MemoryStick size={15} />} />
        <Stat label="Active worker threads" value={`${s.workers.busy} / ${s.workers.count}`} sub={`${s.sync.active_readers}R ${s.sync.active_writers}W lock holders`} accent="sync" icon={<Layers size={15} />} />
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        <Card title="Requests per second" icon={<Activity size={16} />} className="lg:col-span-2">
          <div className="h-60"><ResponsiveContainer><AreaChart data={h}>{grid}
            <defs><linearGradient id="g1" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={hex.net} stopOpacity={0.5} /><stop offset="100%" stopColor={hex.net} stopOpacity={0} /></linearGradient></defs>
            <XAxis dataKey="t" tickFormatter={tick} minTickGap={40} /><YAxis width={42} /><Tooltip {...tt} labelFormatter={tick} />
            <Area type="monotone" dataKey="rps" name="req/s" stroke={hex.net} fill="url(#g1)" strokeWidth={2} isAnimationActive={false} /></AreaChart></ResponsiveContainer></div>
        </Card>
        <Card title="Request mix" icon={<Database size={16} />}>
          <div className="h-60"><ResponsiveContainer><BarChart data={ops} layout="vertical">{grid}
            <XAxis type="number" /><YAxis type="category" dataKey="name" width={44} /><Tooltip {...tt} cursor={{ fill: 'rgb(var(--raised))' }} />
            <Bar dataKey="value" name="requests" radius={4} isAnimationActive={false}>{ops.map(o => <Cell key={o.name} fill={OP_COLORS[o.name]} />)}</Bar></BarChart></ResponsiveContainer></div>
        </Card>
        <Card title="Waiting vs turnaround by CPU policy" icon={<Cpu size={16} />} accent="cpu">
          <div className="h-60"><ResponsiveContainer><BarChart data={pp}>{grid}<XAxis dataKey="name" /><YAxis width={48} /><Tooltip {...tt} cursor={{ fill: 'rgb(var(--raised))' }} /><Legend />
            <Bar dataKey="wait" name="avg wait (µs)" fill={hex.cpu} radius={3} isAnimationActive={false} /><Bar dataKey="tat" name="avg turnaround (µs)" fill={hex.net} radius={3} isAnimationActive={false} /></BarChart></ResponsiveContainer></div>
          <p className="text-[11px] text-mute mt-1">Measured per policy over live traffic. Switch policies and run load to fill each bar.</p>
        </Card>
        <Card title="Disk head position (last I/Os)" icon={<HardDrive size={16} />} accent="disk">
          <div className="h-60">{disk.length ? <ResponsiveContainer><LineChart data={disk}>{grid}<XAxis dataKey="i" hide /><YAxis domain={[0, 199]} width={36} /><Tooltip {...tt} />
            <Line type="stepAfter" dataKey="block" name="track" stroke={hex.disk} strokeWidth={2} dot={{ r: 2 }} isAnimationActive={false} /></LineChart></ResponsiveContainer> : <Empty text="No disk I/O yet" hint="Run a LIST or benchmark to see head movement." />}</div>
        </Card>
        <Card title="Cache hits vs misses" icon={<Percent size={16} />} accent="mem">
          <div className="h-60 relative"><ResponsiveContainer><PieChart><Pie data={hm} dataKey="value" innerRadius={55} outerRadius={80} paddingAngle={3} isAnimationActive={false} stroke="none">
            <Cell fill={hex.good} /><Cell fill={hex.sync} /></Pie><Tooltip {...tt} /><Legend /></PieChart></ResponsiveContainer>
            <div className="absolute inset-0 grid place-items-center pointer-events-none"><div className="text-center -mt-5"><div className="num text-2xl font-semibold">{pct(s.buffer_pool.hit_ratio)}</div><div className="text-[11px] text-mute">hit ratio</div></div></div></div>
        </Card>
        <Card title="Buffer frame utilization" icon={<MemoryStick size={16} />} accent="mem">
          <div className="grid grid-cols-4 gap-2">{(live.pool?.frames || []).map((f: any) => (
            <div key={f.index} className={`rounded-lg border px-2 py-2 text-center ${f.block < 0 ? 'border-line text-mute' : f.dirty ? 'border-sync/60 bg-sync/10' : 'border-mem/50 bg-mem/10'}`}>
              <div className="text-[10px] text-mute">F{f.index}</div><div className="num font-semibold">{f.block < 0 ? '—' : f.block}</div>{f.dirty && <div className="text-[10px] text-sync font-bold">dirty</div>}
            </div>))}</div>
          <p className="text-[11px] text-mute mt-2">{s.buffer_pool.occupied} of {s.buffer_pool.frames} frames hold a block; the number is the cached disk block.</p>
        </Card>
        <Card title="Active clients over time" icon={<Users size={16} />}>
          <div className="h-52"><ResponsiveContainer><AreaChart data={h}>{grid}<XAxis dataKey="t" tickFormatter={tick} minTickGap={40} /><YAxis width={32} allowDecimals={false} /><Tooltip {...tt} labelFormatter={tick} />
            <Area type="stepAfter" dataKey="active" name="clients" stroke={hex.good} fill={hex.good} fillOpacity={0.15} strokeWidth={2} isAnimationActive={false} /></AreaChart></ResponsiveContainer></div>
        </Card>
        <Card title="Live activity" icon={<Activity size={16} />} className="lg:col-span-2" action={<button className="text-xs text-net font-semibold" onClick={() => go('logs')}>Open logs</button>}>
          {activity.length === 0 ? <Empty text="No events yet" /> : (
            <div className="space-y-1 max-h-52 overflow-auto">{activity.map(e => (
              <div key={e.id} className="flex items-center gap-2 text-xs">
                <span className="num text-mute w-16 shrink-0">{e.time.slice(11, 19)}</span><span className="w-[76px] shrink-0"><Badge tone={typeTone[e.type] || 'mute'}>{e.type}</Badge></span><span className="truncate">{e.msg}</span>
              </div>))}</div>)}
        </Card>
      </div>
    </div>
  )
}
