// Reads go to the Voicebook backend's index; writes go straight to the
// user's PDS through their OAuth session.

import type { Agent } from '@atproto/api'

export type Recording = {
  uri: string
  did: string
  handle: string | null
  createdAt: string
  work: string
  chapter: string | null
  durationMs: number | null
  notes: string | null
  mimeType: string | null
  sizeBytes: number | null
  audioUrl: string | null
}

export type PracticeDay = {
  date: string // YYYY-MM-DD in the viewer's time zone
  recordingCount: number
  durationMs: number | null
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path)
  if (!res.ok) throw new Error(`${path}: ${res.status} ${res.statusText}`)
  return res.json() as Promise<T>
}

export function recordings(did: string, limit = 100): Promise<Recording[]> {
  return get(`/api/users/${encodeURIComponent(did)}/recordings?limit=${limit}`)
}

export function calendar(did: string, month: string): Promise<PracticeDay[]> {
  // getTimezoneOffset is minutes *behind* UTC; the API wants the UTC offset.
  const tzOffsetMinutes = -new Date().getTimezoneOffset()
  return get(`/api/users/${encodeURIComponent(did)}/calendar?month=${month}&tzOffsetMinutes=${tzOffsetMinutes}`)
}

export function friendsActivity(did: string, limit = 50): Promise<Recording[]> {
  return get(`/api/users/${encodeURIComponent(did)}/friends/activity?limit=${limit}`)
}

export type NewRecording = {
  work: string
  chapter?: string
  notes?: string
  durationMs?: number
  file: File
}

/**
 * Uploads the audio and creates the club.voicebook.recording record. Returns
 * the new record's AT URI. The backend indexes it from Jetstream shortly after.
 */
export async function createRecording(agent: Agent, did: string, input: NewRecording): Promise<string> {
  const upload = await agent.com.atproto.repo.uploadBlob(input.file, {
    encoding: input.file.type || 'application/octet-stream',
  })
  const record = {
    $type: 'club.voicebook.recording',
    createdAt: new Date().toISOString(),
    work: input.work,
    ...(input.chapter ? { chapter: input.chapter } : {}),
    ...(input.notes ? { notes: input.notes } : {}),
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
    // Use the PDS's blob reference unchanged; it may have normalized the MIME type.
    audio: upload.data.blob,
  }
  const created = await agent.com.atproto.repo.createRecord({
    repo: did,
    collection: 'club.voicebook.recording',
    record,
  })
  return created.data.uri
}

/** Polls the backend until `uri` is indexed, so the UI can show it. */
export async function waitForIndexed(did: string, uri: string, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const latest = await recordings(did, 10)
    if (latest.some((r) => r.uri === uri)) return true
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  return false
}

/** Reads an audio file's duration in the browser, if it can be determined. */
export function audioDuration(file: File): Promise<number | undefined> {
  return new Promise((resolve) => {
    const audio = new Audio()
    const url = URL.createObjectURL(file)
    const done = (ms: number | undefined) => {
      URL.revokeObjectURL(url)
      resolve(ms)
    }
    audio.preload = 'metadata'
    audio.onloadedmetadata = () => done(Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : undefined)
    audio.onerror = () => done(undefined)
    audio.src = url
  })
}
