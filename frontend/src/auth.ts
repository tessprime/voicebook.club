// ATProto OAuth in the browser. The session (including its non-extractable
// DPoP key) lives in IndexedDB; the backend never sees it.

import { Agent } from '@atproto/api'
import { BrowserOAuthClient, type OAuthSession } from '@atproto/oauth-client-browser'

// Write access to Voicebook recordings and audio uploads only. Deployed, the
// scope comes from the backend's client metadata (OAUTH_SCOPE in
// backend/src/web.rs); keep the two in sync.
const GRANULAR_SCOPE = 'atproto repo:club.voicebook.recording blob:audio/*'

const plcDirectoryUrl = import.meta.env.VITE_PLC_URL
const handleResolver = import.meta.env.VITE_HANDLE_RESOLVER ?? 'https://bsky.social'

const LOOPBACK_HOSTS = ['127.0.0.1', '[::1]', 'localhost']

// OAuth redirects for loopback clients must use an IP address, and the
// session is stored per origin, so move localhost to 127.0.0.1 up front.
if (window.location.hostname === 'localhost') {
  window.location.replace(window.location.href.replace('//localhost', '//127.0.0.1'))
}

/**
 * Locally (127.0.0.1) the app is a loopback client: the client ID encodes its
 * own metadata, so nothing needs registering or hosting. Deployed, the client
 * ID is the URL of the metadata document the backend serves.
 */
function clientId(): string {
  const { hostname, port, origin } = window.location
  if (!LOOPBACK_HOSTS.includes(hostname)) return `${origin}/client-metadata.json`
  const redirectUri = `http://127.0.0.1${port ? `:${port}` : ''}/`
  return `http://localhost?redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(GRANULAR_SCOPE)}`
}

let clientPromise: Promise<BrowserOAuthClient> | undefined

function client(): Promise<BrowserOAuthClient> {
  clientPromise ??= BrowserOAuthClient.load({
    clientId: clientId(),
    handleResolver,
    plcDirectoryUrl,
    // The local PDS is plain HTTP.
    allowHttp: plcDirectoryUrl?.startsWith('http:') ?? false,
  })
  return clientPromise
}

export type Session = {
  did: string
  agent: Agent
  oauth: OAuthSession
}

let initPromise: Promise<Session | undefined> | undefined

/**
 * Restores an existing session or completes a sign-in redirect. Memoized:
 * the OAuth callback can only be processed once.
 */
export function initSession(): Promise<Session | undefined> {
  initPromise ??= client()
    .then((c) => c.init())
    .then((result) => {
      if (!result) return undefined
      if ('state' in result) {
        // Drop the OAuth response parameters from the address bar.
        window.history.replaceState(null, '', window.location.pathname)
      }
      return toSession(result.session)
    })
  return initPromise
}

export async function signIn(handle: string): Promise<never> {
  return (await client()).signInRedirect(handle.trim().replace(/^@/, ''))
}

export async function signOut(session: Session): Promise<void> {
  await session.oauth.signOut()
}

function toSession(oauth: OAuthSession): Session {
  return { did: oauth.did, agent: new Agent(oauth), oauth }
}
