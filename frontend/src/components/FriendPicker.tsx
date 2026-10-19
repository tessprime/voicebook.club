import type { FriendCalendar } from '../api'
import { friendColorClass, friendName } from '../friends'

/** Toggle buttons choosing whose practice shows on the calendar. */
export function FriendPicker({
  friends,
  hidden,
  onChange,
}: {
  friends: FriendCalendar[]
  hidden: Set<string>
  onChange: (hidden: Set<string>) => void
}) {
  function toggle(did: string) {
    const next = new Set(hidden)
    if (next.has(did)) next.delete(did)
    else next.add(did)
    onChange(next)
  }

  const allShown = friends.every((f) => !hidden.has(f.did))
  return (
    <div className="friend-picker" role="group" aria-label="Friends shown on the calendar">
      <span className="muted">Friends:</span>
      {friends.map((friend, i) => (
        <button
          key={friend.did}
          className="chip"
          aria-pressed={!hidden.has(friend.did)}
          onClick={() => toggle(friend.did)}
        >
          <span className={`dot ${friendColorClass(i)}`} aria-hidden />
          {friendName(friend)}
        </button>
      ))}
      {friends.length > 1 && (
        <button
          className="chip link"
          onClick={() => onChange(allShown ? new Set(friends.map((f) => f.did)) : new Set())}
        >
          {allShown ? 'Hide all' : 'Show all'}
        </button>
      )}
    </div>
  )
}
