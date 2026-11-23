import { useEffect, useMemo, useRef, useState } from 'react'
import { Download, ScrollText, Pause, Play, BarChart3 } from 'lucide-react'
import { Badge, Btn, Card, Empty, Tabs } from '../components/ui'
import { useApp } from '../lib/store'

const TYPES = ['CLIENT', 'REQUEST', 'QUEUE', 'SCHED', 'WORKER', 'CACHE', 'PAGE', 'DISK', 'LOCK', 'CONFIG', 'ERROR', 'SERVER']
const tone: Record<string, string> = { ERROR: 'bad', CLIENT: 'net', SERVER: 'good', CONFIG: 'cpu', SCHED: 'cpu', WORKER: 'cpu', DISK: 'disk', CACHE: 'mem', PAGE: 'mem', LOCK: 'sync', QUEUE: 'net', REQUEST: 'net' }

export default function LogsPage() {
  const { live } = useApp()
  const [tab, setTab] = useState('logs')
  const [active, setActive] = useState<Set<string>>(new Set(TYPES))
  const [q, setQ] = useState('')
  const [follow, setFollow] = useState(true)
  const box = useRef<HTMLDivElement>(null)
  const rows = useMemo(() => live.events.filter(e => active.has(e.type) && (!q || (e.msg + e.type).toLowerCase().includes(q.toLowerCase()))).slice(-400), [live.events, active, q])
  useEffect(() => { if (follow && box.current) box.current.scrollTop = box.current.scrollHeight }, [rows, follow])
  const toggle = (t: string) => setActive(a => { const n = new Set(a); n.has(t) ? n.delete(t) : n.add(t); return n })
  const s = live.stats

  return (
    <div className="space-y-4">
      <Tabs value={tab} onChange={setTab} tabs={[{ v: 'logs', label: 'Event log' }, { v: 'stats', label: 'Statistics report' }]} />
      {tab === 'logs' ? (
        <Card title="System events" icon={<ScrollText size={16} />} pad={false}
          action={<div className="flex gap-2"><Btn tone="ghost" icon={follow ? <Pause size={14} /> : <Play size={14} />} onClick={() => setFollow(f => !f)}>{follow ? 'Pause auto-scroll' : 'Follow'}</Btn><Btn tone="ghost" icon={<Download size={14} />} onClick={() => (location.href = '/api/export/logs.csv')}>Export CSV</Btn></div>}>
          <div className="px-4 pb-3 space-y-3">
            <input className="w-full" placeholder="Search events (e.g. req=12, block=57, DEADLOCK)" value={q} onChange={e => setQ(e.target.value)} />
            <div className="flex flex-wrap gap-1.5">{TYPES.map(t => <button key={t} onClick={() => toggle(t)} className={`rounded-md px-2 py-0.5 text-xs font-semibold border transition ${active.has(t) ? 'border-transparent' : 'border-line opacity-40'}`}><Badge tone={tone[t]}>{t}</Badge></button>)}
              <button className="text-xs text-net font-semibold ml-2" onClick={() => setActive(new Set(TYPES))}>all</button><button className="text-xs text-net font-semibold" onClick={() => setActive(new Set())}>none</button></div>
          </div>
          <div ref={box} className="h-[520px] overflow-auto border-t border-line">
            {rows.length === 0 ? <Empty text="No matching events" hint="Perform an operation or loosen the filters." /> : (
              <table><tbody>{rows.map(e => <tr key={e.id}><td className="num text-mute w-[150px]">{e.time.slice(11)}</td><td className="w-[88px]"><Badge tone={tone[e.type]}>{e.type}</Badge></td><td className="num !whitespace-normal break-all">{e.msg}</td></tr>)}</tbody></table>)}
          </div>
          <div className="px-4 py-2 text-[11px] text-mute border-t border-line">Showing {rows.length} of {live.events.length} buffered events · the server also writes CLIENT, SERVER, CONFIG and ERROR events to data/kvstore.log</div>
        </Card>
      ) : !s ? <Empty text="No statistics yet" /> : (
        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
          {Object.entries(s as Record<string, any>).map(([sec, vals]) => (
            <Card key={sec} title={({ cpu: 'CPU scheduling', disk: 'Disk scheduling', buffer_pool: 'Buffer pool', queue: 'Request queue', clients: 'Client connections', sync: 'Synchronization', requests: 'Requests', workers: 'Worker threads', server: 'Server' } as any)[sec] || sec} icon={<BarChart3 size={16} />}
              accent={({ cpu: 'cpu', disk: 'disk', buffer_pool: 'mem', sync: 'sync' } as any)[sec] || 'net'} pad={false}>
              <table><tbody>{Object.entries(vals as Record<string, any>).filter(([, v]) => typeof v !== 'object').map(([k, v]) => <tr key={k}><td className="text-mute">{k.replace(/_/g, ' ')}</td><td className="num text-right font-semibold">{typeof v === 'number' ? (Number.isInteger(v) ? v.toLocaleString() : v.toFixed(3)) : String(v)}</td></tr>)}
                {Object.entries(vals as Record<string, any>).filter(([, v]) => typeof v === 'object' && !Array.isArray(v)).map(([k, v]) => <tr key={k}><td className="text-mute align-top">{k.replace(/_/g, ' ')}</td><td className="num text-right text-xs">{Object.entries(v as any).map(([a, b]: any) => <div key={a}>{a}: {typeof b === 'object' ? `n=${b.n} wait=${Math.round(b.avg_wait_us)}µs tat=${Math.round(b.avg_turnaround_us)}µs` : String(b)}</div>)}</td></tr>)}</tbody></table>
            </Card>))}
        </div>)}
    </div>
  )
}
