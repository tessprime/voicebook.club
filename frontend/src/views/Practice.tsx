import { useEffect, useMemo, useState } from 'react'

import { calendar, recordings, type PracticeDay, type Recording } from '../api'
import type { Session } from '../auth'
import { PracticeForm } from '../components/PracticeForm'
import { RecordingItem } from '../components/RecordingItem'
import { deleteDraft, listDrafts, updateDraft, type Draft } from '../drafts'
import { addDays, addMonths, formatClock, formatDateTime, formatDuration, localDate, monthKey } from '../format'

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export function Practice({ session, dataVersion }: { session: Session; dataVersion: number }) {
  const [today] = useState(() => localDate(new Date()))
  const [month, setMonth] = useState(() => addMonths(new Date(), 0))
  const [days, setDays] = useState<PracticeDay[]>([])
  const [recent, setRecent] = useState<Recording[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  // false, or the form's state: optionally resuming an unsaved draft.
  const [practicing, setPracticing] = useState<false | { draft?: Draft }>(false)
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [version, setVersion] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let stale = false
    Promise.all([calendar(session.did, monthKey(month)), recordings(session.did, 200)])
      .then(([days, recent]) => {
        if (stale) return
        setDays(days)
        setRecent(recent)
        setError(null)
      })
      .catch((err) => !stale && setError(String(err)))
    return () => {
      stale = true
    }
  }, [session.did, month, version, dataVersion])

  // Unsaved recordings, re-checked whenever the form closes.
  useEffect(() => {
    if (!practicing) listDrafts().then(setDrafts, () => setDrafts([]))
  }, [practicing])

  async function resume(draft: Draft) {
    // A recording interrupted mid-way (tab closed) is still usable up to its last chunk.
    const ready = draft.finished ? draft : { ...draft, finished: true }
    if (!draft.finished) await updateDraft(ready)
    setPracticing({ draft: ready })
  }

  async function discard(draft: Draft) {
    if (!window.confirm('Discard this recording? It hasn’t been saved anywhere else.')) return
    await deleteDraft(draft.id)
    setDrafts(await listDrafts())
  }

  const practiceDays = useMemo(() => new Map(days.map((d) => [d.date, d])), [days])
  const streak = useMemo(() => currentStreak(recent), [recent])
  const selectedRecordings = selected ? recent.filter((r) => localDate(new Date(r.createdAt)) === selected) : []

  return (
    <section className="practice">
      <div className="month-header">
        <button className="secondary icon" aria-label="Previous month" onClick={() => setMonth(addMonths(month, -1))}>
          ‹
        </button>
        <h2>{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h2>
        <button className="secondary icon" aria-label="Next month" onClick={() => setMonth(addMonths(month, 1))}>
          ›
        </button>
      </div>

      <div className="calendar" role="grid">
        {WEEKDAYS.map((d) => (
          <div key={d} className="weekday" role="columnheader">
            {d}
          </div>
        ))}
        {monthCells(month).map((date, i) => {
          if (!date) return <div key={`pad-${i}`} />
          const key = localDate(date)
          const day = practiceDays.get(key)
          const classes = ['day', day && 'practiced', key === today && 'today', key === selected && 'selected']
          return (
            <button
              key={key}
              className={classes.filter(Boolean).join(' ')}
              onClick={() => setSelected(key === selected ? null : key)}
              aria-label={`${date.toLocaleDateString()}${day ? `, ${day.recordingCount} recording(s)` : ''}`}
            >
              <span>{date.getDate()}</span>
              {day && <span className="dot" aria-hidden />}
            </button>
          )
        })}
      </div>

      <p className="stats">
        <strong>{days.length}</strong> practice {days.length === 1 ? 'day' : 'days'} this month
        {streak > 0 && (
          <>
            {' · '}Current streak: <strong>{streak}</strong> {streak === 1 ? 'day' : 'days'}
          </>
        )}
      </p>
      {error && <p className="error">Couldn’t load your practice history: {error}</p>}

      {!practicing &&
        drafts.map((draft) => (
          <div key={draft.id} className="panel draft-banner" role="status">
            <span>
              <strong>Unsaved recording</strong> from {formatDateTime(draft.startedAt)} ({formatClock(draft.durationMs)})
              {draft.work && <> · {draft.work}</>}
            </span>
            <span className="actions">
              <button className="secondary" onClick={() => discard(draft)}>
                Discard
              </button>
              <button onClick={() => resume(draft)}>Review and save</button>
            </span>
          </div>
        ))}

      {practicing ? (
        <PracticeForm
          session={session}
          initialDraft={practicing.draft}
          onCancel={() => setPracticing(false)}
          onSaved={() => {
            setPracticing(false)
            setMonth(addMonths(new Date(), 0))
            setSelected(localDate(new Date()))
            setVersion((v) => v + 1)
          }}
        />
      ) : (
        <button className="primary-action" onClick={() => setPracticing({})}>
          Start Practice
        </button>
      )}

      {selected && (
        <div className="panel">
          <h3>
            {new Date(`${selected}T00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
            {practiceDays.get(selected)?.durationMs ? ` · ${formatDuration(practiceDays.get(selected)?.durationMs)}` : ''}
          </h3>
          {selectedRecordings.length ? (
            <ul className="recordings">
              {selectedRecordings.map((r) => (
                <RecordingItem key={r.uri} recording={r} />
              ))}
            </ul>
          ) : (
            <p className="muted">No practice this day.</p>
          )}
        </div>
      )}
    </section>
  )
}

/** Day cells for a Monday-first month grid, with nulls for padding. */
function monthCells(month: Date): (Date | null)[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1)
  const padding = (first.getDay() + 6) % 7
  const count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
  return [...Array<null>(padding).fill(null), ...Array.from({ length: count }, (_, i) => addDays(first, i))]
}

/** Consecutive practice days ending today, or yesterday if not yet today. */
function currentStreak(recordings: Recording[]): number {
  const dates = new Set(recordings.map((r) => localDate(new Date(r.createdAt))))
  let day = new Date()
  if (!dates.has(localDate(day))) day = addDays(day, -1)
  let streak = 0
  while (dates.has(localDate(day))) {
    streak++
    day = addDays(day, -1)
  }
  return streak
}
