// Transcribing a recording with a speech-to-text service the user chooses
// (a "transcription endpoint"). Adapted from gender-voice-visualization.
//
// Endpoints, including any API key, are stored only in this browser
// (localStorage): never sent to the Voicebook backend or written to the
// user's repo. The audio goes to an endpoint only when the user presses
// Transcribe, and only to the endpoint shown next to the button. The
// resulting text is saved in the public recording record.

export type TranscriptionEndpoint = {
  id: string
  name: string
  /** The transcription URL itself, e.g. https://host/v1/audio/transcriptions. */
  url: string
  schema: SchemaId
  /** Optional: the server's first speech model when empty. */
  model: string
  /** Optional; sent as a bearer token. */
  apiKey: string
}

/** A word and when it was spoken, in milliseconds from the start. */
export type TimedWord = { text: string; startMs: number; endMs: number }

export type Transcription = { text: string; model: string | null; words: TimedWord[] | null }

type Schema = {
  label: string
  description: string
  placeholder: string
  models(endpoint: TranscriptionEndpoint): Promise<string[]>
  transcribe(endpoint: TranscriptionEndpoint, audio: Blob): Promise<Transcription>
}

export class TranscriptionError extends Error {
  readonly status: number | null

  constructor(message: string, status: number | null = null) {
    super(message)
    this.status = status
  }
}

function authHeaders(endpoint: TranscriptionEndpoint): Record<string, string> {
  return endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}
}

const openai: Schema = {
  label: 'OpenAI-compatible',
  description:
    'OpenAI’s audio transcription API, also offered by Groq, Speaches, faster-whisper-server, LocalAI and others. ' +
    'The URL ends in /v1/audio/transcriptions.',
  placeholder: 'https://api.openai.com/v1/audio/transcriptions',

  // The models the server lists next to the transcription URL ([] if it doesn't).
  async models(endpoint) {
    const url = endpoint.url.replace(/\/audio\/transcriptions\/?$/, '/models')
    if (url === endpoint.url) return []
    const response = await transcriptionFetch(endpoint, url, { headers: authHeaders(endpoint) })
    const body = (await response.json()) as { data?: { id: string; task?: string }[] }
    const models = Array.isArray(body.data) ? body.data : []
    // Speech recognition models first, when the server says which.
    const isSpeech = (m: { id: string; task?: string }) => m.task === 'automatic-speech-recognition' || /whisper|transcri/i.test(m.id)
    return [...models.filter(isSpeech), ...models.filter((m) => !isSpeech(m))].map((m) => m.id)
  },

  async transcribe(endpoint, audio) {
    // OpenAI requires a model: the server's first speech model, else Whisper's name.
    const model = endpoint.model || (await this.models(endpoint).catch(() => []))[0] || 'whisper-1'
    const request = (format: 'verbose_json' | 'json') => {
      const form = new FormData()
      form.append('file', audio, audioFileName(audio))
      form.append('model', model)
      form.append('response_format', format)
      if (format === 'verbose_json') form.append('timestamp_granularities[]', 'word')
      return transcriptionFetch(endpoint, endpoint.url, { method: 'POST', body: form, headers: authHeaders(endpoint) })
    }
    let response: Response
    try {
      response = await request('verbose_json')
    } catch (err) {
      // Some models (OpenAI's gpt-4o-transcribe) only do plain json, without word timings.
      if (!(err instanceof TranscriptionError && err.status === 400)) throw err
      response = await request('json')
    }
    const body = (await response.json().catch(() => {
      throw new TranscriptionError('the server’s reply wasn’t JSON')
    })) as { text?: unknown; words?: unknown }
    if (typeof body.text !== 'string') throw new TranscriptionError('the server’s reply has no text')
    return { text: body.text.trim(), model, words: timedWords(body.words) }
  },
}

/** verbose_json's words ([{word, start, end}] in seconds), or null unless all are well formed. */
function timedWords(words: unknown): TimedWord[] | null {
  if (!Array.isArray(words) || !words.length) return null
  const timed: TimedWord[] = []
  for (const w of words as { word?: unknown; start?: unknown; end?: unknown }[]) {
    if (typeof w?.word !== 'string' || typeof w.start !== 'number' || typeof w.end !== 'number') return null
    const startMs = Math.max(0, Math.round(w.start * 1000))
    timed.push({ text: w.word.trim(), startMs, endMs: Math.max(startMs, Math.round(w.end * 1000)) })
  }
  return timed
}

