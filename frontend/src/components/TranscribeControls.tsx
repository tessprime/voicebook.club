import { useState } from 'react'

import { chooseEndpoint, chosenEndpoint, endpointHost, loadEndpoints, type TranscriptionEndpoint } from '../transcription'

/**
 * A Transcribe button with the service it will send the audio to (a picker
 * when there are several), or a pointer to Settings when there are none.
 */
export function TranscribeControls({
  busy,
  disabled = false,
  disabledReason,
  again,
  error,
  onTranscribe,
}: {
  busy: boolean
  disabled?: boolean
  /** Shown as the button's tooltip while disabled. */
  disabledReason?: string
  /** Whether there's a transcript already (the button says "Transcribe again"). */
  again: boolean
  error: string | null
  onTranscribe: (endpoint: TranscriptionEndpoint) => void
}) {
  const [endpoints] = useState(loadEndpoints)
  const [endpoint, setEndpoint] = useState(() => chosenEndpoint(endpoints))

  if (!endpoint) return <p className="muted hint">To transcribe recordings, add a transcription service in Settings.</p>
  return (
    <>
      <div className="transcribe-row">
        <button
          type="button"
          className="secondary"
          onClick={() => onTranscribe(endpoint)}
          disabled={busy || disabled}
          title={disabled ? disabledReason : undefined}
        >
          {busy ? 'Transcribing…' : again ? 'Transcribe again' : 'Transcribe'}
        </button>
        {endpoints.length > 1 ? (
          <select
            aria-label="Transcription service"
            value={endpoint.id}
            onChange={(e) => {
              setEndpoint(endpoints.find((x) => x.id === e.target.value) ?? endpoint)
              chooseEndpoint(e.target.value)
            }}
            disabled={busy}
          >
            {endpoints.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name || endpointHost(x)}
              </option>
            ))}
          </select>
        ) : (
          <span className="muted">with {endpoint.name || endpointHost(endpoint)}</span>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          Couldn’t transcribe: {error}
        </p>
      )}
    </>
  )
}
