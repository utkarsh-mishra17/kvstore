import { useCallback, useEffect, useMemo, useState } from 'react'
import { Database, Play, RefreshCw, Search, Sprout, Trash2, Eye, Terminal } from 'lucide-react'
import { Badge, Btn, Card, Empty, ErrorBox, Field, Seg, Stat, useAction } from '../components/ui'
import { cmd } from '../lib/api'
import { useApp } from '../lib/store'
import { us } from '../lib/fmt'
import { api } from '../lib/api'

type Op = 'SET' | 'GET' | 'DEL' | 'LIST' | 'MSET' | 'STATS'
type Result = { command: string; status: string; ok: boolean; lines: string[]; meta: Record<string, string>; latency_ms: number; at: string }

export default function Explorer() {
  const { toast, live } = useApp()
  const [op, setOp] = useState<Op>('SET')
  const [key, setKey] = useState('username')
  const [value, setValue] = useState('Utkarsh')
  const [pairs, setPairs] = useState('city Noida\ncollege JIIT\nbatch F14')
  const [prio, setPrio] = useState(1)
  const [result, setResult] = useState<Result | null>(null)
  const [history, setHistory] = useState<Result[]>([])
  const [rows, setRows] = useState<{ key: string; value: string }[]>([])
  const [filter, setFilter] = useState('')
  const [err, setErr] = useState('')
  const { busy, run } = useAction(toast)

  const exec = useCallback(async (command: string, silent = false): Promise<Result | null> => {
    setErr('')
    try {
      const r = await cmd(command)
      const res: Result = { ...r, at: new Date().toLocaleTimeString() }
      if (!silent) { setResult(res); setHistory(h => [res, ...h].slice(0, 25)) }
      return res
    } catch (e: any) { setErr(e.message); toast('err', e.message); return null }
  }, [toast])

  const refresh = useCallback(async () => {
    const r = await exec('LIST', true)
    if (r?.ok) setRows(r.lines.slice(1).map(l => { const i = l.indexOf(' '); return { key: l.slice(0, i), value: l.slice(i + 1) } }))
  }, [exec])
  useEffect(() => { if (live.connected) refresh() }, [live.connected])  // eslint-disable-line

  const build = () => {
    const p = prio > 1 ? `@prio=${prio} ` : ''
    switch (op) {
      case 'SET': return `${p}SET ${key.trim()} ${value}`
      case 'GET': return `${p}GET ${key.trim()}`
      case 'DEL': return `${p}DEL ${key.trim()}`
      case 'LIST': return `${p}LIST`
      case 'STATS': return 'STATS'
      case 'MSET': return `${p}MSET ` + pairs.split('\n').map(l => l.trim()).filter(Boolean).map(l => { const t = l.split(/\s+/); return `${t[0]} ${t.slice(1).join('_')}` }).join(' ')
    }
  }
  const submit = () => run(async () => {
    const r = await exec(build())
    if (r) { toast(r.ok ? 'ok' : 'err', `${op}: ${r.lines[0] || r.status}`); if (['SET', 'DEL', 'MSET'].includes(op)) refresh() }
  })
  const filtered = useMemo(() => rows.filter(r => (r.key + r.value).toLowerCase().includes(filter.toLowerCase())), [rows, filter])
  const m = result?.meta || {}

  return (
    <div className="grid xl:grid-cols-5 gap-4">
      <div className="xl:col-span-2 space-y-4">
        <Card title="Run an operation" icon={<Terminal size={16} />}>
          <div className="space-y-4">
            <Seg value={op} onChange={setOp} options={(['SET', 'GET', 'DEL', 'LIST', 'MSET', 'STATS'] as Op[]).map(v => ({ v, label: v }))} />
            {(op === 'SET' || op === 'GET' || op === 'DEL') && (
              <Field label="Key" hint="No spaces, up to 64 characters. The key is hashed to one of 200 disk blocks."><input className="w-full" value={key} onChange={e => setKey(e.target.value)} placeholder="username" /></Field>
            )}
            {op === 'SET' && <Field label="Value" hint="Up to 256 characters; spaces allowed."><input className="w-full" value={value} onChange={e => setValue(e.target.value)} placeholder="Utkarsh" /></Field>}
            {op === 'MSET' && <Field label="Key / value pairs (one per line)" hint="All affected block locks are taken in ascending block order."><textarea rows={5} className="w-full num" value={pairs} onChange={e => setPairs(e.target.value)} /></Field>}
            {op !== 'STATS' && (
              <Field label="Request priority" hint="Only matters while the CPU policy is Priority.">
                <select value={prio} onChange={e => setPrio(Number(e.target.value))}><option value={1}>1 · Normal</option><option value={2}>2 · High</option><option value={3}>3 · Admin</option></select>
              </Field>
            )}
            <div className="flex items-center gap-3">
              <Btn onClick={submit} busy={busy} icon={<Play size={15} />}>Execute {op}</Btn>
              <code className="num text-xs text-mute truncate">{build()}</code>
            </div>
          </div>
        </Card>

        <Card title="Server response" icon={<Eye size={16} />} accent="good">
          {err && <ErrorBox text={err} />}
          {!result && !err && <Empty text="Nothing executed yet" hint="Pick an operation and press Execute. The exact bytes returned by the C++ server show up here." />}
          {result && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 flex-wrap"><Badge tone={result.ok ? 'good' : 'bad'}>{result.ok ? 'SUCCESS' : 'FAILED'}</Badge><Badge>{result.status}</Badge><span className="text-xs text-mute num">round trip {result.latency_ms.toFixed(2)} ms · {result.at}</span></div>
              <pre className="num text-sm rounded-lg bg-raised border border-line p-3 max-h-48 overflow-auto whitespace-pre-wrap break-all">{result.lines.join('\n') || '(empty)'}</pre>
              {m.id && (
                <div className="grid grid-cols-2 gap-2 text-xs">
                  {[['Request id', m.id], ['Worker', '#' + m.worker], ['Policy', m.policy + ' · dispatch #' + m.dispatch], ['Queue wait', us(+m.wait_us)], ['Service time', us(+m.service_us)], ['Turnaround', us(+m.turnaround_us)],
                    ['Cache', `${m.hits} hit · ${m.misses} miss`], ['Block locks', m.locks], ['Slices', m.slices + (+m.slices > 1 ? ' (time-sliced)' : '')], ['Priority / cost', `${m.prio} / ${m.cost}`]].map(([k, v]) => (
                    <div key={k} className="rounded-md bg-raised/70 px-2.5 py-1.5"><div className="text-mute">{k}</div><div className="num font-semibold">{v}</div></div>))}
                </div>)}
            </div>)}
        </Card>
      </div>

      <div className="xl:col-span-3 space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <Stat label="Stored keys" value={rows.length} sub="from the last LIST" icon={<Database size={15} />} />
          <Stat label="Blocks in use" value={new Set(rows.map(r => r.key)).size ? rows.length : 0} sub="keys hash to 200 blocks" accent="disk" />
          <Stat label="Operations this session" value={history.length} sub="newest 25 kept" accent="cpu" />
        </div>
        <Card title="Keys" icon={<Database size={16} />} pad={false}
          action={<div className="flex items-center gap-2">
            <div className="relative"><Search size={14} className="absolute left-2.5 top-2.5 text-mute" /><input className="pl-8 w-44" placeholder="Search keys or values" value={filter} onChange={e => setFilter(e.target.value)} /></div>
            <Btn tone="ghost" icon={<RefreshCw size={14} />} onClick={refresh} title="Run LIST again">Refresh</Btn>
            <Btn tone="ghost" icon={<Sprout size={14} />} onClick={() => run(async () => { await api('/seed?count=50', {}); await refresh() }, 'Seeded 50 demo keys')}>Seed demo data</Btn>
          </div>}>
          {filtered.length === 0 ? <Empty text={rows.length ? 'No keys match the search' : 'The store is empty'} hint={rows.length ? undefined : 'Add a key with SET, or seed demo data.'} /> : (
            <div className="max-h-[360px] overflow-auto px-2 pb-2"><table><thead><tr><th>Key</th><th>Value</th><th>Block</th><th /></tr></thead><tbody>
              {filtered.map(r => (
                <tr key={r.key}><td className="num font-semibold">{r.key}</td><td className="num max-w-[280px] truncate">{r.value}</td><td className="num text-mute">{blockOf(r.key)}</td>
                  <td className="text-right space-x-1"><button className="text-net text-xs font-semibold" onClick={() => { setOp('GET'); setKey(r.key); exec('GET ' + r.key) }}>GET</button>
                    <button className="text-bad p-1" aria-label={'Delete ' + r.key} onClick={async () => { const x = await exec('DEL ' + r.key); if (x?.ok) { toast('ok', 'Deleted ' + r.key); refresh() } }}><Trash2 size={14} /></button></td></tr>))}
            </tbody></table></div>)}
        </Card>
        <Card title="Operation history" icon={<Terminal size={16} />} pad={false}>
          {history.length === 0 ? <Empty text="No operations yet" /> : (
            <div className="max-h-60 overflow-auto px-2 pb-2"><table><thead><tr><th>Time</th><th>Command</th><th>Result</th><th>Wait</th><th>Service</th><th>Cache</th></tr></thead><tbody>
              {history.map((h, i) => (<tr key={i}><td className="num text-mute">{h.at}</td><td className="num max-w-[220px] truncate">{h.command}</td><td><Badge tone={h.ok ? 'good' : 'bad'}>{h.lines[0]?.slice(0, 26) || h.status}</Badge></td>
                <td className="num">{h.meta.wait_us ? us(+h.meta.wait_us) : '–'}</td><td className="num">{h.meta.service_us ? us(+h.meta.service_us) : '–'}</td><td className="num">{h.meta.hits ? `${h.meta.hits}H/${h.meta.misses}M` : '–'}</td></tr>))}
            </tbody></table></div>)}
        </Card>
      </div>
    </div>
  )
}

// Same FNV-1a hash as the C++ server (only used to label rows; placement itself is done by the server).
function blockOf(key: string) {
  let h = 2166136261
  for (const b of new TextEncoder().encode(key)) { h ^= b; h = Math.imul(h, 16777619) >>> 0 }
  return h % 200
}
