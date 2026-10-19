// Showing friends' practice: colors, names and which friends are hidden.

import type { FriendCalendar } from './api'

/** Distinct dot colors (index.css: .friend-color-N); friends beyond these reuse them. */
export const FRIEND_COLORS = 6

/** A friend's color: by position in the full list, so hiding one doesn't recolor the rest. */
export function friendColorClass(index: number): string {
  return `friend-color-${index % FRIEND_COLORS}`
}

export function friendName(friend: Pick<FriendCalendar, 'did' | 'handle'>): string {
  return friend.handle ? `@${friend.handle}` : friend.did
}

/** The friends this viewer has hidden, remembered per device (a convenience, so storage may fail). */
export function loadHiddenFriends(viewer: string): Set<string> {
  try {
    const stored = JSON.parse(localStorage.getItem(hiddenKey(viewer)) ?? '[]') as unknown
    return new Set(Array.isArray(stored) ? stored.filter((d): d is string => typeof d === 'string') : [])
  } catch {
    return new Set()
  }
}

export function saveHiddenFriends(viewer: string, hidden: Set<string>) {
  try {
    localStorage.setItem(hiddenKey(viewer), JSON.stringify([...hidden]))
  } catch {
    // Not remembered; the choice still applies until the page reloads.
  }
}

function hiddenKey(viewer: string) {
  return `voicebook.hiddenFriends.${viewer}`
}
