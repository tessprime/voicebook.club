// Which recording the details panel shows. Any list can select one; App
// renders the panel beside (or, on narrow screens, over) the current view.

import { createContext, useContext } from 'react'

import type { Recording } from './api'

export type RecordingSelection = {
  selected: Recording | null
  /** Changes each time playing is asked for (null if it wasn't): the panel plays once per value. */
  playRequest: number | null
  select: (recording: Recording | null, options?: { play?: boolean }) => void
}

export const SelectionContext = createContext<RecordingSelection>({ selected: null, playRequest: null, select: () => undefined })

export function useSelection(): RecordingSelection {
  return useContext(SelectionContext)
}
