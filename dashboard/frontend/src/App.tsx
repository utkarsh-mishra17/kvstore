import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Activity, Bell, Boxes, Cpu, Database, FlaskConical, HardDrive, Layers, Menu, MemoryStick, Moon, ScrollText, Settings as Cog, Sun, Gauge, Waypoints, X, CheckCircle2, AlertCircle, Info, Lock } from 'lucide-react'
import { useApp } from './lib/store'
import { uptime } from './lib/fmt'
import Overview from './pages/Overview'
import Explorer from './pages/Explorer'
import CpuPage from './pages/CpuPage'
import DiskPage from './pages/DiskPage'
import MemoryPage from './pages/MemoryPage'
import SyncPage from './pages/SyncPage'
import BenchmarkPage from './pages/BenchmarkPage'
import LogsPage from './pages/LogsPage'
import ArchitecturePage from './pages/ArchitecturePage'
import TestsPage from './pages/TestsPage'
import SettingsPage from './pages/SettingsPage'

const NAV = [
  { id: 'overview', label: 'Overview', icon: Gauge, dot: 'bg-net', el: Overview },
  { id: 'explorer', label: 'Key-Value Explorer', icon: Database, dot: 'bg-net', el: Explorer },
  { id: 'cpu', label: 'CPU Scheduling', icon: Cpu, dot: 'bg-cpu', el: CpuPage },
  { id: 'disk', label: 'Disk Scheduling', icon: HardDrive, dot: 'bg-disk', el: DiskPage },
  { id: 'memory', label: 'Memory Management', icon: MemoryStick, dot: 'bg-mem', el: MemoryPage },
  { id: 'sync', label: 'Synchronization', icon: Lock, dot: 'bg-sync', el: SyncPage },
  { id: 'bench', label: 'Benchmark & Load', icon: Activity, dot: 'bg-net', el: BenchmarkPage },
  { id: 'tests', label: 'Validation Tests', icon: FlaskConical, dot: 'bg-good', el: TestsPage },
  { id: 'logs', label: 'System Logs', icon: ScrollText, dot: 'bg-net', el: LogsPage },
  { id: 'arch', label: 'Architecture', icon: Layers, dot: 'bg-net', el: ArchitecturePage },
  { id: 'settings', label: 'Settings', icon: Cog, dot: 'bg-mute', el: SettingsPage },
]

