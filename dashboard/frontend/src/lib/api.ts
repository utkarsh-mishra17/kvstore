// Thin fetch wrapper around the FastAPI layer. Errors carry the server's `detail` text.
export async function api<T = any>(path: string, body?: unknown, method?: string): Promise<T> {
  const res = await fetch('/api' + path, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let data: any = text
  try { data = JSON.parse(text) } catch { /* plain text */ }
  if (!res.ok) throw new Error(typeof data === 'object' && data?.detail ? (typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail)) : `HTTP ${res.status}`)
  return data as T
}
export const cmd = (command: string, client = 'explorer') => api('/cmd', { command, client })
