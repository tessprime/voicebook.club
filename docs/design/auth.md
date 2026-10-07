# Authentication and authorization

How the backend knows who is calling, and what they may do. The code is in
`backend/src/auth.rs` (tokens and sessions), `backend/src/access.rs`
(allowlist and admins) and `backend/src/api.rs` (enforcement); the frontend
side is in `frontend/src/api.ts` and `frontend/src/App.tsx`.

## Two separate sign-ins

1. **OAuth, browser ↔ the user's PDS.** The browser signs in to the user's
   own PDS (e.g. bsky.social) with ATProto OAuth. The resulting access token is
   for the PDS only: its audience is the PDS, and it's bound to a key that
   lives only in that browser (DPoP). The browser uses it to write recordings
   and upload audio. **Our backend never sees it**, and couldn't use it.
2. **Service auth, browser ↔ our backend.** To prove to the backend who it is,
   the browser asks the PDS for a *service-auth token*: a short-lived JWT,
   signed with the account's own key, addressed to our service and bound to
   one method. The backend checks it and creates a session cookie.

ATProto designed service auth for exactly this: an app's own backend
verifying users without ever holding their PDS credentials.

## Creating a session

```text
browser                         user's PDS                       Voicebook backend
   │ GET /api/session ─────────────────────────────────────────────▶│
   │◀──────────────────── { audience, lxm, did: null } ─────────────│
   │ getServiceAuth(aud, lxm, exp=60s) ─▶│                          │
   │◀──────────────── JWT ───────────────│                          │
   │ POST /api/session  Authorization: Bearer <JWT> ───────────────▶│ verify (below)
   │◀────────── Set-Cookie: vb_session=…; HttpOnly; SameSite=Strict │
```

- **Audience:** `<serviceDid>#voicebook`. `serviceDid` is set per
  environment (`did:web:voicebook.club` deployed, `did:web:localhost`
  locally); the backend serves its DID document at `/.well-known/did.json`.
- **Method (`lxm`):** `club.voicebook.auth.createSession`. The PDS issues
  method-bound tokens for up to an hour; we request 60 seconds.
- **OAuth scope:** the browser must be allowed to request such tokens:
  `rpc:club.voicebook.auth.createSession?aud=*`. A wildcard audience is fine
  because the method is ours and the backend checks the audience. (The PDS
  forbids only `rpc:*?aud=*`.) OAuth sessions from before this scope existed
  can't get tokens; the app asks those users to sign in again.

### Verification

The backend accepts a token only if all of these hold:

- it's a JWT with algorithm `ES256K` (secp256k1) or `ES256` (P-256), matching
  the account's key type: nothing else, never `none`;
- `iss` is an account DID (`did:plc:…`/`did:web:…`, no fragment), resolved
  through the SSRF-guarded client; the key is the DID document's `#atproto`
  Multikey;
- the signature verifies and is **low-S** (ATProto rejects malleable
  signatures; the `ecdsa` crate only enforces this for secp256k1, so we check
  both curves explicitly);
- `aud` is exactly our audience, `lxm` exactly our method;
- `exp` is in the future and at most an hour out; `iat`, if present, isn't in
  the future (60 s clock-skew allowance);
- `iss` is admitted (allowlist or admin). Checked right after the claims above
  and **before** anything is fetched: anyone can post tokens naming any DID,
  and resolving it means network requests (for `did:web`, to a host of the
  sender's choosing). Uninvited issuers get 403 `not_invited` without a
  signature check. The cost, accepted on purpose: whether a DID is invited is
  observable without a valid token (the allowlist is meant to become public).
  The log line for these (`sign-in attempt for an account not on the
  allowlist`) records the DID as `unverified_did`;
- `jti` hasn't been used: each token creates one session (checked after the
  signature, so forged tokens can't burn IDs).

Failures return 401 and log the reason as a warning; the response doesn't say
which check failed.

### Sessions

- A random 256-bit token in the `vb_session` cookie; SQLite stores only its
  SHA-256 hash, with the DID and an expiry **30 days** out.
- Cookie: `HttpOnly; SameSite=Strict; Path=/`, plus `Secure` everywhere
  except plain-HTTP loopback (local development). Behind a TLS-terminating
  proxy the request looks like plain HTTP, so `Secure` is decided by the
  `Host`: the proxy must pass it through.
- `DELETE /api/session` signs out of the backend; the frontend also signs out
  of the PDS. Expired sessions are deleted periodically.
- Sessions are the one thing in SQLite that isn't rebuilt from ATProto, but
  losing them is harmless: on a 401 the frontend gets a new service-auth token
  and retries, invisibly.

## Authorization

Every `/api` route requires a session, except `GET /api/health` and the
session endpoints. Static files, `/client-metadata.json` and
`/.well-known/did.json` are public.

| | Rule |
|---|---|
| Any API request | Session from an admitted account (allowlist or admin), checked on every request, so withdrawing an invite takes effect immediately |
| Per-account reads (`/api/users/{did}/…`) | The account read must be admitted too |
| `POST /api/members/{did}/refresh` | Your own account; any account if you're an admin |
| `POST /api/admin/reindex` | Admins only |

- **Allowlist** (`access.allowlist`, DIDs): who may use the instance during
  the closed beta. Unset means open (development). See `deploy/README.md`.
- **Admins** (`access.admins`, DIDs): always admitted; may refresh any account
  and reindex.
- At startup, members and sessions of accounts no longer admitted are
  removed.

### CSRF and CORS

- Requests that change something (anything but GET/HEAD) must carry an
  `x-voicebook-csrf` header. Browsers don't let other sites add custom headers
  to cross-site requests without CORS approval, and the backend never grants
  any (there's no CORS layer: the frontend is same-origin everywhere, with
  Vite proxying `/api` in development). `SameSite=Strict` is the second layer.
- `POST /api/session` doesn't need the header: it authenticates with the
  bearer token, which another site can't obtain.

## Endpoints

Each is documented in detail, with a sequence diagram, in
[`../api/`](../api/README.md).

| Endpoint | Auth | |
|---|---|---|
| `GET /api/session` | none | Who's signed in (if anyone); the audience and method a token must name |
| `POST /api/session` | service-auth bearer token | Create a session; 401 for a bad token, 403 `not_invited` |
| `DELETE /api/session` | cookie, CSRF header | Sign out |

## Not yet

See also the open items in [`security.md`](security.md).

- Rate limiting (per IP, in memory) for `POST /api/session` and refresh.
- Listing or revoking a user's sessions (other than signing out).
- Admin tools beyond refresh and reindex.
