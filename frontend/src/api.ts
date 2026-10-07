// Reads go to the Voicebook backend's index; writes go straight to the
// user's PDS through their OAuth session. The backend knows who's calling from
// a session cookie, created from a service-auth token (docs/design/auth.md).

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

/**
 * A failed backend request. The trace ID (from the x-trace-id header) finds
 * the request in Grafana; error messages show it so a report can be traced.
 */
export class BackendError extends Error {
  constructor(path: string, res: Response) {
    const traceId = res.headers.get('x-trace-id')
    super(`${path}: ${res.status} ${res.statusText}${traceId ? ` (ref ${traceId})` : ''}`)
  }
}

/** Requests that change something carry this header (the backend's CSRF guard). */
const CSRF_HEADERS = { 'x-voicebook-csrf': '1' }

let reauthenticate: (() => Promise<void>) | undefined

/** How to get a fresh backend session when one expires (set after sign-in). */
export function setReauthenticate(fn: (() => Promise<void>) | undefined) {
  reauthenticate = fn
}

/** A backend request: on 401, signs in to the backend again and retries once. */
async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase()
  const send = () => fetch(path, { ...init, headers: method === 'GET' ? init.headers : { ...init.headers, ...CSRF_HEADERS } })
  const res = await send()
  if (res.status !== 401 || !reauthenticate) return res
  await reauthenticate()
  return send()
}

async function get<T>(path: string): Promise<T> {
  const res = await request(path)
  if (!res.ok) throw new BackendError(path, res)
  return res.json() as Promise<T>
}

// --- backend session ------------------------------------------------------------

export type BackendSession = {
  /** The signed-in DID, or null. */
  did: string | null
  admin: boolean
  /** What the service-auth token must name. */
  audience: string
  lxm: string
}

/** The account isn't on the instance's allowlist (closed beta). */
export class NotInvitedError extends Error {}

/** The backend is turning sign-ins away for a minute (429); try again soon. */
export class SignInBusyError extends Error {}

export async function backendSession(): Promise<BackendSession> {
  const res = await fetch('/api/session')
  if (!res.ok) throw new BackendError('/api/session', res)
  return res.json() as Promise<BackendSession>
}

/**
 * Proves the account's identity to the backend: asks the user's PDS for a
 * short-lived service-auth token for this service and exchanges it for a
 * session cookie.
 */
export async function signInToBackend(agent: Agent): Promise<BackendSession> {
  const info = await backendSession()
  const { data } = await agent.com.atproto.server.getServiceAuth({
    aud: info.audience,
    lxm: info.lxm,
    exp: Math.floor(Date.now() / 1000) + 60,
  })
  const res = await fetch('/api/session', { method: 'POST', headers: { authorization: `Bearer ${data.token}` } })
  if (res.status === 403) throw new NotInvitedError()
  if (res.status === 429) throw new SignInBusyError()
  if (!res.ok) throw new BackendError('/api/session', res)
  return res.json() as Promise<BackendSession>
}

export async function signOutOfBackend(): Promise<void> {
  await fetch('/api/session', { method: 'DELETE', headers: CSRF_HEADERS })
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

/**
 * Asks the backend to re-read the account's repo now rather than wait for
 * Jetstream, which can lag. Returns whether the account is a member.
 */
export async function refreshMember(did: string): Promise<boolean> {
  const res = await request(`/api/members/${encodeURIComponent(did)}/refresh`, { method: 'POST' })
  if (!res.ok) throw new BackendError('refresh', res)
  return ((await res.json()) as { member: boolean }).member
}

export type NewRecording = {
  /** When the practice happened; defaults to now. */
  createdAt?: string
  work: string
  chapter?: string
  notes?: string
  durationMs?: number
  file: Blob
}

/**
 * Uploads the audio and creates the club.voicebook.recording record. Returns
 * the new record's AT URI. The backend indexes it from Jetstream shortly after.
 */
export async function createRecording(agent: Agent, did: string, input: NewRecording): Promise<string> {
  const encoding = input.file.type || 'application/octet-stream'
  const upload = await agent.com.atproto.repo.uploadBlob(input.file, { encoding })
  const record = {
    $type: 'club.voicebook.recording',
    createdAt: input.createdAt ?? new Date().toISOString(),
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
  // Don't depend on Jetstream's latency for the user's own new recording.
  await refreshMember(did).catch(() => undefined)
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
