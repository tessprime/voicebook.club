import { useEffect, useState } from 'react'

import { formatDuration } from '../format'

type State = { kind: 'idle' } | { kind: 'loading' } | { kind: 'ready'; url: string } | { kind: 'error' }

/**
 * Plays a blob served by a PDS. PDSes don't honor Range requests, so the
 * browser can't seek in a streamed Ogg file or find its duration; fetching the
 * whole file into an object URL first makes it fully seekable.
 */
export function AudioPlayer({ src, durationMs }: { src: string; durationMs: number | null }) {
  const [state, setState] = useState<State>({ kind: 'idle' })

  useEffect(() => {
    return () => {
      if (state.kind === 'ready') URL.revokeObjectURL(state.url)
    }
  }, [state])

  async function load() {
    setState({ kind: 'loading' })
    try {
      const res = await fetch(src)
      if (!res.ok) throw new Error(String(res.status))
      setState({ kind: 'ready', url: URL.createObjectURL(await res.blob()) })
    } catch {
      setState({ kind: 'error' })
    }
  }

  if (state.kind === 'ready') return <audio controls autoPlay src={state.url} />
  if (state.kind === 'error') {
    return (
      <span className="error">
        Couldn’t load audio from the author’s server.{' '}
        <button className="secondary" onClick={load}>
          Retry
        </button>
      </span>
    )
  }
  return (
    <button className="secondary play" onClick={load} disabled={state.kind === 'loading'}>
      {state.kind === 'loading' ? 'Loading…' : `▶ Play${durationMs ? ` (${formatDuration(durationMs)})` : ''}`}
    </button>
  )
}
