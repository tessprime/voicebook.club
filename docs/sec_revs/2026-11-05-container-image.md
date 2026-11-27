# Security review: container image and registry

- **Date:** 2026-11-05
- **Reviewer:** Claude (Opus 5.5), at the maintainer's request (tracker task VB-177)
- **Prompted by:** Alpine Linux's OpenSSH password-authentication bypass,
  published 2026-11-05 (no CVE ID yet):
  <https://www.alpinelinux.org/posts/2026-11-05-openssh-password-authentication-bypass/>
- **Scope:** the image production runs (tag `2308b04`, digest
  `sha256:1351e7bd…41601eb`), the `voicebook` repository in DigitalOcean's
  registry, and the dependency audits that gate deploys. Not in scope: the
  code's history on GitHub, the App Platform account and its credentials.
- **Method:** pulled the live image by digest and inspected it; scanned it
  with Trivy 0.76.2 (vulnerabilities, secrets, misconfigurations; run from
  its container against a saved copy of the image, without the Docker
  socket); listed the Debian updates pending inside it; reran
  `scripts/audit.sh`.
- **Result:** not affected by the Alpine bypass. Nothing suggests tampering.
  The image is three weeks behind on Debian security updates (two fixable
  HIGH), and new Rust and npm advisories now block `deploy.sh`'s audit gate.
  Report only: nothing changed.

## The Alpine OpenSSH bypass: not affected

musl's `crypt()` returns `*` for keys over 256 bytes, which matches the
password field of every account without a password, so sshd on Alpine
(without PAM) accepts a long password for those accounts. It needs sshd with
password authentication on.

- The production image is **Debian 12** (all three build stages are
  bookworm: `node:24-bookworm-slim`, `rust:1.88-bookworm`,
  `debian:bookworm-slim`). No `sshd`, no SSH client, no dropbear, no musl.
  App Platform gives no SSH access to it either.
- No Alpine image is used in production. Alpine appears only in the local
  development network (`postgres:18-alpine`), which wasn't running, and
  runs no sshd.
- The development machine's own sshd (Ubuntu 24.04, OpenSSH 9.6, glibc)
  isn't affected, and has `PasswordAuthentication no`.

Alpine's GitLab was also attacked on 2026-10-20 and 21 (CVE-2026-97229);
Alpine reports that packages and signing keys weren't affected. We use no
Alpine packages in production.

## Image and registry: what holds

- **Provenance:** all 11 registry tags are commits on `master`, each
  pushed by a deploy; nothing unexpected. Last push and last deployment
  2026-10-22 (`2308b04`), which matches production.
- **Runs unprivileged:** user `voicebook` (uid 10001); entrypoint
  `/app/voicebook-backend`; ports 8080 and 9100 (9100 isn't routed on App
  Platform).
- **Contents:** 91 Debian packages plus `/app` (the backend binary, the
  environment configs and the built frontend). Trivy found **no secrets**
  and **no misconfigurations**.

## Findings

| # | Severity | Finding | Proposed |
|---|---|---|---|
| 1 | Medium | **Debian packages three weeks old.** The base layer dates from the 2026-10-22 build. Fixed since: `openssl`/`libssl3` 3.0.22-1~deb12u2 (CVE-2026-84782, HIGH, DTLS information disclosure; the backend uses rustls, not OpenSSL, and nothing uses DTLS), `apt`/`libapt-pkg6.0` 2.6.2 (CVE-2026-109518, HIGH, only matters when `apt` runs, which it doesn't at runtime), `tzdata` 2026f. `debian:bookworm-slim` was republished 2026-11-04 with these. | Rebuild and deploy; consider `apt-get upgrade` in the Dockerfile so every build takes the latest security fixes. |
| 2 | Low | **Unfixed Debian CVEs**: 1 CRITICAL (zlib CVE-2023-45853, in minizip, which nothing here uses), 33 more HIGH with no fix yet (util-linux `mount`, systemd libraries, ncurses, gzip, acl, perl), mostly local privilege escalation through tools the app never runs. | A smaller runtime image (e.g. distroless `cc-debian12`: no shell, no package manager, no setuid binaries such as `su`, `mount`, `passwd`) would drop nearly all of them. A larger change: decide separately. |
| 3 | Low | **Rust advisories since the last deploy:** `crypto-bigint` 0.7.5 (RUSTSEC-2026-0387) and `ctutils` 0.4.3 (RUSTSEC-2026-0385), timing variability in constant-time code, under `k256`/`p256`. The backend only *verifies* signatures (public data; it holds no private keys), so there's nothing secret to leak. Also `tokio` 1.53.2: an unsoundness warning for `AsyncFd` (RUSTSEC-2026-0386), which we don't call. | Lockfile updates: `crypto-bigint` ≥ 0.7.6, `ctutils` ≥ 0.4.4. They block `deploy.sh` until done. |
| 4 | Low | **npm: `zod` < 4.6.6 can exhaust memory** validating oversized collections (GHSA-mrhx-c7xc-m3w5); npm reports it 15 times, once per `@atproto` package that uses it. It's in the shipped frontend: a malicious PDS could hang a visitor's own tab. No data exposure. **No fix available:** the latest `@atproto` packages still require `zod` ^3.23.8, and the 3.x line ends at 3.25.76 (ours). npm's suggested fix (`@atproto/api` 0.13.6) is a ten-version downgrade. | Record an `npm audit` exception with the reason (as for `rsa` in `backend/.cargo/audit.toml`), so it stops blocking deploys, and revisit when `@atproto` moves to zod 4. Or bump `@atproto/api` 0.23 → 0.30 and `oauth-client-browser` 0.5.9 → 0.5.11 anyway (doesn't fix this). |
| 5 | Info | **Debian 12 is now oldstable.** Security support continues, but the base will need moving to Debian 13 (trixie) eventually. | Plan with finding 2. |

## Resolution

Pending the maintainer's decisions (report-first review).
