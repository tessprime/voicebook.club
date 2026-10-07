import { useEffect, useState, type FormEvent } from 'react'

import { NotInvitedError, backendSession, refreshMember, setReauthenticate, signInToBackend, signOutOfBackend } from './api'
import { initSession, signIn, signOut, type Session } from './auth'
import { Friends } from './views/Friends'
import { Practice } from './views/Practice'
import { Recordings } from './views/Recordings'

const TABS = ['Practice', 'Recordings', 'Friends'] as const
type Tab = (typeof TABS)[number]

type AuthState =
  | { kind: 'loading' }
  | { kind: 'signed-out'; error?: string }
  | { kind: 'not-invited'; session: Session; handle?: string }
  | { kind: 'signed-in'; session: Session; handle?: string }

export default function App() {
  const [auth, setAuth] = useState<AuthState>({ kind: 'loading' })
  const [tab, setTab] = useState<Tab>('Practice')
  // Bumped when the backend has re-read the user's repo, to reload the views.
  const [dataVersion, setDataVersion] = useState(0)

  useEffect(() => {
    initSession().then(
      async (session) => {
        if (!session) return setAuth({ kind: 'signed-out' })
        const handle = await session.agent.com.atproto.repo
          .describeRepo({ repo: session.did })
          .then((r) => r.data.handle)
          .catch(() => undefined)
        // Prove the identity to the backend (unless it already knows it).
        try {
          const current = await backendSession()
          if (current.did !== session.did) await signInToBackend(session.agent)
        } catch (err) {
          if (err instanceof NotInvitedError) return setAuth({ kind: 'not-invited', session, handle })
          // Typically an OAuth session from before the backend sign-in scope
          // existed: signing in again grants it.
          await signOut(session).catch(() => undefined)
          return setAuth({
            kind: 'signed-out',
            error: `Please sign in again to continue (${err instanceof Error ? err.message : String(err)}).`,
          })
        }
        // Backend sessions can expire or be lost; get a new one on demand.
        setReauthenticate(() => signInToBackend(session.agent).then(() => undefined))
        setAuth({ kind: 'signed-in', session, handle })
        refreshMember(session.did).then(
          () => setDataVersion((v) => v + 1),
          () => undefined, // Jetstream will catch up eventually
        )
      },
      (err) => setAuth({ kind: 'signed-out', error: `Sign-in failed: ${err instanceof Error ? err.message : String(err)}` }),
    )
  }, [])

  if (auth.kind === 'loading') return <main className="centered muted">Loading…</main>
  if (auth.kind === 'signed-out') return <SignIn error={auth.error} />
  if (auth.kind === 'not-invited') {
    return <NotInvited handle={auth.handle ?? auth.session.did} onSignOut={() => signOut(auth.session).then(() => setAuth({ kind: 'signed-out' }))} />
  }

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
              setReauthenticate(undefined)
              await signOutOfBackend().catch(() => undefined)
              await signOut(session)
              setAuth({ kind: 'signed-out' })
            }}
          >
            Sign out
          </button>
        </span>
      </header>
      <main>
        {tab === 'Practice' && <Practice session={session} dataVersion={dataVersion} />}
        {tab === 'Recordings' && <Recordings session={session} dataVersion={dataVersion} />}
        {tab === 'Friends' && <Friends session={session} dataVersion={dataVersion} />}
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

function NotInvited({ handle, onSignOut }: { handle: string; onSignOut: () => void }) {
  return (
    <main className="centered">
      <div className="panel sign-in">
        <h1>Voicebook</h1>
        <p>Voicebook is invite-only during the beta, and @{handle} isn’t on the list yet.</p>
        <p className="muted">Nothing was saved to your account.</p>
        <button onClick={onSignOut}>Sign out</button>
      </div>
    </main>
  )
}
