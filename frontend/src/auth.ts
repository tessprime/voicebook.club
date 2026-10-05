// ATProto OAuth in the browser. The session (including its non-extractable
// DPoP key) lives in IndexedDB; the backend never sees it.

import { Agent } from '@atproto/api'
import { BrowserOAuthClient, type OAuthSession } from '@atproto/oauth-client-browser'

// Write access to Voicebook recordings and audio uploads only.
const GRANULAR_SCOPE = 'atproto repo:club.voicebook.recording blob:audio/*'

const plcDirectoryUrl = import.meta.env.VITE_PLC_URL
const handleResolver = import.meta.env.VITE_HANDLE_RESOLVER ?? 'https://bsky.social'

function loopbackClientId(scope: string): string {
  // A loopback client ID encodes its own metadata, so it needs no
  // registration or hosted client-metadata.json.
  const redirectUri = `http://127.0.0.1:${window.location.port}/`
  return `http://localhost?redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}`
}

let clientPromise: Promise<BrowserOAuthClient> | undefined

function client(): Promise<BrowserOAuthClient> {
  clientPromise ??= BrowserOAuthClient.load({
    clientId: loopbackClientId(GRANULAR_SCOPE),
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
