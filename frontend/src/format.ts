/** YYYY-MM-DD for a Date in the viewer's local time zone. */
export function localDate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** YYYY-MM for the month containing `date`, local time. */
export function monthKey(date: Date): string {
  return localDate(date).slice(0, 7)
}

export function addMonths(date: Date, months: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + months, 1)
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days)
}

export function formatDuration(ms: number | null | undefined): string {
  if (!ms) return ''
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds} s`
  const minutes = Math.round(totalSeconds / 60)
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

/** m:ss (or h:mm:ss), for a running timer. */
export function formatClock(ms: number): string {
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/** "today", "yesterday", or a short date. */
export function relativeDay(iso: string): string {
  const day = localDate(new Date(iso))
  const today = new Date()
  if (day === localDate(today)) return 'today'
  if (day === localDate(addDays(today, -1))) return 'yesterday'
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function workLabel(work: string, chapter: string | null): string {
  return chapter ? `${work} — Chapter ${chapter}` : work
}
