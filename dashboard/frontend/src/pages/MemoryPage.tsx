import { useEffect, useRef, useState } from 'react'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { MemoryStick, Pause, Play, RotateCcw, SkipForward, Layers } from 'lucide-react'
import { Badge, Btn, Card, Empty, Field, Note, NumIn, Seg, Stat, hex, useAction } from '../components/ui'
import { api } from '../lib/api'
import { useApp } from '../lib/store'
import { cacheAlgs, n0, pct } from '../lib/fmt'

const tt = { contentStyle: { background: 'rgb(var(--panel))', border: '1px solid rgb(var(--line))', borderRadius: 8, fontSize: 12 } }
const grid = <CartesianGrid stroke="rgb(var(--line))" strokeDasharray="3 3" vertical={false} />

export default function MemoryPage() {
  const { live, toast } = useApp()
  const { busy, run } = useAction(toast)
  const [frames, setFrames] = useState(8)
  const s = live.stats
  if (!s) return <Empty text="Waiting for server data" />
  const b = s.buffer_pool
  const pool = live.pool
  const hist = pool?.history ? [...pool.history].reverse().slice(0, 30) : []
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
        <Stat accent="mem" label="Total frames" value={b.frames} sub="4 KB each" icon={<MemoryStick size={15} />} />
        <Stat accent="mem" label="Occupied / free" value={`${b.occupied} / ${b.free}`} />
        <Stat accent="mem" label="Hit ratio" value={pct(b.hit_ratio)} sub={`${n0(b.hits)} hits`} />
        <Stat accent="mem" label="Page faults (misses)" value={n0(b.page_faults)} sub={`${n0(b.evictions)} evictions`} />
        <Stat accent="mem" label="Dirty pages" value={b.dirty} sub="awaiting write-back" />
        <Stat accent="mem" label="Write-backs" value={n0(b.writebacks)} sub="dirty evictions to data.db" />
      </div>

      <Card title="Live server buffer pool" icon={<Layers size={16} />} accent="mem" action={<Badge tone="mem">{b.policy}</Badge>}>
        <div className="space-y-4">
          <div className="flex flex-wrap gap-4 items-end">
            <Seg accent="mem" value={b.policy.toLowerCase()} onChange={p => run(() => api('/config', { cache_policy: p }), `Replacement policy: ${p.toUpperCase()}`)} options={cacheAlgs.map(a => ({ v: a, label: a.toUpperCase() }))} />
            <Field label="Number of frames (2–128)"><NumIn value={frames} onChange={setFrames} min={2} max={128} /></Field>
            <Btn tone="ghost" busy={busy} onClick={() => run(() => api('/config', { frames }), `Pool resized to ${frames} frames (dirty frames flushed first)`)}>Resize pool</Btn>
            <Btn tone="ghost" busy={busy} onClick={() => run(() => api('/admin/flush', {}), 'Dirty frames flushed to data.db')}>Flush dirty frames</Btn>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
            {(pool?.frames || []).map((f: any) => (
              <div key={f.index} className={`rounded-xl border p-2.5 transition ${f.block < 0 ? 'border-dashed border-line' : f.dirty ? 'border-sync/70 bg-sync/10' : 'border-mem/60 bg-mem/10'}`}>
                <div className="flex justify-between text-[10px] text-mute"><span>frame {f.index}</span>{pool.policy === 'CLOCK' && pool.hand === f.index && <span className="text-cpu font-bold">▶ hand</span>}</div>
                <div className="num text-xl font-semibold">{f.block < 0 ? 'free' : 'blk ' + f.block}</div>
                <div className="flex gap-1 mt-1 flex-wrap">{f.dirty && <Badge tone="sync">dirty</Badge>}{f.ref && f.block >= 0 && <Badge tone="cpu">ref</Badge>}{f.pinned > 0 && <Badge tone="net">pinned</Badge>}</div>
              </div>))}
          </div>
          <div>
            <div className="text-xs font-semibold text-mute mb-1">Page replacement history (newest first)</div>
            {hist.length === 0 ? <Empty text="No replacements yet" hint="Replacement starts once more blocks are touched than there are frames (try LIST)." /> : (
              <div className="max-h-52 overflow-auto"><table><thead><tr><th>#</th><th>Policy</th><th>Evicted block</th><th>Loaded block</th><th>Write-back</th></tr></thead><tbody>
                {hist.map((h: any) => <tr key={h.seq}><td className="num text-mute">{h.seq}</td><td>{h.policy}</td><td className="num">{h.victim}</td><td className="num font-semibold">{h.incoming}</td><td>{h.dirty ? <Badge tone="sync">written to data.db</Badge> : <span className="text-mute">clean, dropped</span>}</td></tr>)}</tbody></table></div>)}
          </div>
        </div>
      </Card>
      <PageSim />
    </div>
  )
}

