import { useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Cpu, ListOrdered, Pause, Play, Plus, Trash2, Workflow, FlaskConical, Table2 } from 'lucide-react'
import { Badge, Btn, Card, Empty, Field, Note, NumIn, Seg, Tabs, hex, useAction } from '../components/ui'
import { Gantt, colorFor } from '../components/Gantt'
import { api } from '../lib/api'
import { useApp } from '../lib/store'
import { OP_COLORS, policies, policyLabel, us, n0 } from '../lib/fmt'

type Job = { name: string; arrival: number; burst: number; priority: number }
const tt = { contentStyle: { background: 'rgb(var(--panel))', border: '1px solid rgb(var(--line))', borderRadius: 8, fontSize: 12 } }
const grid = <CartesianGrid stroke="rgb(var(--line))" strokeDasharray="3 3" vertical={false} />

export default function CpuPage({}: { go?: any }) {
  const { live, toast } = useApp()
  const s = live.stats
  const { busy, run } = useAction(toast)
  const [quantum, setQuantum] = useState(16)
  const [delay, setDelay] = useState(0)
  const [tab, setTab] = useState('sim')

  const setPolicy = (p: string) => run(() => api('/config', { cpu_policy: p, quantum }), `CPU policy set to ${policyLabel[p]}`)
  const gantt = live.gantt.slice(-60)
  const t0 = gantt.length ? Math.min(...gantt.map(g => g.start_us)) : 0
  const lanes = useMemo(() => {
    const w = s?.workers.count ?? 0
    return Array.from({ length: w }, (_, i) => ({ label: 'Worker ' + i, segs: gantt.filter(g => g.worker === i).map(g => ({ start: (g.start_us - t0) / 1000, end: (g.end_us - t0) / 1000, label: '#' + g.req, color: OP_COLORS[g.op], title: `req ${g.req} ${g.op}${g.final ? '' : ' (preempted slice)'}` })) }))
  }, [gantt, t0, s?.workers.count])
  const recent = live.reqs.slice(-30)
  const bars = recent.map(r => ({ id: '#' + r.id, wait: r.wait_us, service: r.service_us }))
  const t1 = recent.length ? Math.min(...recent.map(r => r.arrival_us)) : 0
  if (!s) return <Empty text="Waiting for server data" />
  const pp = Object.entries(s.cpu.per_policy as Record<string, any>).map(([k, v]: any) => ({ name: policyLabel[k], wait: Math.round(v.avg_wait_us), tat: Math.round(v.avg_turnaround_us), n: v.n }))
  const q = live.snapshot?.queue || []

  return (
    <div className="space-y-4">
      <div className="grid lg:grid-cols-3 gap-4">
        <Card title="Scheduling policy (runtime)" icon={<Cpu size={16} />} accent="cpu" className="lg:col-span-2">
          <div className="space-y-4">
            <Seg accent="cpu" value={s.cpu.policy.toLowerCase()} onChange={setPolicy} options={policies.map(p => ({ v: p, label: policyLabel[p] }))} />
            <div className="flex flex-wrap gap-4 items-end">
              <Field label="Round Robin quantum (block units)" hint="LIST scans are cut into slices of this many blocks."><NumIn value={quantum} onChange={setQuantum} min={1} max={1000} /></Field>
              <Btn tone="ghost" busy={busy} onClick={() => run(() => api('/config', { quantum }), `Quantum set to ${quantum}`)}>Apply quantum</Btn>
              <Field label="Synthetic service delay (µs per unit)" hint="Slows each unit of work so queues form and policies are visible."><NumIn value={delay} onChange={setDelay} min={0} max={100000} /></Field>
              <Btn tone="ghost" busy={busy} onClick={() => run(() => api('/config', { delay_us: delay }), `Service delay set to ${delay} µs/unit`)}>Apply delay</Btn>
              <Btn tone="ghost" icon={s.queue.paused ? <Play size={14} /> : <Pause size={14} />} onClick={() => run(() => api('/admin/' + (s.queue.paused ? 'resume' : 'pause'), {}), s.queue.paused ? 'Dispatch resumed' : 'Dispatch paused')}>{s.queue.paused ? 'Resume dispatch' : 'Pause dispatch'}</Btn>
            </div>
            <Note tone="cpu">FCFS, SJF (smallest estimated cost first), Priority (@prio=1..9, higher first) and Round Robin are applied by the C++ queue on the next dispatch. Cost estimate: GET/SET/DEL = 1, MSET = number of pairs, LIST = 200 block reads.</Note>
          </div>
        </Card>
        <Card title="Worker threads" icon={<Workflow size={16} />} accent="cpu">
          <div className="grid grid-cols-2 gap-2">
            {(live.snapshot?.workers || []).map((w: any) => (
              <div key={w.id} className={`rounded-lg border px-3 py-2 ${w.req ? 'border-cpu/60 bg-cpu/10' : 'border-line'}`}>
                <div className="text-[11px] text-mute">Worker {w.id}</div><div className="num font-semibold">{w.req ? 'req #' + w.req : 'idle'}</div>
              </div>))}
          </div>
          <div className="mt-3 text-xs text-mute">{s.workers.busy} of {s.workers.count} busy · {n0(s.cpu.dispatched)} dispatches · {n0(s.cpu.preemptions)} RR preemptions</div>
        </Card>
      </div>

      <Card title="Request queue (live)" icon={<ListOrdered size={16} />} accent="cpu" action={<Badge tone={s.queue.paused ? 'bad' : 'good'}>{s.queue.paused ? 'dispatch paused' : `${q.length} / ${s.queue.capacity}`}</Badge>}>
        {q.length === 0 ? <Empty text="The queue is empty" hint="Pause dispatch, then send requests from the Explorer or the demo panel below to watch them wait here." /> : (
          <div className="flex flex-wrap gap-2">{q.map((r: any, i: number) => (
            <div key={r.id} className="rounded-lg border px-2.5 py-1.5 text-xs" style={{ borderColor: OP_COLORS[r.op] + '88', background: OP_COLORS[r.op] + '18' }}>
              <div className="num font-bold">{i === 0 ? '▶ ' : ''}#{r.id} {r.op}</div><div className="text-mute num">prio {r.priority} · cost {r.remaining} · {us(r.age_us)}</div></div>))}</div>)}
      </Card>

      <div className="grid lg:grid-cols-2 gap-4">
        <Card title="Gantt chart: worker slices (last 60, ms)" icon={<Workflow size={16} />} accent="cpu">
          {gantt.length === 0 ? <Empty text="No executed requests yet" /> : <Gantt lanes={lanes} unit="" />}
          <div className="flex gap-3 mt-2 flex-wrap">{Object.entries(OP_COLORS).map(([k, c]) => <span key={k} className="text-[11px] text-mute flex items-center gap-1"><i className="h-2 w-2 rounded-sm" style={{ background: c }} />{k}</span>)}</div>
        </Card>
        <Card title="Waiting vs service time (last 30 requests)" icon={<Cpu size={16} />} accent="cpu">
          <div className="h-60"><ResponsiveContainer><BarChart data={bars}>{grid}<XAxis dataKey="id" hide /><YAxis width={50} /><Tooltip {...tt} /><Legend />
            <Bar dataKey="wait" stackId="a" name="waiting (µs)" fill={hex.cpu} isAnimationActive={false} /><Bar dataKey="service" stackId="a" name="service (µs)" fill={hex.net} isAnimationActive={false} /></BarChart></ResponsiveContainer></div>
        </Card>
      </div>

      <Card title="Policy comparison from live traffic" icon={<Cpu size={16} />} accent="cpu">
        <div className="grid md:grid-cols-2 gap-4">
          <div className="h-56"><ResponsiveContainer><BarChart data={pp}>{grid}<XAxis dataKey="name" /><YAxis width={52} /><Tooltip {...tt} cursor={{ fill: 'rgb(var(--raised))' }} /><Legend />
            <Bar dataKey="wait" name="avg waiting (µs)" fill={hex.cpu} radius={3} isAnimationActive={false} /><Bar dataKey="tat" name="avg turnaround (µs)" fill={hex.net} radius={3} isAnimationActive={false} /></BarChart></ResponsiveContainer></div>
          <table><thead><tr><th>Policy</th><th>Requests</th><th>Avg waiting</th><th>Avg turnaround</th></tr></thead><tbody>
            {pp.map(p => <tr key={p.name}><td className="font-semibold">{p.name}</td><td className="num">{n0(p.n)}</td><td className="num">{p.n ? us(p.wait) : '–'}</td><td className="num">{p.n ? us(p.tat) : '–'}</td></tr>)}</tbody></table>
        </div>
        <p className="text-[11px] text-mute mt-2">Run identical workloads under each policy automatically from <b>Benchmark &amp; Load</b> → “Compare CPU policies”.</p>
      </Card>

      <Card title="Per-request execution table (newest first)" icon={<Table2 size={16} />} accent="cpu" pad={false}>
        {recent.length === 0 ? <Empty text="No completed requests yet" /> : (
          <div className="max-h-80 overflow-auto px-2 pb-2"><table><thead><tr><th>Req</th><th>Op</th><th>Policy</th><th>Priority</th><th>Cost</th><th>Arrival (ms)</th><th>Start (ms)</th><th>Completion (ms)</th><th>Waiting</th><th>Turnaround</th><th>Slices</th><th>Worker</th></tr></thead><tbody>
            {[...recent].reverse().map(r => (<tr key={r.seq}><td className="num">#{r.id}</td><td><Badge>{r.op}</Badge></td><td>{policyLabel[r.policy]}</td><td className="num">{r.priority}</td><td className="num">{r.cost}</td>
              <td className="num">{((r.arrival_us - t1) / 1000).toFixed(2)}</td><td className="num">{((r.start_us - t1) / 1000).toFixed(2)}</td><td className="num">{((r.completion_us - t1) / 1000).toFixed(2)}</td>
              <td className="num">{us(r.wait_us)}</td><td className="num">{us(r.turnaround_us)}</td><td className="num">{r.slices}</td><td className="num">{r.worker}</td></tr>))}</tbody></table></div>)}
      </Card>

      <Card title="Scheduling demonstrations" icon={<FlaskConical size={16} />} accent="cpu">
        <Tabs value={tab} onChange={setTab} tabs={[{ v: 'sim', label: 'Virtual-time simulator' }, { v: 'live', label: 'Live demo on the server' }]} />
        <div className="pt-4">{tab === 'sim' ? <Simulator /> : <LiveDemo />}</div>
      </Card>
    </div>
  )
}

function Simulator() {
  const { toast } = useApp()
  const { busy, run } = useAction(toast)
  const [policy, setPolicy] = useState('rr')
  const [quantum, setQuantum] = useState(4)
  const [jobs, setJobs] = useState<Job[]>([{ name: 'P1', arrival: 0, burst: 6, priority: 1 }, { name: 'P2', arrival: 0, burst: 4, priority: 2 }, { name: 'P3', arrival: 0, burst: 9, priority: 3 }])
  const [res, setRes] = useState<any>(null)
  const [cmp, setCmp] = useState<any>(null)
  const body = () => ({ policy, quantum, jobs })
  const upd = (i: number, k: keyof Job, v: any) => setJobs(j => j.map((x, n) => (n === i ? { ...x, [k]: v } : x)))
  const valid = jobs.every(j => /^[A-Za-z0-9_-]{1,12}$/.test(j.name) && j.burst >= 1 && j.arrival >= 0)
  return (
    <div className="space-y-4">
      <p className="text-sm text-mute max-w-3xl">Jobs are scheduled in virtual time units by the same C++ <code className="num">pick_index()</code> routine the live queue uses. The preset below is test case TC-02 (quantum 4, costs 6/4/9).</p>
      <div className="grid lg:grid-cols-3 gap-4">
        <div className="space-y-3">
          <Field label="Policy"><select value={policy} onChange={e => setPolicy(e.target.value)}>{policies.map(p => <option key={p} value={p}>{policyLabel[p]}</option>)}</select></Field>
          {policy === 'rr' && <Field label="Time quantum"><NumIn value={quantum} onChange={setQuantum} min={1} max={1000} /></Field>}
          <div className="flex gap-2 flex-wrap">
            <Btn busy={busy} disabled={!valid} onClick={() => run(async () => { setRes(await api('/sim/sched', body())); setCmp(null) })}>Run schedule</Btn>
            <Btn tone="ghost" busy={busy} disabled={!valid} onClick={() => run(async () => { setCmp(await api('/sim/sched/compare', body())); setRes(null) })}>Compare all policies</Btn>
          </div>
        </div>
        <div className="lg:col-span-2">
          <table><thead><tr><th>Job</th><th>Arrival</th><th>Burst / cost</th><th>Priority</th><th /></tr></thead><tbody>
            {jobs.map((j, i) => (<tr key={i}><td><input className="w-20" value={j.name} onChange={e => upd(i, 'name', e.target.value)} /></td><td><NumIn className="w-20" value={j.arrival} onChange={v => upd(i, 'arrival', v)} min={0} /></td>
              <td><NumIn className="w-20" value={j.burst} onChange={v => upd(i, 'burst', v)} min={1} /></td><td><NumIn className="w-20" value={j.priority} onChange={v => upd(i, 'priority', v)} min={1} max={9} /></td>
              <td><button aria-label="Remove job" className="text-bad" onClick={() => setJobs(js => js.filter((_, n) => n !== i))}><Trash2 size={14} /></button></td></tr>))}</tbody></table>
          <Btn tone="ghost" className="mt-2" icon={<Plus size={14} />} onClick={() => setJobs(j => [...j, { name: 'P' + (j.length + 1), arrival: 0, burst: 5, priority: 1 }])}>Add job</Btn>
        </div>
      </div>
      {res && <SimResult r={res} />}
      {cmp && (
        <div className="space-y-4">
          <div className="grid md:grid-cols-2 gap-4"><div className="h-56"><ResponsiveContainer><BarChart data={Object.values(cmp).map((r: any) => ({ name: policyLabel[r.policy], wait: r.avg_wait, tat: r.avg_turnaround }))}>{grid}<XAxis dataKey="name" /><YAxis width={36} /><Tooltip {...tt} cursor={{ fill: 'rgb(var(--raised))' }} /><Legend />
            <Bar dataKey="wait" name="avg waiting" fill={hex.cpu} radius={3} /><Bar dataKey="tat" name="avg turnaround" fill={hex.net} radius={3} /></BarChart></ResponsiveContainer></div>
            <table><thead><tr><th>Policy</th><th>Avg waiting</th><th>Avg turnaround</th><th>Order of completion</th></tr></thead><tbody>
              {Object.values(cmp).map((r: any) => <tr key={r.policy}><td className="font-semibold">{policyLabel[r.policy]}</td><td className="num">{r.avg_wait.toFixed(2)}</td><td className="num">{r.avg_turnaround.toFixed(2)}</td><td className="num">{[...r.jobs].sort((a: any, b: any) => a.completion - b.completion).map((j: any) => j.name).join(' → ')}</td></tr>)}</tbody></table></div>
          {Object.values(cmp).map((r: any) => <div key={r.policy}><div className="text-xs font-semibold mb-1">{policyLabel[r.policy]}</div><Gantt lanes={[{ label: 'CPU', segs: r.gantt.map((g: any) => ({ start: g.start, end: g.end, label: g.name })) }]} /></div>)}
        </div>)}
    </div>
  )
}

function SimResult({ r }: { r: any }) {
  return (
    <div className="space-y-3">
      <div className="text-sm font-semibold">{policyLabel[r.policy]} schedule · avg waiting <span className="num">{r.avg_wait.toFixed(2)}</span> · avg turnaround <span className="num">{r.avg_turnaround.toFixed(2)}</span></div>
      <Gantt lanes={[{ label: 'CPU', segs: r.gantt.map((g: any) => ({ start: g.start, end: g.end, label: g.name, color: colorFor(g.name) })) }]} />
      <table><thead><tr><th>Job</th><th>Arrival</th><th>Burst</th><th>Priority</th><th>Start</th><th>Completion</th><th>Waiting</th><th>Turnaround</th></tr></thead><tbody>
        {r.jobs.map((j: any) => <tr key={j.name}><td className="font-semibold">{j.name}</td><td className="num">{j.arrival}</td><td className="num">{j.burst}</td><td className="num">{j.priority}</td><td className="num">{j.start}</td><td className="num">{j.completion}</td><td className="num">{j.waiting}</td><td className="num">{j.turnaround}</td></tr>)}</tbody></table>
    </div>
  )
}

const presets: Record<string, { label: string; policy: string; jobs: any[] }> = {
  tc01: { label: 'TC-01 · Priority: Normal, High, Admin', policy: 'priority', jobs: [{ label: 'Normal', command: 'SET demo:n 1', priority: 1, delay_ms: 0 }, { label: 'High', command: 'SET demo:h 1', priority: 2, delay_ms: 120 }, { label: 'Admin', command: 'SET demo:a 1', priority: 3, delay_ms: 240 }] },
  sjf: { label: 'SJF · LIST scan vs short GETs', policy: 'sjf', jobs: [{ label: 'LIST', command: 'LIST', priority: 1, delay_ms: 0 }, { label: 'GET-1', command: 'GET demo:n', priority: 1, delay_ms: 100 }, { label: 'GET-2', command: 'GET demo:h', priority: 1, delay_ms: 200 }] },
  rr: { label: 'Round Robin · LIST is time-sliced', policy: 'rr', jobs: [{ label: 'LIST', command: 'LIST', priority: 1, delay_ms: 0 }, { label: 'GET-1', command: 'GET demo:n', priority: 1, delay_ms: 100 }, { label: 'GET-2', command: 'GET demo:h', priority: 1, delay_ms: 200 }] },
  fcfs: { label: 'FCFS · arrival order', policy: 'fcfs', jobs: [{ label: 'A', command: 'SET demo:x 1', priority: 3, delay_ms: 0 }, { label: 'B', command: 'GET demo:x', priority: 1, delay_ms: 100 }, { label: 'C', command: 'DEL demo:x', priority: 2, delay_ms: 200 }] },
}
function LiveDemo() {
  const { toast } = useApp()
  const { busy, run } = useAction(toast)
  const [p, setP] = useState('tc01')
  const [out, setOut] = useState<any>(null)
  return (
    <div className="space-y-4">
      <Note tone="cpu">The server pauses dispatch, three real TCP clients submit their requests, then dispatch resumes. The table lists the order the real scheduler chose (dispatch #). Requests enter in the order shown in the preset; for Round Robin, the LIST needs several slices.</Note>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Scenario"><select value={p} onChange={e => setP(e.target.value)}>{Object.entries(presets).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></Field>
        <Btn busy={busy} icon={<Play size={14} />} onClick={() => run(async () => setOut(await api('/demo/cpu', { policy: presets[p].policy, quantum: 16, jobs: presets[p].jobs })), 'Live scheduling demo finished')}>Run on server</Btn>
      </div>
      <div className="text-xs text-mute">Submitted: {presets[p].jobs.map(j => `${j.label} (${j.command}, prio ${j.priority}, +${j.delay_ms} ms)`).join('  ·  ')}</div>
      {out && (
        <table><thead><tr><th>Dispatch #</th><th>Client</th><th>Priority</th><th>Cost</th><th>Waiting</th><th>Service</th><th>Turnaround</th><th>Slices</th></tr></thead><tbody>
          {out.results.map((r: any) => <tr key={r.label}><td className="num font-bold">{r.dispatch}</td><td className="font-semibold">{r.label}</td><td className="num">{r.prio}</td><td className="num">{r.cost}</td><td className="num">{us(+r.wait_us)}</td><td className="num">{us(+r.service_us)}</td><td className="num">{us(+r.turnaround_us)}</td><td className="num">{r.slices}</td></tr>)}</tbody></table>)}
    </div>
  )
}
