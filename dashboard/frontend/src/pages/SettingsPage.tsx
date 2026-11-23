import { useState } from 'react'
import { Moon, RefreshCcw, Server, Settings, Sprout, Sun, Trash2, Save, Lock } from 'lucide-react'
import { Btn, Card, Field, Note, NumIn, Seg, useAction } from '../components/ui'
import { api } from '../lib/api'
import { useApp } from '../lib/store'

export default function SettingsPage() {
  const { live, toast, theme, toggleTheme } = useApp()
  const { busy, run } = useAction(toast)
  const s = live.stats
  const [head, setHead] = useState(0)
  const [hold, setHold] = useState(0)
  const [seed, setSeed] = useState(50)
  return (
    <div className="grid lg:grid-cols-2 gap-4">
      <Card title="Appearance" icon={<Settings size={16} />}>
        <Seg value={theme} onChange={() => toggleTheme()} options={[{ v: 'dark', label: 'Dark' }, { v: 'light', label: 'Light' }]} />
        <span className="ml-3 inline-flex align-middle text-mute">{theme === 'dark' ? <Moon size={16} /> : <Sun size={16} />}</span>
      </Card>
      <Card title="Server connection" icon={<Server size={16} />} accent="good">
        <div className="text-sm space-y-1.5"><div>Status: <b className={live.connected ? 'text-good' : 'text-bad'}>{live.connected ? 'connected' : 'disconnected'}</b></div>
          <div>TCP endpoint: <span className="num">127.0.0.1:{s?.server.port ?? 7070}</span> (set <span className="num">KV_HOST</span>/<span className="num">KV_PORT</span> for the API layer)</div>
          <div>Data file: <span className="num">{s?.server.data_file ?? '–'}</span> · {s?.server.num_blocks} blocks × {s?.server.block_size} bytes</div></div>
        <div className="mt-4 flex gap-2 flex-wrap">
          <Btn tone="ghost" icon={<RefreshCcw size={14} />} busy={busy} onClick={() => run(() => api('/server/restart', {}), 'Server restarted gracefully: data reloaded from data.db')}>Restart server (persistence demo)</Btn></div>
        <p className="text-[11px] text-mute mt-2">Sends SHUTDOWN (dirty frames are flushed), then starts a fresh server process on the same data file.</p>
      </Card>
      <Card title="Data" icon={<Sprout size={16} />}>
        <div className="flex items-end gap-3 flex-wrap"><Field label="Demo keys to insert"><NumIn value={seed} onChange={setSeed} min={1} max={500} /></Field>
          <Btn busy={busy} icon={<Sprout size={14} />} onClick={() => run(() => api(`/seed?count=${seed}`, {}), `Inserted ${seed} demo keys`)}>Seed</Btn>
          <Btn tone="ghost" busy={busy} icon={<Save size={14} />} onClick={() => run(() => api('/admin/flush', {}), 'Dirty frames flushed')}>Flush to disk</Btn>
          <Btn tone="danger" busy={busy} icon={<Trash2 size={14} />} onClick={() => run(() => api('/admin/reset', {}), 'Statistics reset (stored data untouched)')}>Reset statistics</Btn></div>
      </Card>
      <Card title="Synchronization knobs" icon={<Lock size={16} />} accent="sync">
        <div className="space-y-3">
          <Seg accent="sync" value={s?.sync.ordered_locking ? 'on' : 'off'} onChange={v => run(() => api('/config', { lock_ordered: v === 'on' }), `Ascending lock order ${v}`)} options={[{ v: 'on', label: 'Ordered MSET locking' }, { v: 'off', label: 'Unordered (unsafe)' }]} />
          <div className="flex items-end gap-3"><Field label="Hold between MSET lock acquisitions (µs)"><NumIn value={hold} onChange={setHold} min={0} max={2000000} /></Field><Btn tone="ghost" busy={busy} onClick={() => run(() => api('/config', { lock_hold_us: hold }), 'Lock hold delay applied')}>Apply</Btn></div>
          <div className="flex items-end gap-3"><Field label="Move disk head to track"><NumIn value={head} onChange={setHead} min={0} max={199} /></Field><Btn tone="ghost" busy={busy} onClick={() => run(() => api('/config', { disk_head: head }), `Head moved to ${head}`)}>Apply</Btn></div>
          <Note tone="sync">Unordered mode exists only to demonstrate deadlock detection. Keep ordered locking on for normal use.</Note>
        </div>
      </Card>
    </div>
  )
}
