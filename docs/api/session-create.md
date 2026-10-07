# `POST /api/session`

Signs the browser in to the backend: exchanges an ATProto **service-auth
token** for a session cookie. The token proves the caller controls the
account, without the backend ever seeing the user's PDS credentials. The full
design is in [`../design/auth.md`](../design/auth.md).

- **Auth:** `Authorization: Bearer <service-auth JWT>`. No CSRF header
  needed: another site can't obtain the token.
- **Implemented in:** `create_session` in `backend/src/api.rs`;
  verification in `ServiceAuth::verify` (`backend/src/auth.rs`).

## Request

The frontend first asks the user's PDS for the token, with the `audience` and
`lxm` from [`GET /api/session`](session-get.md):

```js
const { data } = await agent.com.atproto.server.getServiceAuth({
  aud: 'did:web:voicebook.club#voicebook',
  lxm: 'club.voicebook.auth.createSession',
  exp: Math.floor(Date.now() / 1000) + 60,
})
```

```http
POST /api/session
Authorization: Bearer eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NksifQ.eyJpYXQiOjE3OTEzMzMyMDAsImlzcyI6ImRpZDpwbGM6…
```

## Response

`200 OK`, with the cookie:

```http
Set-Cookie: __Host-vb_session=…; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000; Secure
```

```json
{
  "did": "did:plc:oq6rkprwln2i4rtv5gcignb6",
  "admin": true,
  "audience": "did:web:voicebook.club#voicebook",
  "lxm": "club.voicebook.auth.createSession"
}
```

- The session lasts 30 days. Only a SHA-256 hash of its token is stored.
- On plain-HTTP loopback hosts (local development) the cookie is
  `vb_session`, without `Secure`; `__Host-` cookies require it.

## Errors

| Status | `error` | When |
|---|---|---|
| 401 | `not_signed_in` | No bearer token, or the token fails any check below. The reason is logged (`service-auth token rejected`), not returned. |
| 403 | `not_invited` | The token's `iss` isn't on the allowlist. Checked before the signature, so nothing is fetched for uninvited accounts; the log line `sign-in attempt for an account not on the allowlist` records the DID as unverified. |
| 429 | `too_many_sign_ins` | This minute's budget of 60 sign-in DID resolutions (all callers) is spent; `Retry-After: 60`. Nothing was fetched. |
| 500 | `internal error` | The session couldn't be stored |

The token must: name exactly our audience and method; not be expired, issued
in the future, or valid for more than an hour; name an admitted `iss` (checked
before anything is fetched); be a JWT signed with ES256K or ES256 matching the
account's `#atproto` key, with a low-S signature; and have a `jti` not used
before.

## Sequence

```mermaid
sequenceDiagram
    participant B as Browser
    participant P as User's PDS
    participant A as Backend
    participant L as PLC directory
    participant D as SQLite
    B->>P: getServiceAuth(aud, lxm, exp = now+60s) [OAuth, DPoP]
    P->>P: check OAuth scope rpc:club.voicebook.auth.createSession
    P-->>B: JWT signed with the account's key
    B->>A: POST /api/session, Authorization: Bearer JWT
    A->>A: parse header and claims, then check aud, lxm, exp, iat
    alt iss not on the allowlist (unverified)
        A-->>B: 403 not_invited, nothing fetched
    end
    alt sign-in resolution budget spent this minute
        A-->>B: 429 too_many_sign_ins, Retry-After 60
    end
    A->>L: GET /{iss} (SSRF-guarded)
    L-->>A: DID document
    A->>A: #atproto key → verify signature (ES256K/ES256, low-S)
    A->>A: jti unused? record it
    alt any check fails
        A-->>B: 401 not_signed_in
    end
    A->>D: INSERT INTO sessions (sha256(token), did, expires in 30 days)
    A-->>B: 200 {did, admin, …} + Set-Cookie: __Host-vb_session
```
