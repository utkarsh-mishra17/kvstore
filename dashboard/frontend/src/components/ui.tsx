import { ReactNode, useState } from 'react'
import { AlertTriangle, Loader2, Inbox } from 'lucide-react'

export const accentText: Record<string, string> = { cpu: 'text-cpu', disk: 'text-disk', mem: 'text-mem', sync: 'text-sync', net: 'text-net', good: 'text-good', bad: 'text-bad', mute: 'text-mute' }
export const accentBg: Record<string, string> = { cpu: 'bg-cpu', disk: 'bg-disk', mem: 'bg-mem', sync: 'bg-sync', net: 'bg-net', good: 'bg-good', bad: 'bg-bad', mute: 'bg-mute' }
export const hex: Record<string, string> = { cpu: '#f2b441', disk: '#35c4be', mem: '#a68bfa', sync: '#fb7185', net: '#6aa6ff', good: '#4ade80', bad: '#f87171' }

export function Card({ title, icon, accent = 'net', action, children, className = '', pad = true }: { title?: ReactNode; icon?: ReactNode; accent?: string; action?: ReactNode; children: ReactNode; className?: string; pad?: boolean }) {
  return (
    <section className={`rounded-xl border border-line bg-panel ${className}`}>
      {title && (
        <header className="flex items-center justify-between gap-3 px-4 pt-3.5 pb-1">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            {icon && <span className={accentText[accent]}>{icon}</span>}
            {title}
          </h3>
          {action}
        </header>
      )}
      <div className={pad ? 'p-4' : ''}>{children}</div>
    </section>
  )
}

export function Stat({ label, value, sub, accent = 'net', icon }: { label: string; value: ReactNode; sub?: ReactNode; accent?: string; icon?: ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-panel px-4 py-3 relative overflow-hidden">
      <span className={`absolute left-0 top-3 bottom-3 w-[3px] rounded-r ${accentBg[accent]}`} />
      <div className="flex items-center justify-between text-xs text-mute">
        <span>{label}</span>
        {icon && <span className={accentText[accent]}>{icon}</span>}
      </div>
      <div className="num text-2xl font-semibold mt-1 leading-none">{value}</div>
      {sub !== undefined && <div className="text-xs text-mute mt-1.5 truncate">{sub}</div>}
    </div>
  )
}

export function Badge({ children, tone = 'mute' }: { children: ReactNode; tone?: string }) {
  const m: Record<string, string> = {
    good: 'bg-good/15 text-good', bad: 'bg-bad/15 text-bad', cpu: 'bg-cpu/15 text-cpu', disk: 'bg-disk/15 text-disk', mem: 'bg-mem/15 text-mem',
    sync: 'bg-sync/15 text-sync', net: 'bg-net/15 text-net', mute: 'bg-raised text-mute',
  }
  return <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-semibold ${m[tone] || m.mute}`}>{children}</span>
}

export function Btn({ children, onClick, busy, tone = 'primary', disabled, icon, className = '', title }: { children?: ReactNode; onClick?: () => void; busy?: boolean; tone?: 'primary' | 'ghost' | 'danger'; disabled?: boolean; icon?: ReactNode; className?: string; title?: string }) {
  const t = { primary: 'bg-net text-[#0b1020] hover:brightness-110', ghost: 'bg-raised text-ink hover:bg-line/60 border border-line', danger: 'bg-bad/15 text-bad hover:bg-bad/25 border border-bad/30' }[tone]
  return (
    <button title={title} disabled={disabled || busy} onClick={onClick} className={`inline-flex items-center justify-center gap-2 rounded-md px-3.5 py-1.5 text-sm font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed ${t} ${className}`}>
      {busy ? <Loader2 size={15} className="animate-spin" /> : icon}
      {children}
    </button>
  )
}

export function Seg<T extends string>({ value, options, onChange, accent = 'net' }: { value: T; options: { v: T; label: string }[]; onChange: (v: T) => void; accent?: string }) {
  return (
    <div className="inline-flex rounded-lg bg-raised p-0.5 border border-line flex-wrap">
      {options.map(o => (
        <button key={o.v} onClick={() => onChange(o.v)} className={`px-3 py-1 text-sm rounded-md font-semibold transition ${value === o.v ? `${accentBg[accent]} text-[#0b1020]` : 'text-mute hover:text-ink'}`}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block text-xs text-mute">
      <span className="font-semibold">{label}</span>
      <div className="mt-1 text-ink">{children}</div>
      {hint && <span className="block mt-1 text-[11px] opacity-80">{hint}</span>}
    </label>
  )
}

export function NumIn({ value, onChange, min, max, className = 'w-28' }: { value: number; onChange: (n: number) => void; min?: number; max?: number; className?: string }) {
  return <input type="number" className={className} value={isNaN(value) ? '' : value} min={min} max={max} onChange={e => onChange(e.target.value === '' ? NaN : Number(e.target.value))} />
}

export function Tabs({ tabs, value, onChange }: { tabs: { v: string; label: string }[]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex gap-1 border-b border-line">
      {tabs.map(t => (
        <button key={t.v} onClick={() => onChange(t.v)} className={`px-4 py-2 text-sm font-semibold -mb-px border-b-2 transition ${value === t.v ? 'border-net text-ink' : 'border-transparent text-mute hover:text-ink'}`}>
          {t.label}
        </button>
      ))}
    </div>
  )
}

export function Empty({ text, hint }: { text: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 py-10 text-center text-mute">
      <Inbox size={26} className="opacity-60" />
      <div className="text-sm font-semibold">{text}</div>
      {hint && <div className="text-xs max-w-sm">{hint}</div>}
    </div>
  )
}

export function ErrorBox({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
      <AlertTriangle size={16} className="mt-0.5 shrink-0" />
      <span className="break-words">{text}</span>
    </div>
  )
}

export function Note({ children, tone = 'net' }: { children: ReactNode; tone?: string }) {
  return <div className={`rounded-lg border px-3 py-2 text-xs leading-relaxed ${tone === 'net' ? 'border-net/30 bg-net/10' : `border-${tone}/30 bg-${tone}/10`} text-ink/90`}>{children}</div>
}

// Run an async action with a busy flag and toast feedback.
export function useAction(toast: (k: 'ok' | 'err' | 'info', t: string) => void) {
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<any>, okMsg?: string) => {
    setBusy(true)
    try { const r = await fn(); if (okMsg) toast('ok', okMsg); return r } catch (e: any) { toast('err', e.message || String(e)) } finally { setBusy(false) }
  }
  return { busy, run }
}

export const Mono = ({ children }: { children: ReactNode }) => <span className="num">{children}</span>