function PageSim() {
  const { toast } = useApp()
  const { busy, run } = useAction(toast)
  const [policy, setPolicy] = useState('lru')
  const [frames, setFrames] = useState(3)
  const [refText, setRefText] = useState('7, 0, 1, 2, 0, 3, 0, 4')
  const [res, setRes] = useState<any>(null)
  const [cmp, setCmp] = useState<any>(null)
  const [step, setStep] = useState(-1)
  const [play, setPlay] = useState(false)
  const timer = useRef<any>(null)
  const refs = refText.split(/[\s,]+/).filter(Boolean)
  const valid = refs.length > 0 && refs.length <= 200 && refs.every(r => /^\d{1,5}[wW]?$/.test(r))

  const exec = () => run(async () => {
    const body = { policy, frames, refs }
    const [r, c] = await Promise.all([api('/sim/pages', body), api('/sim/pages/compare', body)])
    setRes(r); setCmp(c); setStep(-1); setPlay(true)
  })
  useEffect(() => {
    clearInterval(timer.current)
    if (play && res) timer.current = setInterval(() => setStep(s => { if (s >= res.steps.length - 1) { setPlay(false); return s } return s + 1 }), 800)
    return () => clearInterval(timer.current)
  }, [play, res])

  const cur = res && step >= 0 ? res.steps[step] : null
  const done = res ? res.steps.slice(0, step + 1) : []
  const faultsSoFar = done.filter((x: any) => !x.hit).length
  return (
    <Card title="Page-replacement demonstration" icon={<MemoryStick size={16} />} accent="mem">
      <Note tone="mem">This is an interactive demonstration: your reference string is run through the C++ <code className="num">simulate_pages()</code>, which uses the same <code className="num">choose_victim()</code> code as the live buffer pool above. Append <b>w</b> to a page (e.g. <code className="num">3w</code>) to make it a write, which marks the frame dirty and triggers a write-back on eviction. The numbers above are the real server pool; these are not.</Note>
      <div className="flex flex-wrap items-end gap-4 mt-4">
        <Field label="Algorithm"><Seg accent="mem" value={policy} onChange={setPolicy} options={cacheAlgs.map(a => ({ v: a, label: a.toUpperCase() }))} /></Field>
        <Field label="Frames"><NumIn value={frames} onChange={setFrames} min={1} max={64} /></Field>
        <div className="flex-1 min-w-[240px]"><Field label="Reference string"><input className="w-full num" value={refText} onChange={e => setRefText(e.target.value)} /></Field></div>
      </div>
      {!valid && <p className="text-xs text-bad mt-1">Use whole numbers separated by commas or spaces (max 200), optionally ending in w.</p>}
      <div className="flex gap-2 mt-3 flex-wrap"><Btn busy={busy} disabled={!valid} onClick={exec} icon={<Play size={14} />}>Run</Btn>
        {res && <><Btn tone="ghost" icon={play ? <Pause size={14} /> : <Play size={14} />} onClick={() => setPlay(p => !p)}>{play ? 'Pause' : 'Play'}</Btn>
          <Btn tone="ghost" icon={<SkipForward size={14} />} onClick={() => { setPlay(false); setStep(s => Math.min(res.steps.length - 1, s + 1)) }}>Step</Btn>
          <Btn tone="ghost" icon={<RotateCcw size={14} />} onClick={() => { setPlay(false); setStep(-1) }}>Reset</Btn></>}</div>

      {res && (
        <div className="mt-5 space-y-5">
          <div className="grid lg:grid-cols-3 gap-4 items-start">
            <div>
              <div className="text-xs text-mute mb-2">Frames after reference {step + 1} of {res.steps.length}{cur ? `: page ${cur.page}${cur.write ? ' (write)' : ''}` : ''}</div>
              <div className="flex gap-2 flex-wrap">{Array.from({ length: res.frames }, (_, i) => {
                const page = cur ? cur.frames[i] : -1; const isNew = cur && !cur.hit && page === cur.page; const hitFrame = cur && cur.hit && page === cur.page
                return (<div key={i} className={`h-20 w-20 rounded-xl border-2 grid place-items-center text-center transition ${page < 0 ? 'border-dashed border-line text-mute' : isNew ? 'border-bad bg-bad/15' : hitFrame ? 'border-good bg-good/15' : 'border-mem/50 bg-mem/10'}`}>
                  <div><div className="num text-2xl font-bold">{page < 0 ? '–' : page}</div><div className="text-[10px] text-mute">{cur && cur.dirty[i] && page >= 0 ? 'dirty ' : ''}{res.policy === 'CLOCK' && cur && cur.frames[i] >= 0 ? `ref=${cur.refbits[i]}` : ''}</div></div></div>)
              })}</div>
              {cur && <div className="mt-3 flex gap-2 flex-wrap">{cur.hit ? <Badge tone="good">page hit</Badge> : <Badge tone="bad">page fault</Badge>}{cur.victim >= 0 && <Badge tone="cpu">replaced page {cur.victim}</Badge>}{cur.writeback && <Badge tone="sync">dirty write-back of page {cur.victim}</Badge>}{res.policy === 'CLOCK' && <Badge tone="mem">hand → frame {cur.hand}</Badge>}</div>}
              <div className="grid grid-cols-3 gap-2 mt-4"><Stat accent="mem" label="Faults" value={faultsSoFar} /><Stat accent="mem" label="Hits" value={done.length - faultsSoFar} /><Stat accent="mem" label="Write-backs" value={done.filter((x: any) => x.writeback).length} /></div>
            </div>
            <div className="lg:col-span-2 overflow-x-auto">
              <table className="text-center"><thead><tr><th className="!text-left">Ref</th>{res.steps.map((x: any, i: number) => <th key={i} className={`!text-center num ${i === step ? 'text-ink' : ''}`}>{x.page}{x.write ? 'w' : ''}</th>)}</tr></thead><tbody>
                {Array.from({ length: res.frames }, (_, f) => <tr key={f}><td className="!text-left text-mute">frame {f}</td>{res.steps.map((x: any, i: number) => <td key={i} className={`num ${i > step ? 'opacity-0' : ''} ${i === step ? 'bg-mem/20' : ''}`}>{x.frames[f] < 0 ? '' : x.frames[f]}</td>)}</tr>)}
                <tr><td className="!text-left text-mute">result</td>{res.steps.map((x: any, i: number) => <td key={i} className={`font-bold ${i > step ? 'opacity-0' : x.hit ? 'text-good' : 'text-bad'}`}>{x.hit ? 'H' : x.writeback ? 'F+W' : 'F'}</td>)}</tr></tbody></table>
            </div>
          </div>
          {cmp && (
            <div className="grid lg:grid-cols-2 gap-5">
              <div className="h-52"><ResponsiveContainer><BarChart data={Object.values(cmp).map((r: any) => ({ name: r.policy, faults: r.faults, hits: r.hits }))}>{grid}<XAxis dataKey="name" /><YAxis allowDecimals={false} width={30} /><Tooltip {...tt} cursor={{ fill: 'rgb(var(--raised))' }} /><Legend />
                <Bar dataKey="faults" fill={hex.bad} radius={3} name="page faults" /><Bar dataKey="hits" fill={hex.good} radius={3} name="hits" /></BarChart></ResponsiveContainer></div>
              <table><thead><tr><th>Algorithm</th><th>Faults</th><th>Hits</th><th>Hit ratio</th><th>Write-backs</th></tr></thead><tbody>
                {Object.values(cmp).map((r: any) => <tr key={r.policy}><td className="font-semibold">{r.policy}</td><td className="num">{r.faults}</td><td className="num">{r.hits}</td><td className="num">{pct(r.hit_ratio)}</td><td className="num">{r.writebacks}</td></tr>)}</tbody></table>
            </div>)}
        </div>)}
    </Card>
  )
}
