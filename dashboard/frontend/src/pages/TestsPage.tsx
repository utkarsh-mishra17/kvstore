import { useEffect, useState } from 'react'
import { CheckCircle2, ChevronDown, FlaskConical, Loader2, Play, XCircle, Clock } from 'lucide-react'
import { Badge, Btn, Card, Empty, Note, Stat, useAction } from '../components/ui'
import { api } from '../lib/api'
import { useApp } from '../lib/store'

export default function TestsPage() {
  const { toast } = useApp()
  const { busy, run } = useAction(toast)
  const [data, setData] = useState<{ running: boolean; results: any[] }>({ running: false, results: [] })
  const [open, setOpen] = useState<string | null>(null)
  const load = async () => { try { setData(await api('/tests')) } catch { /* api down */ } }
  useEffect(() => { load() }, [])
  useEffect(() => { if (!data.running) return; const t = setInterval(load, 800); return () => clearInterval(t) }, [data.running])
  const pass = data.results.filter(r => r.status === 'PASS').length, fail = data.results.filter(r => r.status === 'FAIL').length
  const start = () => run(async () => { await api('/tests/run', {}); await load() })

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat accent="good" label="Passed" value={pass} sub={`of ${data.results.length} test cases`} icon={<CheckCircle2 size={15} />} />
        <Stat accent="bad" label="Failed" value={fail} icon={<XCircle size={15} />} />
        <Stat accent="net" label="State" value={data.running ? 'Running' : 'Idle'} sub="each test starts its own server" />
        <div className="rounded-xl border border-line bg-panel p-3 flex items-center"><Btn busy={busy || data.running} onClick={start} icon={<Play size={15} />} className="w-full">Run all test cases</Btn></div>
      </div>
      <Note>Each test case from the synopsis starts a fresh <code className="num">kvserver</code> on a private port with a temporary data file, drives it over TCP, and compares the observed behaviour with a hand-computed expectation. The live server above is not touched. Command line: <code className="num">make test</code>.</Note>
      <Card title="Test cases" icon={<FlaskConical size={16} />} pad={false}>
        {data.results.length === 0 ? <Empty text="No tests loaded" /> : data.results.map(r => (
          <div key={r.id} className="border-t border-line first:border-t-0">
            <button className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-raised/50" onClick={() => setOpen(open === r.id ? null : r.id)}>
              <span className="w-[70px]">{r.status === 'PASS' ? <Badge tone="good">PASS</Badge> : r.status === 'FAIL' ? <Badge tone="bad">FAIL</Badge> : r.status === 'RUNNING' ? <Badge tone="cpu"><Loader2 size={12} className="animate-spin" />RUN</Badge> : <Badge><Clock size={12} />WAIT</Badge>}</span>
              <span className="num font-bold w-14">{r.id}</span><span className="flex-1"><span className="font-semibold">{r.name}</span> <span className="text-xs text-mute ml-1">{r.module}</span></span>
              {r.duration_ms !== undefined && <span className="num text-xs text-mute">{r.duration_ms} ms</span>}<ChevronDown size={16} className={`text-mute transition ${open === r.id ? 'rotate-180' : ''}`} />
            </button>
            {open === r.id && r.input !== undefined && (
              <div className="px-4 pb-4 grid md:grid-cols-3 gap-3 text-sm">
                {[['Input', r.input], ['Expected', r.expected], ['Actual result', r.actual]].map(([k, v]) => <div key={k} className="rounded-lg bg-raised/70 p-3"><div className="text-xs text-mute mb-1">{k}</div><div className="leading-relaxed break-words">{v}</div></div>)}
                {r.details?.length > 0 && <div className="md:col-span-3 rounded-lg bg-raised/70 p-3 num text-xs space-y-0.5">{r.details.map((d: string, i: number) => <div key={i}>{d}</div>)}</div>}
              </div>)}
          </div>))}
      </Card>
    </div>
  )
}
