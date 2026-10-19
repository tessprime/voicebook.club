import { useEffect, useMemo, useState } from 'react'

import { calendar, friendsActivity, friendsCalendar, recordings, type FriendCalendar, type PracticeDay, type Recording } from '../api'
import type { Session } from '../auth'
import { FriendPicker } from '../components/FriendPicker'
import { PracticeForm } from '../components/PracticeForm'
import { RecordingItem } from '../components/RecordingItem'
import { deleteDraft, listDrafts, updateDraft, type Draft } from '../drafts'
import { friendColorClass, friendName, loadHiddenFriends, saveHiddenFriends } from '../friends'
import { addDays, addMonths, formatClock, formatDateTime, formatDuration, localDate, monthKey } from '../format'

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
/** Friend dots per day before the rest are summarized as "+n". */
const MAX_FRIEND_DOTS = 3

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
  const [friends, setFriends] = useState<FriendCalendar[]>([])
  const [hidden, setHidden] = useState(() => loadHiddenFriends(session.did))

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

  // Loaded separately: friends failing to load shouldn't hide your own calendar.
  useEffect(() => {
    let stale = false
    friendsCalendar(session.did, monthKey(month)).then(
      (friends) => !stale && setFriends(friends),
      () => !stale && setFriends([]),
    )
    return () => {
      stale = true
    }
  }, [session.did, month, dataVersion])

  // The selected day's recordings by friends, for listing under each friend.
  const [friendRecordings, setFriendRecordings] = useState<{ date: string; recordings: Recording[] } | null>(null)
  useEffect(() => {
    if (!selected) return
    let stale = false
    const since = new Date(`${selected}T00:00`)
    friendsActivity(session.did, { since, before: addDays(since, 1), limit: 200 }).then(
      (recordings) => !stale && setFriendRecordings({ date: selected, recordings }),
      () => undefined,
    )
    return () => {
      stale = true
    }
  }, [session.did, selected, dataVersion])

  function changeHidden(next: Set<string>) {
    setHidden(next)
    saveHiddenFriends(session.did, next)
  }

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
  // Shown friends who practiced each day, in list order (which sets their color).
  const friendDays = useMemo(() => {
    const byDate = new Map<string, { friend: FriendCalendar; index: number; day: PracticeDay }[]>()
    friends.forEach((friend, index) => {
      if (hidden.has(friend.did)) return
      for (const day of friend.days) {
        const list = byDate.get(day.date) ?? []
        list.push({ friend, index, day })
        byDate.set(day.date, list)
      }
    })
    return byDate
  }, [friends, hidden])
  const selectedFriendRecordings = friendRecordings?.date === selected ? friendRecordings.recordings : []
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
          const others = friendDays.get(key) ?? []
          const classes = ['day', day && 'practiced', key === today && 'today', key === selected && 'selected']
          return (
            <button
              key={key}
              className={classes.filter(Boolean).join(' ')}
              onClick={() => setSelected(key === selected ? null : key)}
              aria-label={[
                date.toLocaleDateString(),
                day && `${day.recordingCount} recording(s)`,
                others.length && `practiced: ${others.map((o) => friendName(o.friend)).join(', ')}`,
              ]
                .filter(Boolean)
                .join(', ')}
            >
              <span>{date.getDate()}</span>
              {(day || others.length > 0) && (
                <span className="dots" aria-hidden>
                  {day && <span className="dot" />}
                  {others.slice(0, MAX_FRIEND_DOTS).map((o) => (
                    <span key={o.friend.did} className={`dot ${friendColorClass(o.index)}`} />
                  ))}
                  {others.length > MAX_FRIEND_DOTS && <span className="more">+{others.length - MAX_FRIEND_DOTS}</span>}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {friends.length > 0 && <FriendPicker friends={friends} hidden={hidden} onChange={changeHidden} />}

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
                <RecordingItem key={r.uri} recording={r} dot="" />
              ))}
            </ul>
          ) : (
            <p className="muted">{friendDays.has(selected) ? 'You didn’t practice this day.' : 'No practice this day.'}</p>
          )}
          {friendDays.get(selected)?.map(({ friend, index, day }) => (
            <div key={friend.did} className="friend-day">
              <h4>
                <span className={`dot ${friendColorClass(index)}`} aria-hidden />
                {friendName(friend)}
                <span className="muted">
                  {day.durationMs ? formatDuration(day.durationMs) : `${day.recordingCount} recording(s)`}
                </span>
              </h4>
              <ul className="recordings">
                {selectedFriendRecordings
                  .filter((r) => r.did === friend.did)
                  .map((r) => (
                    <RecordingItem key={r.uri} recording={r} dot={friendColorClass(index)} />
                  ))}
              </ul>
            </div>
          ))}
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
