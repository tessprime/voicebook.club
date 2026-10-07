# Security checklist

Where Voicebook stands against the common classes of web-application
vulnerabilities, and what's still open. The categories follow the OWASP
Top 10 (2025 edition; see <https://owasp.org/Top10/> for the authoritative,
current list). Update this file whenever one of the rows changes.

Related: [`auth.md`](auth.md) (authentication and authorization),
[`logging.md`](logging.md) (what's logged, and what never is),
[`../../deploy/README.md`](../../deploy/README.md) (container contract,
hosting, secrets).

## Status

✅ addressed · ⚠️ open

| # | Category | What it means | Voicebook |
|---|---|---|---|
| 1 | **Broken access control** | Users reaching data or actions they shouldn't (including server-side request forgery) | ✅ Every API call needs a session (`auth.md`); the allowlist is checked on each request; refresh is self-or-admin; reindex is admin-only. Outbound fetches of addresses from other people's DID documents go through the SSRF guard (`backend/src/fetch_guard.rs`). |
| 2 | **Security misconfiguration** | Insecure defaults, missing hardening, exposed services | ⚠️ **No security headers yet** (see below). ✅ `/metrics` is on its own unpublished port; there's no CORS layer; the Docker port-publishing trap is documented in `deploy/README.md`; local Grafana binds to 127.0.0.1. |
| 3 | **Software supply chain failures** | Vulnerable or compromised dependencies, build pipeline | ⚠️ **No dependency scanning** (`cargo audit`, `npm audit`, Dependabot or similar). ✅ Lockfiles are committed; images are pinned; builds use `npm ci` and `cargo build --locked`. |
| 4 | **Cryptographic failures** | Weak or missing encryption, mishandled secrets | ✅ TLS is terminated in front of the container; outbound TLS uses rustls; session tokens are stored only as SHA-256 hashes; service-auth signatures must be low-S on both curves. No secrets exist yet; the convention for them is in `deploy/README.md`. |
| 5 | **Injection** | SQL, HTML/script (XSS), commands, logs | ✅ All SQL values are bound parameters (`sqlx` `bind`/`push_bind`). React escapes rendered text (notes included) and nothing uses raw-HTML rendering. Logs are JSON-encoded, so values can't forge log lines. No shell commands run on user input. |
| 6 | **Insecure design** | Missing safeguards in the design itself | ⚠️ **No rate limiting** on `POST /api/session` or refresh. Low urgency while only invited accounts can create sessions. |
| 7 | **Authentication failures** | Weak login, session handling | ✅ Service-auth tokens are single-use and fully verified; each sign-in creates a fresh session; cookies are `HttpOnly`, `SameSite=Strict` and `Secure`; sign-out deletes the session. ⚠️ No way to list or revoke your other sessions; sessions last 30 days. |
| 8 | **Software or data integrity failures** | Unverified updates, unsafe data handling | ✅ Untrusted JSON (records, DID documents, Jetstream events) is parsed into strict types; malformed records are skipped. ⚠️ No CI pipeline or image signing yet. |
| 9 | **Logging and alerting failures** | Attacks happen unnoticed | ✅ Rejected service-auth tokens and sign-ins by uninvited accounts are logged; nginx keeps client IPs. ⚠️ **Nothing alerts** until a telemetry server exists (`logging.md`, Production). |
| 10 | **Mishandling exceptional conditions** | Failing open, leaking details in errors | ✅ Errors return a generic 500, with details only in logs. Access checks fail closed on the backend; the frontend's fallbacks only change which screen is shown. |

## Open items

In priority order:

**Before the invite-only beta**

1. **Security headers**, set by the backend for the site and the API:
   - `Content-Security-Policy`: scripts and styles only from our origin;
     media and `connect-src` also need the users' PDSes (`https:`) for
     playback and uploads.
   - `frame-ancestors 'none'` (in the CSP) against clickjacking.
   - `Referrer-Policy: same-origin` (or `strict-origin-when-cross-origin`).
   - `X-Content-Type-Options: nosniff`.
   - HSTS (`Strict-Transport-Security`) at the TLS-terminating proxy.
2. **Dependency scanning**: `cargo audit` and `npm audit` (or Dependabot)
   run regularly, at least before each release.
3. **A security review of the authentication code** before it's deployed
   (`/security-review` on the pending changes, or a second person).

**Before opening beyond invites**

4. **Rate limiting** on `POST /api/session` and refresh (per IP, in memory).
5. **Alerting** on the signals that matter: error rate, rejected-token rate,
   Jetstream lag and disconnects.
6. **Session management**: list and revoke your sessions; consider a shorter
   lifetime.
7. **CI** that builds, tests and scans every change, and signs the images it
   publishes.

## Reviewing changes

When a change touches any of these areas, check the matching row here and
update it:

- routes, authorization or sessions → rows 1, 7 (and `auth.md`);
- anything fetched from an address that came from someone else's data →
  row 1 (the fetch guard);
- configuration, ports, proxies or headers → row 2;
- new dependencies or images → row 3;
- SQL, rendering of user content, or logging of user content → row 5.
