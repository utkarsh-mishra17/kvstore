import { ReactNode } from 'react'
import { ArrowRight } from 'lucide-react'
import { accentText } from './ui'

export type Stage = { name: string; accent: string; value: ReactNode; sub: ReactNode }

// The request path from the synopsis, with live numbers at every stage.
export function Pipeline({ stages, active }: { stages: Stage[]; active: boolean }) {
  return (
    <div className="flex items-stretch gap-1 overflow-x-auto pb-1">
      {stages.map((s, i) => (
        <div key={s.name} className="flex items-center gap-1 min-w-0">
          <div className="min-w-[118px] rounded-lg border border-line bg-raised/60 px-3 py-2.5">
            <div className={`text-[11px] font-bold ${accentText[s.accent]}`}>{s.name}</div>
            <div className="num text-lg font-semibold leading-tight mt-0.5">{s.value}</div>
            <div className="text-[11px] text-mute truncate">{s.sub}</div>
          </div>
          {i < stages.length - 1 && (
            <svg width="30" height="20" viewBox="0 0 30 20" className="shrink-0">
              <line x1="2" y1="10" x2="24" y2="10" stroke="rgb(var(--mute))" strokeWidth="2" className={active ? 'flow-line' : ''} />
              <path d="M22 5l6 5-6 5" fill="none" stroke="rgb(var(--mute))" strokeWidth="2" />
            </svg>
          )}
        </div>
      ))}
    </div>
  )
}
export { ArrowRight }
