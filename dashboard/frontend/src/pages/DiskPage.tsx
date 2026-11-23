import { useEffect, useMemo, useRef, useState } from 'react'
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { HardDrive, Pause, Play, RotateCcw, SkipForward, Gauge } from 'lucide-react'
import { Badge, Btn, Card, Empty, Field, Note, NumIn, Seg, Stat, hex, useAction } from '../components/ui'
import { api } from '../lib/api'
import { useApp } from '../lib/store'
import { diskAlgs, diskLabel, n0, n1 } from '../lib/fmt'

const tt = { contentStyle: { background: 'rgb(var(--panel))', border: '1px solid rgb(var(--line))', borderRadius: 8, fontSize: 12 } }
const grid = <CartesianGrid stroke="rgb(var(--line))" strokeDasharray="3 3" vertical={false} />

export default function DiskPage() {
  const { live, toast } = useApp()
  const { busy, run } = useAction(toast)
  const s = live.stats
  const [window, setWindow] = useState(0)
  const [ioDelay, setIoDelay] = useState(0)
  if (!s) return <Empty text="Waiting for server data" />
  const d = s.disk
  const log = live.disklog.slice(-80)
  const series = log.map((x, i) => ({ i, block: x.block, seek: x.seek }))

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <Stat accent="disk" label="Head position" value={d.head} sub={`tracks 0–${s.server.num_blocks - 1}`} icon={<HardDrive size={15} />} />
        <Stat accent="disk" label="Total seek distance" value={n0(d.total_seek)} sub={d.return_seek ? `incl. ${n0(d.return_seek)} return` : 'tracks travelled'} />
        <Stat accent="disk" label="Block I/O requests" value={n0(d.io_requests)} sub={`${n0(d.reads)} reads · ${n0(d.writes)} writes`} />
        <Stat accent="disk" label="Average seek / I/O" value={n1(d.avg_seek)} sub="tracks" />
        <Stat accent="disk" label="Pending now" value={d.pending_count} sub={d.pending.length ? d.pending.join(', ') : 'queue empty'} />
      </div>

      <Card title="Live disk scheduler" icon={<HardDrive size={16} />} accent="disk">
        <div className="space-y-4">
          <Seg accent="disk" value={d.algorithm.toLowerCase().replace('-', '')} onChange={a => run(() => api('/config', { disk_alg: a }), `Disk algorithm set to ${diskLabel[a]}`)} options={diskAlgs.map(a => ({ v: a, label: diskLabel[a] }))} />
          <div className="flex flex-wrap gap-4 items-end">
            <Field label="Batching window (µs)" hint="Waits this long so concurrent misses queue up and can be reordered."><NumIn value={window} onChange={setWindow} min={0} max={1000000} /></Field>
            <Btn tone="ghost" busy={busy} onClick={() => run(() => api('/config', { disk_window_us: window }), `Batching window ${window} µs`)}>Apply</Btn>
            <Field label="Simulated seek latency (µs / track)" hint="Makes the cost of long seeks visible in latency."><NumIn value={ioDelay} onChange={setIoDelay} min={0} max={10000} /></Field>
            <Btn tone="ghost" busy={busy} onClick={() => run(() => api('/config', { io_delay_us: ioDelay }), `Seek latency ${ioDelay} µs/track`)}>Apply</Btn>
          </div>
          <div className="grid lg:grid-cols-2 gap-4">
            <div className="h-56">{series.length ? <ResponsiveContainer><LineChart data={series}>{grid}<XAxis dataKey="i" hide /><YAxis domain={[0, 199]} width={36} /><Tooltip {...tt} />
              <Line type="stepAfter" dataKey="block" name="track served" stroke={hex.disk} strokeWidth={2} dot={{ r: 2.5 }} isAnimationActive={false} /></LineChart></ResponsiveContainer> : <Empty text="No block I/O yet" hint="Reads and write-backs appear here as they reach data.db." />}</div>
            <div className="max-h-56 overflow-auto"><table><thead><tr><th>#</th><th>Op</th><th>From</th><th>To</th><th>Seek</th><th>Pending</th><th>Alg</th></tr></thead><tbody>
              {[...log].reverse().slice(0, 40).map(x => <tr key={x.seq}><td className="num text-mute">{x.seq}</td><td><Badge tone={x.op === 'WRITE' ? 'sync' : 'disk'}>{x.op}</Badge></td><td className="num">{x.from}</td><td className="num font-semibold">{x.block}</td><td className="num">{x.seek}</td><td className="num">{x.pending_after}</td><td>{x.alg}</td></tr>)}</tbody></table></div>
          </div>
        </div>
      </Card>
      <Simulator />
    </div>
  )
}

