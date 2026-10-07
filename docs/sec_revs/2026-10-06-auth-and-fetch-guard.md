# Security review: authentication, API authorization, fetch guard

- **Date:** 2026-10-06
- **Reviewer:** Claude (Opus 5.5), at the maintainer's request
- **Scope:** `backend/src/auth.rs`, `backend/src/api.rs`,
  `backend/src/fetch_guard.rs` as of commit `5e03216`, read in full; with
  their use of `reqwest` (0.13.5) and `backend/src/web.rs` where relevant.
- **Method:** manual read-through against the design in
  [`../design/auth.md`](../design/auth.md) and the checklist in
  [`../design/security.md`](../design/security.md), checking library
  behavior in the dependency sources where it mattered.
- **Result:** no high- or medium-severity findings; five low-severity
  findings (one narrower than first reported), all fixed (see [Resolution](#resolution)).

## What was checked and holds

- **Service-auth token verification:** algorithm bound to the key type (no
  `none`, no HMAC); low-S signatures on both curves; exact 64-byte signatures;
  exact `aud` and `lxm`; expiry, lifetime and issued-at limits with a 60 s
  skew; `iss` restricted to plain account DIDs; allowlist checked before any
  fetch; token IDs consumed only after the signature verifies, under a lock
  (no double-spend race).
- **Sessions:** 256-bit random tokens from the OS; only SHA-256 hashes
  stored; a fresh token per sign-in; expiry enforced in the lookup query; the
  allowlist re-checked on every request.
- **Authorization:** every protected route passes `require_session`; refresh
  compares the decoded path DID with the session's DID (admins excepted);
  reindex is admin-only; per-account reads also check the target account.
- **CSRF:** custom header required on every state-changing method; no CORS
  layer, so other origins can't send it; `SameSite=Strict` as a second layer;
  `POST /api/session` authenticates with a bearer token that other sites can't
  obtain.
- **SQL:** all values are bound parameters, including the `IN (…)` list and
  the `before` timestamp; the only formatted query text is a constant.
- **Fetch guard:** hostname checks happen in the DNS resolver, so the
  connection goes to a checked address (no DNS-rebinding gap); IP literals
  are checked up front, including numeric forms such as `2130706433`, which
  the URL parser normalizes to IPv4; redirects are checked; IPv4-embedding
  IPv6 forms (mapped, 6to4, NAT64, Teredo, compatible) are covered;
  `localhost` names refused; response size and time are capped.

## Findings

### L1. An environment proxy bypasses the fetch guard's DNS check

- **Where:** `fetch_guard.rs`, `client()`.
- **Severity:** Low (the environment is trusted, but the failure is silent).
- **Description:** `reqwest` uses `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`
  from the environment by default (`auto_sys_proxy: true` in 0.13.5). With a
  proxy configured, the proxy resolves hostnames, so `PublicOnlyResolver`
  never runs; only the scheme and IP-literal checks would still apply.
- **Scenario:** the container runs on a host or platform that sets a proxy
  variable for unrelated reasons. A DID document naming
  `https://internal-service.example` (resolving to a private address) is then
  fetched through the proxy, and the SSRF guard is effectively off.
- **Fix:** `no_proxy()` on the guarded client.

### L2. The session cookie can be planted from a sibling subdomain

- **Where:** `api.rs`, `session_cookie_header` and `session_cookie`.
- **Severity:** Low (no sibling subdomains exist today; the frontend limits
  the impact).
- **Description:** any host under the parent domain can set a cookie named
  `vb_session` for the whole domain ("cookie tossing"), planting the
  attacker's own session in a victim's browser (session fixation).
- **Scenario:** a future `blog.voicebook.club`, or a compromised staging host,
  sets `vb_session=<attacker's token>; Domain=voicebook.club`. The victim's
  API calls then run as the attacker. The frontend compares the backend
  session's DID with its OAuth DID and re-signs in on a mismatch, and writes go
  to the victim's own PDS, so the impact is limited, but the server should
  not accept a cookie a subdomain could set.
- **Fix:** over HTTPS the cookie is named `__Host-vb_session`. Browsers
  accept that name only from the same host, with `Secure`, `Path=/` and no
  `Domain`, so no subdomain can set it; and over HTTPS the server reads only
  that name. Plain-HTTP loopback (local development) keeps `vb_session`.

### L3. Host-derived documents could poison a shared cache

- **Where:** `web.rs`, `client_metadata` and `did_document`, when `publicUrl`
  isn't configured.
- **Severity:** Low (requires a misbehaving cache in front).
- **Description:** without `publicUrl`, the documents' URLs come from the
  request's `Host` header. A forged `Host` alone only affects the forger's own
  response, but a cache or CDN that keys entries without `Host` could store a
  forged copy and serve it to authorization servers.
- **Scenario:** `curl -H 'Host: evil.example' https://voicebook.club/client-metadata.json`
  through a cache that ignores `Host`; later fetches get metadata whose
  `client_id` and `redirect_uris` name `evil.example`, breaking sign-in (or,
  with a sloppy authorization server, redirecting codes elsewhere).
- **Fix:** responses derived from `Host` carry `Cache-Control: no-store` and
  `Vary: Host`. Setting `publicUrl` in a production config removes the `Host`
  dependence entirely (recommended once the domain is final; the fallback is
  kept for staging hosts such as `*.ondigitalocean.app`).

### L4. The deprecated IPv6 site-local range wasn't blocked

- **Where:** `fetch_guard.rs`, `is_public_v6`.
- **Severity:** Low (not routed on DigitalOcean by default).
- **Description:** `fec0::/10` (deprecated site-local) was treated as public.
  The review also suspected the local-use NAT64 prefix `64:ff9b:1::/48`
  (RFC 8215), but on checking, the existing NAT64 rule compares the first two
  segments and so already covered all of `64:ff9b::/32`; it's now in the test
  list to keep it that way.
- **Fix:** `fec0::/10` is refused.

### L5. Open instances resolve any token's DID

- **Where:** `auth.rs`, `ServiceAuth::verify`.
- **Severity:** Low (only without an allowlist, i.e. development today).
- **Description:** without an allowlist every well-formed token passes the
  admission check, so `POST /api/session` makes the server resolve DIDs of the
  sender's choosing, including `did:web` hosts: unauthenticated callers can
  drive outbound requests in bulk.
- **Fix:** a global budget on DID resolutions during sign-in (60 per
  minute); beyond it, `POST /api/session` answers 429. Real sign-ins happen
  once per user per 30 days. Per-client rate limiting remains an open item
  (`security.md`).

## Noted, not findings

- The token-ID replay cache is in memory, correct only for a single instance;
  running exactly one instance is a documented requirement
  (`deploy/README.md`).
- The `Secure` flag (and now the cookie name) follows the `Host` header. A
  victim's browser always sends the real host, so an attacker can't use this
  against anyone but themselves.

## Resolution

All five findings were fixed in the commit that added this record:

| | Fix | Test |
|---|---|---|
| L1 | `no_proxy()` on the guarded client | (environment-dependent; covered by review) |
| L2 | `__Host-vb_session` over HTTPS, read exclusively there | `session_cookie` unit tests, including a tossed plain-name cookie being ignored |
| L3 | `Cache-Control: no-store` and `Vary: Host` on Host-derived documents | unit test |
| L4 | `fec0::/10` refused (`64:ff9b:1::/48` was already covered; now tested) | address-classification test |
| L5 | sign-in resolution budget, 429 when exhausted | budget unit test |
