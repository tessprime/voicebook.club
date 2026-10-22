import { useEffect, useMemo, useRef, useState } from 'react'

import { recordingDetail, setTranscript, type Recording, type RecordingDetail } from '../api'
import type { Session } from '../auth'
import { formatClock, formatDateTime, formatDuration, workLabel } from '../format'
import { transcribe, type TimedWord, type TranscriptionEndpoint } from '../transcription'
import '../vendor/voice-spectrogram/voice-spectrogram.js'
import type { SeekEvent, VoiceSpectrogram } from '../vendor/voice-spectrogram/voice-spectrogram'
import { audioBufferToWav, isWav } from '../wav'
import { TranscribeControls } from './TranscribeControls'

/**
 * Longest recording decoded, for the spectrogram and exact seeking. Decoded
 * audio takes 96 kB per second per channel at 24 kHz (about 170 MB for 15
 * minutes of stereo, while the WAV is made), plus 48 kB per second for the
 * WAV. Longer recordings play their own file (seeking may be off; see
 * wav.ts) and still show their words.
 */
const MAX_DECODE_SECONDS = 15 * 60
/**
 * Decoding rate, for both the spectrogram (up to 5 kHz) and playback: 24 kHz
 * keeps the voice up to 12 kHz, including sibilants and breath.
 */
const DECODE_SAMPLE_RATE = 24_000

type Audio =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; blob: Blob; url: string; buffer: AudioBuffer | null; tooLong: boolean }

type Transcribing = { kind: 'idle' } | { kind: 'busy' } | { kind: 'error'; message: string } | { kind: 'pending' }

/**
 * The selected recording: its audio with a spectrogram, and the transcript
 * with word timings. Render it with `key={recording.uri}`, so another
 * recording starts afresh.
 */