function Simulator() {
  const { toast } = useApp()
  const { busy, run } = useAction(toast)
  const [alg, setAlg] = useState('scan')
  const [head, setHead] = useState(50)
  const [maxT, setMaxT] = useState(199)
  const [dir, setDir] = useState<'up' | 'down'>('up')
  const [reqText, setReqText] = useState('20, 90, 50, 10')
  const [res, setRes] = useState<any>(null)
  const [cmp, setCmp] = useState<any>(null)
  const [step, setStep] = useState(0)
  const [play, setPlay] = useState(false)
  const timer = useRef<any>(null)

  const reqs = useMemo(() => reqText.split(/[\s,]+/).filter(Boolean).map(Number), [reqText])
  const valid = reqs.length > 0 && reqs.every(n => Number.isInteger(n) && n >= 0 && n <= maxT) && head >= 0 && head <= maxT
  const body = (a: string) => ({ algorithm: a, head, max_track: maxT, direction: dir, requests: reqs })
  const exec = () => run(async () => { const [r, c] = await Promise.all([api('/sim/disk', body(alg)), api('/sim/disk/compare', body(alg))]); setRes(r); setCmp(c); setStep(0); setPlay(true) })

  useEffect(() => {
    clearInterval(timer.current)
    if (play && res) timer.current = setInterval(() => setStep(s => { if (s >= res.path.length - 1) { setPlay(false); return s } return s + 1 }), 650)
    return () => clearInterval(timer.current)
  }, [play, res])

  const W = 820, H = res ? Math.max(180, res.path.length * 34 + 50) : 180, L = 20
  const X = (p: number) => L + (p / maxT) * (W - 2 * L)
  const shown = res ? res.path.slice(0, step + 1) : []
  const servedBlocks = new Set(shown.filter((p: any) => p.kind === 'S').map((p: any) => p.pos))
  const cmpRows = cmp ? Object.entries(cmp).map(([k, v]: any) => ({ key: k, name: diskLabel[k], seek: v.total_seek, ret: v.return_seek, order: v.order.map((o: any) => o.block) })) : []
  const best = cmpRows.length ? Math.min(...cmpRows.map(r => r.seek)) : 0

  return (
    <Card title="Disk-head simulator" icon={<Gauge size={16} />} accent="disk">
      <p className="text-sm text-mute mb-4 max-w-3xl">Enter a start position and a request sequence, pick an algorithm and execute. The movement and seek distances are computed by the C++ <code className="num">HeadScheduler</code> that also orders real block I/O. The example is test case TC-03.</p>
      <div className="grid lg:grid-cols-4 gap-4 items-end mb-3">
        <Field label="Algorithm"><select className="w-full" value={alg} onChange={e => setAlg(e.target.value)}>{diskAlgs.map(a => <option key={a} value={a}>{diskLabel[a]}</option>)}</select></Field>
        <Field label="Head start"><NumIn value={head} onChange={setHead} min={0} max={maxT} /></Field>
        <Field label="Last track"><NumIn value={maxT} onChange={setMaxT} min={1} max={9999} /></Field>
        <Field label="Initial direction"><Seg accent="disk" value={dir} onChange={setDir} options={[{ v: 'up', label: 'Up →' }, { v: 'down', label: '← Down' }]} /></Field>
      </div>
      <Field label="Block requests (comma or space separated)"><input className="w-full num" value={reqText} onChange={e => setReqText(e.target.value)} /></Field>
      {!valid && <p className="text-xs text-bad mt-1">Every request must be a whole number between 0 and {maxT}.</p>}
      <div className="flex gap-2 mt-3 flex-wrap"><Btn busy={busy} disabled={!valid} onClick={exec} icon={<Play size={14} />}>Execute</Btn>
        {res && <><Btn tone="ghost" onClick={() => setPlay(p => !p)} icon={play ? <Pause size={14} /> : <Play size={14} />}>{play ? 'Pause' : 'Play'}</Btn>
          <Btn tone="ghost" onClick={() => { setPlay(false); setStep(s => Math.min(res.path.length - 1, s + 1)) }} icon={<SkipForward size={14} />}>Step</Btn>
          <Btn tone="ghost" onClick={() => { setPlay(false); setStep(0) }} icon={<RotateCcw size={14} />}>Reset</Btn></>}</div>

      {res && (
        <div className="mt-5 grid lg:grid-cols-5 gap-5">
          <div className="lg:col-span-3 overflow-x-auto rounded-lg border border-line bg-raised/40 p-2">
            <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[520px]">
              {Array.from({ length: 11 }, (_, i) => Math.round((maxT * i) / 10)).map(t => (<g key={t}><line x1={X(t)} x2={X(t)} y1={26} y2={H - 6} stroke="rgb(var(--line))" /><text x={X(t)} y={14} textAnchor="middle" className="recharts-text">{t}</text></g>))}
              {reqs.map((b, i) => <rect key={i} x={X(b) - 4} y={22} width={8} height={8} rx={2} fill={servedBlocks.has(b) ? hex.good : hex.sync}><title>request {b}</title></rect>)}
              <polyline fill="none" stroke={hex.disk} strokeWidth={2.2} points={shown.map((p: any, i: number) => `${X(p.pos)},${44 + i * 34}`).join(' ')} />
              {shown.map((p: any, i: number) => (<g key={i}><circle cx={X(p.pos)} cy={44 + i * 34} r={p.kind === 'S' ? 5 : 4} fill={p.kind === 'S' ? hex.good : p.kind === 'H' ? hex.net : p.kind === 'E' ? hex.cpu : hex.mem} />
                <text x={p.pos > maxT * 0.85 ? X(p.pos) - 9 : X(p.pos) + 9} textAnchor={p.pos > maxT * 0.85 ? 'end' : 'start'} y={48 + i * 34} className="recharts-text" style={{ fontWeight: 600 }}>{p.pos}{p.kind === 'E' ? ' (edge)' : p.kind === 'J' ? ' (jump)' : ''}</text></g>))}
              {shown.length > 0 && <circle cx={X(shown[shown.length - 1].pos)} cy={44 + (shown.length - 1) * 34} r={9} fill="none" stroke={hex.disk} strokeWidth={2.5} />}
            </svg>
            <div className="flex gap-4 text-[11px] text-mute px-2 pb-1 flex-wrap"><span><i className="inline-block h-2 w-2 rounded-full bg-net mr-1" />start</span><span><i className="inline-block h-2 w-2 rounded-full bg-good mr-1" />served</span><span><i className="inline-block h-2 w-2 rounded-full bg-cpu mr-1" />disk edge</span><span><i className="inline-block h-2 w-2 rounded-full bg-mem mr-1" />return jump</span><span><i className="inline-block h-2 w-2 rounded-sm bg-sync mr-1" />pending request</span></div>
          </div>
          <div className="lg:col-span-2 space-y-3">
            <div className="grid grid-cols-2 gap-2"><Stat accent="disk" label="Total seek" value={res.total_seek} sub={res.return_seek ? `${res.return_seek} is the return jump` : diskLabel[res.algorithm]} /><Stat accent="disk" label="Position" value={shown.length ? shown[shown.length - 1].pos : head} sub={`step ${step + 1} of ${res.path.length}`} /></div>
            <table><thead><tr><th>#</th><th>Block served</th><th>Seek</th></tr></thead><tbody>
              {res.order.map((o: any, i: number) => <tr key={i}><td className="num text-mute">{i + 1}</td><td className="num font-semibold">{o.block}</td><td className="num">{o.seek}</td></tr>)}</tbody></table>
          </div>
        </div>)}

      {cmp && (
        <div className="mt-6 grid lg:grid-cols-2 gap-5">
          <div className="h-60"><ResponsiveContainer><BarChart data={cmpRows}>{grid}<XAxis dataKey="name" /><YAxis width={40} /><Tooltip {...tt} cursor={{ fill: 'rgb(var(--raised))' }} />
            <Bar dataKey="seek" name="total seek (tracks)" radius={4} isAnimationActive={false}>{cmpRows.map(r => <Cell key={r.key} fill={r.seek === best ? hex.good : hex.disk} />)}</Bar></BarChart></ResponsiveContainer></div>
          <table><thead><tr><th>Algorithm</th><th>Total seek</th><th>Service order</th></tr></thead><tbody>
            {cmpRows.map(r => <tr key={r.key}><td className="font-semibold">{r.name} {r.seek === best && <Badge tone="good">lowest</Badge>}</td><td className="num">{r.seek}{r.ret ? ` (${r.ret} return)` : ''}</td><td className="num">{r.order.join(' → ')}</td></tr>)}</tbody></table>
          <div className="lg:col-span-2"><Note tone="disk">C-SCAN and C-LOOK count the return jump as head movement (the head does travel it). SCAN and C-SCAN go all the way to the edge track {maxT}; LOOK and C-LOOK turn around at the last request.</Note></div>
        </div>)}
    </Card>
  )
}