export default function App() {
  const { live, theme, toggleTheme, toasts, dismiss, notes } = useApp()
  const [page, setPage] = useState(location.hash.slice(1) || 'overview')
  const [menu, setMenu] = useState(false)
  const [bell, setBell] = useState(false)
  useEffect(() => { location.hash = page }, [page])
  useEffect(() => { const h = () => setPage(location.hash.slice(1) || 'overview'); window.addEventListener('hashchange', h); return () => window.removeEventListener('hashchange', h) }, [])
  const cur = NAV.find(n => n.id === page) || NAV[0]
  const Page = cur.el
  const s = live.stats

  return (
    <div className="h-full flex">
      {/* sidebar */}
      <aside className={`fixed md:static z-40 inset-y-0 left-0 w-60 shrink-0 border-r border-line bg-panel flex flex-col transition-transform ${menu ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}`}>
        <div className="h-14 flex items-center gap-2.5 px-4 border-b border-line">
          <div className="grid place-items-center h-8 w-8 rounded-lg bg-net text-[#0b1020]"><Boxes size={18} strokeWidth={2.4} /></div>
          <div className="leading-tight">
            <div className="font-extrabold tracking-tight">KVStore</div>
            <div className="text-[11px] text-mute">OS concepts console</div>
          </div>
        </div>
        <nav className="flex-1 overflow-y-auto p-2.5 space-y-0.5">
          {NAV.map(n => (
            <button key={n.id} onClick={() => { setPage(n.id); setMenu(false) }}
              className={`w-full flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-semibold transition ${page === n.id ? 'bg-raised text-ink' : 'text-mute hover:text-ink hover:bg-raised/60'}`}>
              <n.icon size={17} />
              <span className="flex-1 text-left">{n.label}</span>
              <span className={`h-1.5 w-1.5 rounded-full ${n.dot} ${page === n.id ? '' : 'opacity-40'}`} />
            </button>
          ))}
        </nav>
        <div className="p-3 border-t border-line text-[11px] text-mute leading-relaxed">
          JIIT Noida · CSE &amp; IT<br />Operating Systems project · 2026–27
        </div>
      </aside>
      {menu && <div className="fixed inset-0 z-30 bg-black/50 md:hidden" onClick={() => setMenu(false)} />}

      <div className="flex-1 min-w-0 flex flex-col">
        {/* top bar */}
        <header className="h-14 shrink-0 flex items-center gap-4 px-4 border-b border-line bg-panel/80 backdrop-blur">
          <button className="md:hidden" onClick={() => setMenu(true)} aria-label="Open menu"><Menu size={20} /></button>
          <h1 className="font-bold text-[15px] hidden sm:block">{cur.label}</h1>
          <div className="flex-1" />
          <div className={`flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold border ${live.connected ? 'border-good/40 bg-good/10 text-good' : 'border-bad/40 bg-bad/10 text-bad'}`}>
            <span className={`h-2 w-2 rounded-full ${live.connected ? 'bg-good live-dot' : 'bg-bad'}`} />
            {live.connected ? 'Server connected' : live.ready ? 'Disconnected' : 'Connecting…'}
          </div>
          <div className="hidden md:flex items-center gap-5 text-xs text-mute">
            <span>Uptime <b className="num text-ink">{uptime(s?.server.uptime_s)}</b></span>
            <span>Clients <b className="num text-ink">{s?.clients.active ?? '–'}</b></span>
          </div>
          <div className="relative">
            <button onClick={() => setBell(b => !b)} className="relative p-1.5 rounded-md hover:bg-raised" aria-label="Notifications">
              <Bell size={18} />
              {notes.length > 0 && <span className="absolute -top-0.5 -right-0.5 grid place-items-center h-4 min-w-4 px-1 rounded-full bg-sync text-[10px] font-bold text-[#0b1020]">{Math.min(notes.length, 99)}</span>}
            </button>
            {bell && (
              <div className="absolute right-0 mt-2 w-80 max-h-96 overflow-auto rounded-xl border border-line bg-panel shadow-xl z-50">
                <div className="px-3 py-2 text-xs font-semibold text-mute border-b border-line">Notifications</div>
                {notes.length === 0 && <div className="p-4 text-sm text-mute">Nothing yet. Errors and action results show up here.</div>}
                {notes.map(n => (
                  <div key={n.id} className="px-3 py-2 text-xs border-b border-line/60 flex gap-2">
                    <span className={n.kind === 'err' ? 'text-bad' : n.kind === 'ok' ? 'text-good' : 'text-net'}>●</span>
                    <div className="min-w-0"><div className="break-words">{n.text}</div><div className="text-mute num">{n.time}</div></div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <button onClick={toggleTheme} className="p-1.5 rounded-md hover:bg-raised" aria-label="Toggle theme">{theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}</button>
        </header>

        <main className="flex-1 overflow-y-auto p-4 md:p-6">
          {!live.connected && live.ready && page !== 'settings' && page !== 'arch' && page !== 'tests' && (
            <div className="mb-4 rounded-xl border border-bad/40 bg-bad/10 p-4 text-sm">
              <div className="font-bold text-bad flex items-center gap-2"><Waypoints size={16} /> KVStore server is not reachable</div>
              <div className="mt-1 text-mute">{live.error || 'Waiting for the C++ server.'} Start it with <code className="num text-ink">./build/kvserver --port 7070</code> (or <code className="num text-ink">./start.sh</code>). This page reconnects automatically.</div>
            </div>
          )}
          <Page key={cur.id} go={setPage} />
        </main>
      </div>

      {/* toasts */}
      <div className="fixed bottom-4 right-4 z-50 space-y-2 w-80 max-w-[90vw]">
        <AnimatePresence>
          {toasts.map(t => (
            <motion.div key={t.id} initial={{ opacity: 0, x: 40 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 40 }}
              className="flex items-start gap-2.5 rounded-xl border border-line bg-panel px-3.5 py-2.5 shadow-xl text-sm">
              {t.kind === 'ok' ? <CheckCircle2 size={17} className="text-good mt-0.5" /> : t.kind === 'err' ? <AlertCircle size={17} className="text-bad mt-0.5" /> : <Info size={17} className="text-net mt-0.5" />}
              <div className="flex-1 break-words">{t.text}</div>
              <button onClick={() => dismiss(t.id)} aria-label="Dismiss"><X size={14} className="text-mute" /></button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  )
}