export function RecordingDetails({
  recording,
  playRequest,
  session,
  onClose,
  onChanged,
}: {
  recording: Recording
  /** Play once the audio is ready, once per new value (see selection.ts). */
  playRequest: number | null
  session: Session
  onClose: () => void
  /** The recording's record was changed (e.g. transcribed): lists should reload. */
  onChanged: () => void
}) {
  const [detail, setDetail] = useState<RecordingDetail | null>(null)
  const [transcribing, setTranscribing] = useState<Transcribing>({ kind: 'idle' })
  const [audio, setAudio] = useState<Audio>(recording.audioUrl ? { kind: 'loading' } : { kind: 'error' })
  const [wordIndex, setWordIndex] = useState(-1)
  const player = useRef<HTMLAudioElement>(null)
  const spectrogram = useRef<VoiceSpectrogram>(null)

  useEffect(() => {
    let stale = false
    recordingDetail(recording.uri).then(
      (d) => !stale && setDetail(d),
      () => !stale && setDetail(null),
    )
    return () => {
      stale = true
    }
  }, [recording.uri])

  // The whole file, fetched once. PDSes don't honor Range requests, so the
  // browser couldn't seek in a streamed file or find its duration. Decoded
  // for the spectrogram, and played as a WAV of the decoded audio, so seeking
  // (clicking a word or the spectrogram) lands exactly where it says.
  useEffect(() => {
    let stale = false
    let url: string | null = null
    const src = recording.audioUrl
    if (!src) return
    ;(async () => {
      const res = await fetch(src)
      if (!res.ok) throw new Error(String(res.status))
      const blob = await res.blob()
      if (stale) return
      const tooLong = (recording.durationMs ?? 0) > MAX_DECODE_SECONDS * 1000
      const buffer = tooLong ? null : await decode(blob).catch(() => null)
      const playable = buffer && !(await isWav(blob)) ? await audioBufferToWav(buffer) : blob
      if (stale) return
      url = URL.createObjectURL(playable)
      setAudio({ kind: 'ready', blob, url, buffer, tooLong })
    })().catch(() => !stale && setAudio({ kind: 'error' }))
    return () => {
      stale = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [recording.audioUrl, recording.durationMs])

  const words = detail?.transcriptWords ?? null
  const intervals = useMemo(() => (words ?? []).map((w) => ({ start: w.startMs / 1000, end: w.endMs / 1000, label: w.text })), [words])

  // Hand the element its data (it's set through properties, not attributes).
  useEffect(() => {
    const view = spectrogram.current
    if (!view || audio.kind !== 'ready' || !audio.buffer) return
    view.audio = audio.buffer
    view.words = intervals
  }, [audio, intervals])

  // While playing, move the cursor every frame; re-render only when the current word changes.
  useEffect(() => {
    const element = player.current
    if (!element || audio.kind !== 'ready') return
    let frame = 0
    const update = () => {
      const time = element.currentTime
      if (spectrogram.current) spectrogram.current.currentTime = time
      setWordIndex(currentWord(words, time * 1000))
    }
    // Runs every frame while playing, and once otherwise. A seek while playing
    // must keep it going (it used to stop here, freezing the cursor).
    const tick = () => {
      update()
      frame = element.paused || element.ended ? 0 : requestAnimationFrame(tick)
    }
    const restart = () => {
      cancelAnimationFrame(frame)
      tick()
    }
    const events = ['play', 'pause', 'seeked', 'ended'] as const
    for (const name of events) element.addEventListener(name, restart)
    return () => {
      cancelAnimationFrame(frame)
      for (const name of events) element.removeEventListener(name, restart)
    }
  }, [audio, words])

  useEffect(() => {
    const view = spectrogram.current
    if (!view) return
    const onSeek = (event: Event) => seek((event as SeekEvent).detail.time)
    view.addEventListener('seek', onSeek)
    return () => view.removeEventListener('seek', onSeek)
  }, [audio])

  // Play when asked to (the list's Play button), once the audio is ready.
  const played = useRef<number | null>(null)
  useEffect(() => {
    if (playRequest === null || playRequest === played.current || audio.kind !== 'ready') return
    played.current = playRequest
    player.current?.play().catch(() => undefined)
  }, [playRequest, audio])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function seek(seconds: number) {
    const element = player.current
    if (!element) return
    element.currentTime = seconds
    if (spectrogram.current) spectrogram.current.currentTime = seconds
  }

  // Only the author can change the record.
  const own = recording.did === session.did

  async function runTranscription(endpoint: TranscriptionEndpoint) {
    if (audio.kind !== 'ready') return
    if (transcript && !window.confirm('Replace the current transcript? Any edits made to it are lost.')) return
    setTranscribing({ kind: 'busy' })
    try {
      const result = await transcribe(endpoint, audio.blob)
      const updated = await setTranscript(session.agent, recording.uri, {
        text: result.text,
        ...(result.model ? { model: result.model } : {}),
        ...(result.words?.length ? { words: result.words } : {}),
      })
      if (updated) setDetail(updated)
      // Saved, but not indexed yet (Jetstream can lag): it shows on the next look.
      setTranscribing(updated?.transcript === result.text ? { kind: 'idle' } : { kind: 'pending' })
      onChanged()
    } catch (err) {
      setTranscribing({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  const duration = formatDuration(recording.durationMs)
  const transcript = detail?.transcript ?? recording.transcript
  const edited = words && transcript && transcript !== words.map((w) => w.text).join(' ')

  return (
    <aside className="recording-details" aria-label="Recording details">
      <div className="details-header">
        <div>
          <h2>{workLabel(recording.work, recording.chapter)}</h2>
          <p className="muted">
            @{recording.handle ?? recording.did} · {formatDateTime(recording.createdAt)}
            {duration && <> · {duration}</>}
          </p>
        </div>
        <button className="secondary icon" aria-label="Close details" onClick={onClose}>
          ✕
        </button>
      </div>
      {recording.notes && <p className="recording-notes">{recording.notes}</p>}

      {audio.kind === 'loading' && <p className="muted">Loading audio…</p>}
      {audio.kind === 'error' && <p className="error">Couldn’t load audio from the author’s server.</p>}
      {audio.kind === 'ready' && (
        <>
          {audio.buffer ? (
            // The pitch range only (75–500 Hz, log, so each octave gets equal
            // height): the pitch is drawn as dots (tracked with YIN), over the
            // narrowband analysis the element uses up to 2 kHz.
            <voice-spectrogram
              ref={spectrogram}
              colormap="magma"
              view-duration={8}
              frequency-scale="log"
              max-frequency={500}
              show-pitch="on"
              className="spectrogram"
            />
          ) : (
            <p className="muted">
              {audio.tooLong ? 'This recording is too long to draw.' : 'This browser couldn’t decode the audio to draw it.'}
            </p>
          )}
          <audio ref={player} controls src={audio.url} className="details-audio" />
        </>
      )}

      {(words || transcript || own) && (
        <div className="timed-transcript">
          <h3>Transcript</h3>
          {words ? (
            <>
              <p>
                {words.map((word, i) => (
                  <span
                    key={i}
                    className={i === wordIndex ? 'word current' : 'word'}
                    title={formatClock(word.startMs)}
                    onClick={() => seek(word.startMs / 1000)}
                  >
                    {word.text}{' '}
                  </span>
                ))}
              </p>
              {edited && (
                <details className="transcript">
                  <summary>Edited transcript</summary>
                  <p>{transcript}</p>
                </details>
              )}
            </>
          ) : transcript ? (
            <>
              <p className="plain">{transcript}</p>
              <p className="muted hint">No word timings for this transcript.</p>
            </>
          ) : (
            <p className="muted">No transcript yet.</p>
          )}
          {own && (
            <TranscribeControls
              busy={transcribing.kind === 'busy'}
              disabled={audio.kind !== 'ready'}
              disabledReason="Waiting for the audio"
              again={!!transcript}
              error={transcribing.kind === 'error' ? transcribing.message : null}
              onTranscribe={runTranscription}
            />
          )}
          {transcribing.kind === 'pending' && <p className="muted hint">Saved. It may take a moment to show here.</p>}
        </div>
      )}
    </aside>
  )
}

/** Decodes to mono-ish samples at a modest rate (the element mixes channels down). */
async function decode(blob: Blob): Promise<AudioBuffer> {
  const context = new OfflineAudioContext(1, 1, DECODE_SAMPLE_RATE)
  return context.decodeAudioData(await blob.arrayBuffer())
}

/** The word being spoken at `ms`, or -1 (binary search; words are in order). */
function currentWord(words: TimedWord[] | null, ms: number): number {
  if (!words) return -1
  let low = 0
  let high = words.length - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    if (words[mid].endMs <= ms) low = mid + 1
    else if (words[mid].startMs > ms) high = mid - 1
    else return mid
  }
  return -1
}
