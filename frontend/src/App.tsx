import { useEffect, useState, type FormEvent } from 'react'

import { initSession, signIn, signOut, type Session } from './auth'
import { Friends } from './views/Friends'
import { Practice } from './views/Practice'
import { Recordings } from './views/Recordings'

const TABS = ['Practice', 'Recordings', 'Friends'] as const
type Tab = (typeof TABS)[number]

type AuthState = { kind: 'loading' } | { kind: 'signed-out'; error?: string } | { kind: 'signed-in'; session: Session; handle?: string }

export default function App() {
  const [auth, setAuth] = useState<AuthState>({ kind: 'loading' })
  const [tab, setTab] = useState<Tab>('Practice')

  useEffect(() => {
    initSession().then(
      async (session) => {
        if (!session) return setAuth({ kind: 'signed-out' })
        setAuth({ kind: 'signed-in', session })
        const profile = await session.agent.com.atproto.repo.describeRepo({ repo: session.did }).catch(() => undefined)
        if (profile) setAuth({ kind: 'signed-in', session, handle: profile.data.handle })
      },
      (err) => setAuth({ kind: 'signed-out', error: `Sign-in failed: ${err instanceof Error ? err.message : String(err)}` }),
    )
  }, [])

  if (auth.kind === 'loading') return <main className="centered muted">Loading…</main>
  if (auth.kind === 'signed-out') return <SignIn error={auth.error} />

  const { session, handle } = auth
  return (
    <>
      <header>
        <span className="brand">Voicebook</span>
        <nav>
          {TABS.map((t) => (
            <button key={t} className={t === tab ? 'tab active' : 'tab'} aria-current={t === tab ? 'page' : undefined} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </nav>
        <span className="account">
          <span className="muted" title={session.did}>
            @{handle ?? session.did}
          </span>
          <button
            className="secondary"
            onClick={async () => {
              await signOut(session)
              setAuth({ kind: 'signed-out' })
            }}
          >
            Sign out
          </button>
        </span>
      </header>
      <main>
        {tab === 'Practice' && <Practice session={session} />}
        {tab === 'Recordings' && <Recordings session={session} />}
        {tab === 'Friends' && <Friends session={session} />}
      </main>
    </>
  )
}

function SignIn({ error }: { error?: string }) {
  const [handle, setHandle] = useState('')
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState(error)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setPending(true)
    setFailure(undefined)
    try {
      await signIn(handle) // navigates away to the PDS's sign-in page
    } catch (err) {
      setPending(false)
      setFailure(`Couldn’t start sign-in for “${handle}”: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return (
    <main className="centered">
      <form className="panel sign-in" onSubmit={submit}>
        <h1>Voicebook</h1>
        <p className="muted">Practice reading aloud, and see who you follow practicing too.</p>
        <label>
          Your Bluesky handle
          <input autoFocus required value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="alice.test" autoComplete="username" disabled={pending} />
        </label>
        {failure && (
          <p className="error" role="alert">
            {failure}
          </p>
        )}
        <button type="submit" disabled={pending || !handle.trim()}>
          {pending ? 'Redirecting…' : 'Sign in'}
        </button>
      </form>
    </main>
  )
}
