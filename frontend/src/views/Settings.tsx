import { useState, type FormEvent } from 'react'

import {
  SCHEMAS,
  endpointHost,
  endpointProblem,
  listModels,
  loadEndpoints,
  newEndpointId,
  saveEndpoints,
  type SchemaId,
  type TranscriptionEndpoint,
} from '../transcription'

const EMPTY: TranscriptionEndpoint = { id: '', name: '', url: '', schema: 'openai', model: '', apiKey: '' }

type Check = { kind: 'idle' } | { kind: 'checking' } | { kind: 'ok' | 'error'; message: string }

export function Settings() {
  const [endpoints, setEndpoints] = useState(loadEndpoints)
  // The endpoint being added or edited, or null.
  const [editing, setEditing] = useState<TranscriptionEndpoint | null>(null)
  const [check, setCheck] = useState<Check>({ kind: 'idle' })
  const [error, setError] = useState<string | null>(null)

  function store(next: TranscriptionEndpoint[]): boolean {
    try {
      saveEndpoints(next)
    } catch {
      setError('This browser won’t store settings (private browsing or blocked site data?).')
      return false
    }
    setEndpoints(next)
    setError(null)
    return true
  }

  function edit(endpoint: TranscriptionEndpoint | null) {
    setEditing(endpoint)
    setCheck({ kind: 'idle' })
  }

  function save(event: FormEvent) {
    event.preventDefault()
    if (!editing) return
    const endpoint = { ...editing, name: editing.name.trim(), url: editing.url.trim(), model: editing.model.trim(), apiKey: editing.apiKey.trim() }
    const next = endpoint.id
      ? endpoints.map((e) => (e.id === endpoint.id ? endpoint : e))
      : [...endpoints, { ...endpoint, id: newEndpointId() }]
    if (store(next)) edit(null)
  }

  function remove(endpoint: TranscriptionEndpoint) {
    if (!window.confirm(`Remove ${endpoint.name || endpointHost(endpoint)}? Its API key is deleted from this browser.`)) return
    store(endpoints.filter((e) => e.id !== endpoint.id))
    if (editing?.id === endpoint.id) edit(null)
  }

  async function test() {
    if (!editing) return
    setCheck({ kind: 'checking' })
    try {
      const models = await listModels({ ...editing, url: editing.url.trim(), apiKey: editing.apiKey.trim() })
      setCheck({
        kind: 'ok',
        message: models.length ? `Connected. Models: ${models.slice(0, 8).join(', ')}${models.length > 8 ? ', …' : ''}` : 'Connected, but the server didn’t list any models.',
      })
    } catch (err) {
      setCheck({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  const problem = editing?.url.trim() ? endpointProblem(editing.url.trim()) : null
  const schema = editing ? SCHEMAS[editing.schema] : null

  return (
    <section className="settings">
      <h2>Transcription</h2>
      <p className="muted">
        Speech-to-text services that can fill in a recording’s transcript. Pressing <strong>Transcribe</strong> sends
        that recording to the service you pick; nothing is sent otherwise. Transcripts you save are public, like your
        recordings.
      </p>
      <p className="muted">
        These settings, including API keys, are kept only in this browser. They’re never sent to Voicebook or saved to
        your Bluesky account. Remove them before leaving a shared computer.
      </p>
      {error && <p className="error">{error}</p>}

      {endpoints.length > 0 ? (
        <ul className="endpoints">
          {endpoints.map((endpoint) => (
            <li key={endpoint.id} className="panel endpoint">
              <span>
                <strong>{endpoint.name || endpointHost(endpoint)}</strong>
                <span className="muted">
                  {' '}
                  {endpointHost(endpoint)}
                  {endpoint.model && ` · ${endpoint.model}`}
                  {endpoint.apiKey && ' · API key set'}
                </span>
              </span>
              <span className="actions">
                <button className="secondary" onClick={() => edit(endpoint)}>
                  Edit
                </button>
                <button className="secondary" onClick={() => remove(endpoint)}>
                  Remove
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        !editing && <p>No transcription services set up.</p>
      )}

      {editing ? (
        <form className="panel endpoint-form" onSubmit={save} autoComplete="off">
          <h3>{editing.id ? 'Edit service' : 'Add a service'}</h3>
          <label>
            Name
            <input value={editing.name} onChange={(e) => edit({ ...editing, name: e.target.value })} placeholder="e.g. My Whisper server" />
          </label>
          <label>
            API type
            <select value={editing.schema} onChange={(e) => edit({ ...editing, schema: e.target.value as SchemaId })}>
              {Object.entries(SCHEMAS).map(([id, s]) => (
                <option key={id} value={id}>
                  {s.label}
                </option>
              ))}
            </select>
            {schema && <span className="muted hint">{schema.description}</span>}
          </label>
          <label>
            Transcription URL
            <input
              required
              type="url"
              value={editing.url}
              onChange={(e) => edit({ ...editing, url: e.target.value })}
              placeholder={schema?.placeholder}
            />
          </label>
          {problem && <p className="error">{problem}</p>}
          <label>
            Model <span className="muted">(optional: the server’s first speech model if empty)</span>
            <input value={editing.model} onChange={(e) => edit({ ...editing, model: e.target.value })} placeholder="whisper-1" />
          </label>
          <label>
            API key <span className="muted">(optional; stored in this browser)</span>
            <input
              type="password"
              value={editing.apiKey}
              onChange={(e) => edit({ ...editing, apiKey: e.target.value })}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          {check.kind === 'checking' && <p className="muted">Checking…</p>}
          {check.kind === 'ok' && <p className="muted">{check.message}</p>}
          {check.kind === 'error' && <p className="error">{check.message}</p>}
          <div className="actions">
            <button type="button" className="secondary" onClick={() => edit(null)}>
              Cancel
            </button>
            <button type="button" className="secondary" onClick={test} disabled={!editing.url.trim() || !!problem || check.kind === 'checking'}>
              Test connection
            </button>
            <button type="submit" disabled={!editing.url.trim() || !!problem}>
              Save
            </button>
          </div>
        </form>
      ) : (
        <button onClick={() => edit(EMPTY)}>Add a transcription service</button>
      )}
    </section>
  )
}
