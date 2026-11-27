// Kinds of practice a recording can be (the record's `activity`). Records
// from before activities have none and were all reading.

export type Activity = 'reading' | 'passage' | 'freeSpeech' | 'pitch' | 'resonance'

export const ACTIVITIES: { id: Activity; label: string }[] = [
  { id: 'reading', label: 'Book reading' },
  { id: 'passage', label: 'Fixed passage' },
  { id: 'freeSpeech', label: 'Free speech' },
  { id: 'pitch', label: 'Pitch exercise' },
  { id: 'resonance', label: 'Resonance exercise' },
]

/** Exercises to pick from; the choice becomes the record's `work`. */
export const EXERCISES: Partial<Record<Activity, string[]>> = {
  pitch: ['Glides and sirens', 'Target pitch', 'Sustained note'],
  resonance: ['Humming', 'Sustained vowels', 'Mm-hmm'],
}

/** `work` for free speech without a topic. */
export const FREE_SPEECH = 'Free speech'

export function asActivity(value: string | null | undefined): Activity {
  return ACTIVITIES.some((a) => a.id === value) ? (value as Activity) : 'reading'
}

/** A recording's title: what was practiced, with its activity when that isn't book reading. */
export function recordingTitle(recording: { activity?: string | null; work: string; chapter?: string | null }): string {
  const { activity, work, chapter } = recording
  switch (activity) {
    case 'passage':
      return `Passage: ${work}`
    case 'freeSpeech':
      return work === FREE_SPEECH ? FREE_SPEECH : `Free speech: ${work}`
    case 'pitch':
      return `Pitch: ${work}`
    case 'resonance':
      return `Resonance: ${work}`
    case 'reading':
    case null:
    case undefined:
      return chapter ? `${work} — Chapter ${chapter}` : work
    default:
      // An activity from a newer client: show what was practiced.
      return work
  }
}