export const SCHEMAS = { openai } satisfies Record<string, Schema>
export type SchemaId = keyof typeof SCHEMAS

export function transcribe(endpoint: TranscriptionEndpoint, audio: Blob): Promise<Transcription> {
  return SCHEMAS[endpoint.schema].transcribe(endpoint, audio)
}

export function listModels(endpoint: TranscriptionEndpoint): Promise<string[]> {
  return SCHEMAS[endpoint.schema].models(endpoint)
}

/** Why an endpoint can't be used from this page, or null. */
export function endpointProblem(url: string): string | null {
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return 'That isn’t a URL.'
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)
  if (target.protocol === 'https:' || (target.protocol === 'http:' && local && location.protocol === 'http:')) return null
  if (target.protocol === 'http:' && local) {
    return 'This page is served over HTTPS, and its security policy only allows HTTPS services. Serve the local server over HTTPS.'
  }
  return 'Use an https:// address: the key and your recording would otherwise travel unencrypted.'
}

// fetch, with errors a person can act on. The API key is never part of them.
async function transcriptionFetch(endpoint: TranscriptionEndpoint, url: string, init: RequestInit): Promise<Response> {
  let response: Response
  try {
    response = await fetch(url, { ...init, credentials: 'omit', referrerPolicy: 'no-referrer' })
  } catch {
    throw new TranscriptionError(
      `Couldn’t reach ${endpointHost(endpoint)}: check the address, that the server is running, and that it allows requests from this site (CORS).`,
    )
  }
  if (!response.ok) {
    let detail = ''
    try {
      const text = await response.text()
      try {
        const body = JSON.parse(text) as { error?: { message?: string } | string; detail?: string; message?: string }
        const error = typeof body.error === 'object' ? body.error?.message : body.error
        detail = error || body.detail || body.message || text
      } catch {
        detail = text
      }
    } catch {
      // No body.
    }
    if (typeof detail !== 'string') detail = JSON.stringify(detail)
    detail = detail.trim().slice(0, 300)
    const hint = response.status === 401 || response.status === 403 ? ' (check the API key)' : ''
    throw new TranscriptionError(`${endpointHost(endpoint)} answered ${response.status}${hint}${detail ? `: ${detail}` : ''}`, response.status)
  }
  return response
}

export function endpointHost(endpoint: Pick<TranscriptionEndpoint, 'url'>): string {
  try {
    return new URL(endpoint.url).host
  } catch {
    return endpoint.url
  }
}

// A file name with an extension matching the audio's type: servers pick the decoder from it.
function audioFileName(audio: Blob): string {
  if (audio instanceof File && audio.name) return audio.name
  const type = audio.type.split(';')[0]
  const extensions: Record<string, string> = {
    'audio/webm': 'webm',
    'video/webm': 'webm',
    'audio/ogg': 'ogg',
    'audio/mp4': 'm4a',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/flac': 'flac',
  }
  return `recording.${extensions[type] ?? 'webm'}`
}

// --- storage (this browser only) --------------------------------------------------

const ENDPOINTS_KEY = 'voicebook.transcriptionEndpoints'
const CHOSEN_KEY = 'voicebook.transcriptionEndpoint'

export function loadEndpoints(): TranscriptionEndpoint[] {
  try {
    const stored = JSON.parse(localStorage.getItem(ENDPOINTS_KEY) ?? '[]') as unknown
    if (!Array.isArray(stored)) return []
    return stored.filter(
      (e): e is TranscriptionEndpoint => typeof e?.id === 'string' && typeof e?.url === 'string' && e?.schema in SCHEMAS,
    )
  } catch {
    return []
  }
}

/** Throws if the browser won't store them (e.g. storage is blocked). */
export function saveEndpoints(endpoints: TranscriptionEndpoint[]) {
  if (endpoints.length) localStorage.setItem(ENDPOINTS_KEY, JSON.stringify(endpoints))
  else localStorage.removeItem(ENDPOINTS_KEY)
}

export function newEndpointId(): string {
  return crypto.randomUUID()
}

/** The endpoint picked last, else the first. */
export function chosenEndpoint(endpoints: TranscriptionEndpoint[]): TranscriptionEndpoint | null {
  let id: string | null = null
  try {
    id = localStorage.getItem(CHOSEN_KEY)
  } catch {
    // Default to the first.
  }
  return endpoints.find((e) => e.id === id) ?? endpoints[0] ?? null
}

export function chooseEndpoint(id: string) {
  try {
    localStorage.setItem(CHOSEN_KEY, id)
  } catch {
    // Not remembered.
  }
}
