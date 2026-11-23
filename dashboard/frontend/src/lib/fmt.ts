export const n0 = (v: number | undefined) => (v === undefined || v === null || isNaN(v as number) ? '–' : Math.round(v).toLocaleString())
export const n1 = (v: number | undefined) => (v === undefined || v === null || isNaN(v as number) ? '–' : (Math.round(v * 10) / 10).toLocaleString())
export const pct = (v: number | undefined) => (v === undefined ? '–' : (v * 100).toFixed(1) + '%')
export const us = (v: number | undefined) => {
  if (v === undefined || v === null || isNaN(v as number)) return '–'
  if (v >= 1e6) return (v / 1e6).toFixed(2) + ' s'
  if (v >= 1e3) return (v / 1e3).toFixed(2) + ' ms'
  return Math.round(v) + ' µs'
}
export const uptime = (s: number | undefined) => {
  if (s === undefined) return '–'
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = Math.floor(s % 60)
  return `${h ? h + 'h ' : ''}${m || h ? m + 'm ' : ''}${x}s`
}
export const OP_COLORS: Record<string, string> = { SET: '#f2b441', GET: '#6aa6ff', DEL: '#fb7185', LIST: '#a68bfa', MSET: '#35c4be' }
export const policies = ['fcfs', 'sjf', 'priority', 'rr']
export const policyLabel: Record<string, string> = { fcfs: 'FCFS', sjf: 'SJF', priority: 'Priority', rr: 'Round Robin', FCFS: 'FCFS', SJF: 'SJF', PRIORITY: 'Priority', RR: 'Round Robin' }
export const diskAlgs = ['fcfs', 'sstf', 'scan', 'cscan', 'look', 'clook']
export const diskLabel: Record<string, string> = { fcfs: 'FCFS', sstf: 'SSTF', scan: 'SCAN', cscan: 'C-SCAN', look: 'LOOK', clook: 'C-LOOK', FCFS: 'FCFS', SSTF: 'SSTF', SCAN: 'SCAN', 'C-SCAN': 'C-SCAN', LOOK: 'LOOK', 'C-LOOK': 'C-LOOK' }
export const diskKey = (label: string) => label.toLowerCase().replace('-', '')
export const cacheAlgs = ['fifo', 'lru', 'clock']
