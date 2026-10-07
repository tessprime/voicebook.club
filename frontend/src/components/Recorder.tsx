import { useEffect, useRef, useState } from 'react'

import { appendChunk, createDraft, deleteDraft, draftAudio, updateDraft, type Draft } from '../drafts'
import { formatClock } from '../format'

// Opus in WebM (Chrome, Firefox) or Ogg; MP4 for Safari.
const MIME_TYPES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4']
const CHUNK_MS = 1000
const BITS_PER_SECOND = 64_000

type State =
  | { kind: 'idle'; error?: string }
  | { kind: 'starting' }
  | { kind: 'recording'; paused: boolean }
  | { kind: 'finishing' }
  | { kind: 'done'; url: string }

type Props = {
  /** A finished draft to show instead of starting fresh (e.g. one restored after a reload). */
  draft: Draft | null
  fields: Pick<Draft, 'work' | 'chapter' | 'notes'>
  onDraftChange: (draft: Draft | null) => void
  disabled?: boolean
}

/**
 * Records from the microphone into a draft kept in IndexedDB. The draft
 * survives reloads and failed uploads; the parent deletes it once saved.
 */
export function Recorder({ draft, fields, onDraftChange, disabled }: Props) {
  const [state, setState] = useState<State>({ kind: 'idle' })
  const [elapsedMs, setElapsedMs] = useState(0)
  const [level, setLevel] = useState(0)
  const session = useRef<RecordingSession | null>(null)

  // Show an existing finished draft for review.
  useEffect(() => {
    if (!draft?.finished || session.current) return
    let url: string | undefined
    let stale = false
    draftAudio(draft).then((blob) => {
      if (stale) return
      url = URL.createObjectURL(blob)
      setElapsedMs(draft.durationMs)
      setState({ kind: 'done', url })
    })
    return () => {
      stale = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [draft])

  // Release the microphone if the component goes away mid-recording.
  useEffect(() => () => session.current?.abort(), [])

  async function start() {
    setState({ kind: 'starting' })
    try {
      const recording = await RecordingSession.start(fields, {
        onTick: setElapsedMs,
        onLevel: setLevel,
      })
      session.current = recording
      onDraftChange(recording.draft)
      setElapsedMs(0)
      setState({ kind: 'recording', paused: false })
    } catch (err) {
      setState({ kind: 'idle', error: microphoneError(err) })
    }
  }

  function togglePause() {
    const recording = session.current
    if (!recording || state.kind !== 'recording') return
    if (state.paused) recording.resume()
    else recording.pause()
    setState({ kind: 'recording', paused: !state.paused })
  }

  async function stop() {
    const recording = session.current
    if (!recording) return
    setState({ kind: 'finishing' })
    const finished = await recording.stop()
    session.current = null
    setLevel(0)
    onDraftChange(finished) // the effect above loads it for review
  }

  async function discard() {
    if (draft) await deleteDraft(draft.id)
    onDraftChange(null)
    setElapsedMs(0)
    setState({ kind: 'idle' })
  }

  if (state.kind === 'done') {
    return (
      <div className="recorder">
        <audio controls src={state.url} />
        <div className="recorder-row">
          <span className="muted">{formatClock(elapsedMs)} recorded · kept in this browser until saved</span>
          <button type="button" className="secondary" onClick={discard} disabled={disabled}>
            Discard and record again
          </button>
        </div>
      </div>
    )
  }

  const recording = state.kind === 'recording'
  return (
    <div className="recorder">
      <div className="recorder-row">
        <span className={recording && !state.paused ? 'rec-indicator live' : 'rec-indicator'} aria-hidden />
        <span className="recorder-clock" role="timer" aria-live="off">
          {formatClock(elapsedMs)}
        </span>
        <meter className="recorder-level" min={0} max={1} value={level} aria-label="Input level" />
      </div>
      <div className="recorder-row">
        {!recording ? (
          <button type="button" onClick={start} disabled={disabled || state.kind !== 'idle'}>
            {state.kind === 'starting' ? 'Starting…' : state.kind === 'finishing' ? 'Finishing…' : '● Record'}
          </button>
        ) : (
          <>
            <button type="button" className="secondary" onClick={togglePause}>
              {state.paused ? 'Resume' : 'Pause'}
            </button>
            <button type="button" onClick={stop}>
              ■ Stop
            </button>
          </>
        )}
      </div>
      {state.kind === 'idle' && state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
    </div>
  )
}

function microphoneError(err: unknown): string {
  if (err instanceof DOMException && err.name === 'NotAllowedError') {
    return 'Microphone access was blocked. Allow it in your browser’s site settings and try again.'
  }
  if (err instanceof DOMException && err.name === 'NotFoundError') return 'No microphone was found.'
  return `Couldn’t start recording: ${err instanceof Error ? err.message : String(err)}`
}

type Callbacks = { onTick: (elapsedMs: number) => void; onLevel: (level: number) => void }

/** One microphone recording: MediaRecorder, timing, level meter and chunk persistence. */
class RecordingSession {
  draft: Draft
  private stream: MediaStream
  private recorder: MediaRecorder
  private seq = 0
  private activeSince: number | null = performance.now()
  private accumulatedMs = 0
  private pending: Promise<void> = Promise.resolve()
  private timer: number
  private audioContext: AudioContext

  private constructor(draft: Draft, stream: MediaStream, recorder: MediaRecorder, callbacks: Callbacks) {
    this.draft = draft
    this.stream = stream
    this.recorder = recorder
    this.audioContext = new AudioContext()
    const analyser = this.audioContext.createAnalyser()
    analyser.fftSize = 1024
    this.audioContext.createMediaStreamSource(stream).connect(analyser)
    const samples = new Float32Array(analyser.fftSize)
    this.timer = window.setInterval(() => {
      callbacks.onTick(this.elapsedMs())
      analyser.getFloatTimeDomainData(samples)
      const rms = Math.sqrt(samples.reduce((sum, s) => sum + s * s, 0) / samples.length)
      callbacks.onLevel(Math.min(1, rms * 4))
    }, 100)

    recorder.ondataavailable = (event) => {
      if (!event.data.size) return
      const seq = this.seq++
      const durationMs = this.elapsedMs()
      // Serialize writes so chunks land in order.
      this.pending = this.pending.then(() => appendChunk(this.draft, seq, event.data, durationMs))
    }
    recorder.start(CHUNK_MS)
  }

  static async start(fields: Pick<Draft, 'work' | 'chapter' | 'notes'>, callbacks: Callbacks): Promise<RecordingSession> {
    // Raw input: processing meant for calls (noise suppression, automatic
    // gain) changes the character of the voice being practiced.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    })
    try {
      const mimeType = MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) ?? ''
      const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: BITS_PER_SECOND })
      const draft = await createDraft(recorder.mimeType || mimeType || 'audio/webm', fields)
      return new RecordingSession(draft, stream, recorder, callbacks)
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop())
      throw err
    }
  }

  elapsedMs(): number {
    return this.accumulatedMs + (this.activeSince === null ? 0 : performance.now() - this.activeSince)
  }

  pause() {
    this.recorder.pause()
    this.accumulatedMs = this.elapsedMs()
    this.activeSince = null
  }

  resume() {
    this.recorder.resume()
    this.activeSince = performance.now()
  }

  /** Stops recording and returns the finished draft once every chunk is stored. */
  async stop(): Promise<Draft> {
    const durationMs = Math.round(this.elapsedMs())
    const stopped = new Promise<void>((resolve) => (this.recorder.onstop = () => resolve()))
    this.recorder.stop()
    await stopped // the final dataavailable fires before stop
    this.release()
    await this.pending
    this.draft = { ...this.draft, durationMs, finished: true }
    await updateDraft(this.draft)
    return this.draft
  }

  /** Stops without finishing; chunks already stored stay as a recoverable draft. */
  abort() {
    if (this.recorder.state !== 'inactive') this.recorder.stop()
    this.release()
  }

  private release() {
    window.clearInterval(this.timer)
    this.stream.getTracks().forEach((t) => t.stop())
    void this.audioContext.close()
  }
}
