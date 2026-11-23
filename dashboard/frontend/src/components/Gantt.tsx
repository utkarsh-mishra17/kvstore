import { hex } from './ui'

export type Seg = { start: number; end: number; label: string; color?: string; title?: string }
export type Lane = { label: string; segs: Seg[] }
const palette = ['#6aa6ff', '#f2b441', '#35c4be', '#a68bfa', '#fb7185', '#4ade80', '#f97316', '#22d3ee', '#e879f9', '#a3e635']
export const colorFor = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return palette[h % palette.length] }

// Generic lane chart (Gantt). Used for simulated CPU schedules, live worker slices and lock timelines.
export function Gantt({ lanes, unit = '', t0, t1, height = 30 }: { lanes: Lane[]; unit?: string; t0?: number; t1?: number; height?: number }) {
  const all = lanes.flatMap(l => l.segs)
  if (!all.length) return null
  const lo = t0 ?? Math.min(...all.map(s => s.start)), hi = t1 ?? Math.max(...all.map(s => s.end))
  const span = Math.max(1e-9, hi - lo)
  const W = 900, L = 78, R = 10, H = lanes.length * (height + 6) + 26
  const x = (v: number) => L + ((v - lo) / span) * (W - L - R)
  const ticks = 8
  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[520px]" role="img">
        {Array.from({ length: ticks + 1 }, (_, i) => {
          const v = lo + (span * i) / ticks
          return (
            <g key={i}>
              <line x1={x(v)} x2={x(v)} y1={0} y2={H - 20} stroke="rgb(var(--line))" strokeWidth={1} />
              <text x={x(v)} y={H - 6} textAnchor="middle" className="recharts-text">{(Math.round(v * 10) / 10).toString() + unit}</text>
            </g>
          )
        })}
        {lanes.map((l, i) => (
          <g key={l.label} transform={`translate(0 ${i * (height + 6) + 4})`}>
            <text x={L - 8} y={height / 2 + 4} textAnchor="end" className="recharts-text" style={{ fontWeight: 600 }}>{l.label}</text>
            {l.segs.map((s, k) => {
              const w = Math.max(2, x(s.end) - x(s.start))
              const c = s.color || colorFor(s.label)
              return (
                <g key={k}>
                  <rect x={x(s.start)} y={0} width={w} height={height} rx={4} fill={c} fillOpacity={0.85}><title>{s.title || `${s.label}: ${s.start}–${s.end}`}</title></rect>
                  {w > 22 && <text x={x(s.start) + w / 2} y={height / 2 + 4} textAnchor="middle" style={{ fontSize: 11, fontWeight: 700, fill: '#0b1020' }}>{s.label}</text>}
                </g>
              )
            })}
          </g>
        ))}
      </svg>
    </div>
  )
}
export { hex }
