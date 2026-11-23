import { useState } from 'react'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Activity, Download, Play, ShieldCheck, Gauge } from 'lucide-react'
import { Badge, Btn, Card, Empty, Field, Note, NumIn, Stat, hex, useAction } from '../components/ui'
import { api } from '../lib/api'
import { useApp } from '../lib/store'
import { n0, n1, policyLabel, policies, us } from '../lib/fmt'

const tt = { contentStyle: { background: 'rgb(var(--panel))', border: '1px solid rgb(var(--line))', borderRadius: 8, fontSize: 12 } }
const grid = <CartesianGrid stroke="rgb(var(--line))" strokeDasharray="3 3" vertical={false} />

export default function BenchmarkPage() {
  const { toast, live } = useApp()
  const { busy, run } = useAction(toast)
  const [cfg, setCfg] = useState({ clients: 20, requests: 2000, duration: 0, operation: 'MIXED', policy: '', quantum: 16, delay_us: 0, priorities: false })
  const [results, setResults] = useState<any[]>([])
  const [cmp, setCmp] = useState<any[] | null>(null)
  const [last, setLast] = useState<any>(null)
  const set = (k: string, v: any) => setCfg(c => ({ ...c, [k]: v }))
  const body = () => ({ clients: cfg.clients, requests: cfg.requests, duration: cfg.duration, operation: cfg.operation, policy: cfg.policy || null, quantum: cfg.quantum, delay_us: cfg.delay_us, priorities: cfg.priorities })
  const load = async () => setResults(await api('/bench/results'))
  const valid = cfg.clients >= 1 && cfg.requests >= 1

  const runOne = (b: any, msg: string) => run(async () => { const r = await api('/bench/run', b); setLast(r); await load(); return r }, msg)
  return (
    <div className="space-y-4">
      <div className="grid lg:grid-cols-3 gap-4">
        <Card title="Load test configuration" icon={<Activity size={16} />} className="lg:col-span-2">
          <div className="grid sm:grid-cols-3 gap-4">
            <Field label="Concurrent clients"><NumIn value={cfg.clients} onChange={v => set('clients', v)} min={1} max={500} /></Field>
            <Field label="Total requests"><NumIn value={cfg.requests} onChange={v => set('requests', v)} min={1} max={500000} /></Field>
            <Field label="Duration (s, 0 = by count)"><NumIn value={cfg.duration} onChange={v => set('duration', v)} min={0} max={120} /></Field>
            <Field label="Operation"><select value={cfg.operation} onChange={e => set('operation', e.target.value)}>{['MIXED', 'MIXLIST', 'SET', 'GET', 'DEL', 'MSET', 'LIST'].map(o => <option key={o}>{o}</option>)}</select></Field>
            <Field label="CPU policy"><select value={cfg.policy} onChange={e => set('policy', e.target.value)}><option value="">keep current ({live.stats ? policyLabel[live.stats.cpu.policy] : '–'})</option>{policies.map(p => <option key={p} value={p}>{policyLabel[p]}</option>)}</select></Field>
            <Field label="Service delay (µs/unit)"><NumIn value={cfg.delay_us} onChange={v => set('delay_us', v)} min={0} max={100000} /></Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="!w-4 !h-4" checked={cfg.priorities} onChange={e => set('priorities', e.target.checked)} />Random priorities 1–3</label>
          </div>
          <div className="flex flex-wrap gap-2 mt-4">
            <Btn busy={busy} disabled={!valid} icon={<Play size={14} />} onClick={() => runOne(body(), 'Benchmark finished')}>Run benchmark</Btn>
            <Btn tone="ghost" busy={busy} icon={<ShieldCheck size={14} />} onClick={() => runOne({ clients: 100, requests: 5000, duration: 0, operation: 'MIXED', priorities: false }, 'Concurrency target check finished')}>Verify 100 concurrent clients</Btn>
            <Btn tone="ghost" busy={busy} icon={<Gauge size={14} />} onClick={() => run(async () => { const r = await api('/bench/compare', { clients: 32, requests: 3000, duration: 0, operation: 'MIXLIST', quantum: cfg.quantum, delay_us: cfg.delay_us || 20, priorities: true }); setCmp(r.runs); await load() }, 'Policy comparison finished')}>Compare CPU policies</Btn>
          </div>
          <p className="text-[11px] text-mute mt-3">Every client is a real TCP connection from the multi-threaded C++ <code className="num">kvbench</code>. All connections are established before the first request is sent.</p>
        </Card>
        <Card title="Concurrency target" icon={<ShieldCheck size={16} />} accent="good">
          {!last ? <Empty text="Not measured yet" hint="The synopsis requires 100 concurrent clients without errors. Run the check to verify it." /> : (
            <div className="space-y-2"><Badge tone={last.target_100_clients === 'VERIFIED' ? 'good' : last.target_100_clients === 'NOT VERIFIED' ? 'bad' : 'mute'}>{last.target_100_clients === 'n/a' ? 'last run used < 100 clients' : last.target_100_clients}</Badge>
              <div className="text-sm">{last.connected} of {last.clients} clients connected · {last.failed} failed requests · server peak {last.server_peak_connections} connections</div></div>)}
        </Card>
      </div>

      {last && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <Stat label="Total requests" value={n0(last.total_requests)} sub={`${last.clients} clients (${last.connected} connected)`} />
            <Stat accent="good" label="Successful" value={n0(last.successful)} sub={`${n0(last.failed)} failed · error rate ${(last.error_rate * 100).toFixed(2)}%`} />
            <Stat accent="good" label="Requests / second" value={n0(last.requests_per_sec)} sub={`throughput over ${last.duration_s.toFixed(2)} s`} />
            <Stat accent="cpu" label="Average latency" value={us(last.avg_latency_us)} sub={`min ${us(last.min_latency_us)} · max ${us(last.max_latency_us)}`} />
            <Stat accent="mem" label="Cache hit ratio (run)" value={(last.cache_hit_ratio * 100).toFixed(1) + '%'} sub={`disk seek ${n0(last.disk_seek)} tracks`} />
          </div>
          <div className="grid lg:grid-cols-2 gap-4">
            <Card title="Client-observed latency distribution" icon={<Activity size={16} />}>
              <div className="h-56"><ResponsiveContainer><BarChart data={[['min', last.min_latency_us], ['p50', last.p50_us], ['avg', last.avg_latency_us], ['p95', last.p95_us], ['p99', last.p99_us], ['max', last.max_latency_us]].map(([n, v]: any) => ({ name: n, us: Math.round(v) }))}>{grid}<XAxis dataKey="name" /><YAxis width={56} /><Tooltip {...tt} cursor={{ fill: 'rgb(var(--raised))' }} /><Bar dataKey="us" name="latency (µs)" fill={hex.net} radius={4} isAnimationActive={false} /></BarChart></ResponsiveContainer></div>
            </Card>
            <Card title="Server-side scheduling during this run" icon={<Gauge size={16} />} accent="cpu">
              <div className="grid grid-cols-2 gap-3 text-sm"><Stat accent="cpu" label="Policy" value={policyLabel[last.policy]} sub={last.policy === 'RR' ? `quantum ${last.quantum} · ${n0(last.preemptions)} preemptions` : ''} /><Stat accent="cpu" label="Avg waiting" value={us(last.avg_wait_us)} /><Stat accent="cpu" label="Avg turnaround" value={us(last.avg_turnaround_us)} /><Stat accent="cpu" label="Service delay" value={`${last.service_delay_us} µs`} /></div>
            </Card>
          </div>
        </>
      )}

      {cmp && (
        <Card title="CPU scheduling policy comparison (identical workload)" icon={<Gauge size={16} />} accent="cpu">
          <div className="grid lg:grid-cols-2 gap-5">
            <div className="h-60"><ResponsiveContainer><BarChart data={cmp.map(r => ({ name: policyLabel[r.policy], wait: Math.round(r.avg_wait_us), tat: Math.round(r.avg_turnaround_us) }))}>{grid}<XAxis dataKey="name" /><YAxis width={56} /><Tooltip {...tt} cursor={{ fill: 'rgb(var(--raised))' }} /><Legend />
              <Bar dataKey="wait" name="avg waiting (µs)" fill={hex.cpu} radius={3} /><Bar dataKey="tat" name="avg turnaround (µs)" fill={hex.net} radius={3} /></BarChart></ResponsiveContainer></div>
            <table><thead><tr><th>Policy</th><th>Req/s</th><th>Avg waiting</th><th>Avg turnaround</th><th>p99 latency</th><th>Preempt.</th></tr></thead><tbody>
              {cmp.map(r => <tr key={r.policy}><td className="font-semibold">{policyLabel[r.policy]}</td><td className="num">{n0(r.requests_per_sec)}</td><td className="num">{us(r.avg_wait_us)}</td><td className="num">{us(r.avg_turnaround_us)}</td><td className="num">{us(r.p99_us)}</td><td className="num">{n0(r.preemptions)}</td></tr>)}</tbody></table>
          </div>
          <div className="mt-3"><Note tone="cpu">Workload: 32 clients, ~3% full-table LIST scans mixed with GET/SET/DEL, random priorities 1–3, {cmp[0]?.service_delay_us} µs synthetic service delay per unit. Differences are measured, not scripted. Short requests suffer behind long scans under FCFS; SJF and Round Robin trade that off differently.</Note></div>
        </Card>
      )}

      <Card title="Benchmark history" icon={<Activity size={16} />} pad={false} action={<div className="flex gap-2"><Btn tone="ghost" icon={<Download size={14} />} onClick={() => (location.href = '/api/export/bench.csv')}>Export CSV</Btn><Btn tone="ghost" onClick={load}>Refresh</Btn></div>}>
        {results.length === 0 ? <Empty text="No runs yet" hint="Results from this session's runs appear here." /> : (
          <div className="max-h-72 overflow-auto px-2 pb-2"><table><thead><tr><th>Time</th><th>Op</th><th>Policy</th><th>Clients</th><th>Requests</th><th>Failed</th><th>Req/s</th><th>Avg</th><th>p99</th><th>Avg wait</th><th>Hit ratio</th></tr></thead><tbody>
            {[...results].reverse().map(r => <tr key={r.id}><td className="num text-mute">{r.time.slice(11)}</td><td>{r.operation}</td><td>{policyLabel[r.policy]}</td><td className="num">{r.connected}/{r.clients}</td><td className="num">{n0(r.total_requests)}</td><td className="num">{r.failed}</td><td className="num">{n0(r.requests_per_sec)}</td><td className="num">{us(r.avg_latency_us)}</td><td className="num">{us(r.p99_us)}</td><td className="num">{us(r.avg_wait_us)}</td><td className="num">{n1(r.cache_hit_ratio * 100)}%</td></tr>)}</tbody></table></div>)}
      </Card>
    </div>
  )
}
