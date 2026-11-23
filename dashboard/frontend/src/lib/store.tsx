import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, ReactNode } from 'react'
import { api } from './api'

export type Live = {
  connected: boolean; ready: boolean; error?: string
  stats?: any; snapshot?: any; pool?: any
  history: any[]; events: any[]; reqs: any[]; gantt: any[]; disklog: any[]
}
const empty: Live = { connected: false, ready: false, history: [], events: [], reqs: [], gantt: [], disklog: [] }
const cap = (a: any[], n: number) => (a.length > n ? a.slice(a.length - n) : a)

type Toast = { id: number; kind: 'ok' | 'err' | 'info'; text: string }
type Ctx = { live: Live; toast: (kind: Toast['kind'], text: string) => void; toasts: Toast[]; dismiss: (id: number) => void; theme: 'dark' | 'light'; toggleTheme: () => void; notes: any[] }
const C = createContext<Ctx>(null as any)
export const useApp = () => useContext(C)
export const useLive = () => useContext(C).live

export function AppProvider({ children }: { children: ReactNode }) {
  const [live, setLive] = useState<Live>(empty)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [theme, setTheme] = useState<'dark' | 'light'>((localStorage.getItem('kv-theme') as any) || 'dark')
  const [notes, setNotes] = useState<any[]>([])
  const idRef = useRef(1)

  const toast = useCallback((kind: Toast['kind'], text: string) => {
    const id = idRef.current++
    setToasts(t => [...t, { id, kind, text }])
    setNotes(n => [{ id, kind, text, time: new Date().toLocaleTimeString() }, ...n].slice(0, 40))
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 4500)
  }, [])
  const dismiss = (id: number) => setToasts(t => t.filter(x => x.id !== id))

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    localStorage.setItem('kv-theme', theme)
  }, [theme])

  useEffect(() => {
    let ws: WebSocket | null = null, stop = false, retry: any
    const boot = async () => {
      try {
        const b = await api('/bootstrap')
        setLive(l => ({ ...l, ...b, ready: true, history: b.history ?? [], events: b.events ?? [], reqs: b.reqs ?? [], gantt: b.gantt ?? [], disklog: b.disklog ?? [] }))
      } catch { setLive(l => ({ ...l, ready: true, connected: false, error: 'Dashboard API unreachable' })) }
    }
    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      ws = new WebSocket(`${proto}://${location.host}/ws`)
      ws.onopen = () => boot()
      ws.onmessage = ev => {
        const m = JSON.parse(ev.data)
        if (!m.connected) { setLive(l => ({ ...l, connected: false, ready: true, error: m.error })); return }
        const errs = (m.events || []).filter((e: any) => e.type === 'ERROR')
        if (errs.length) setNotes(n => [...errs.map((e: any) => ({ id: 'e' + e.id, kind: 'err', text: e.msg, time: e.time.slice(11, 19) })), ...n].slice(0, 40))
        setLive(l => ({
          ...l, connected: true, ready: true, error: undefined, stats: m.stats, snapshot: m.snapshot, pool: m.pool,
          history: cap([...l.history, m.point], 600), events: cap([...l.events, ...m.events], 2500), reqs: cap([...l.reqs, ...m.reqs], 800),
          gantt: cap([...l.gantt, ...m.gantt], 800), disklog: cap([...l.disklog, ...m.disklog], 600),
        }))
      }
      ws.onclose = () => { setLive(l => ({ ...l, connected: false })); if (!stop) retry = setTimeout(connect, 1500) }
      ws.onerror = () => ws?.close()
    }
    connect()
    return () => { stop = true; clearTimeout(retry); ws?.close() }
  }, [])

  const value = useMemo(() => ({ live, toast, toasts, dismiss, theme, toggleTheme: () => setTheme(t => (t === 'dark' ? 'light' : 'dark')), notes }), [live, toasts, theme, notes, toast])
  return <C.Provider value={value}>{children}</C.Provider>
}
