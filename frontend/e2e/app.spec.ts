import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test, type Locator, type Page } from '@playwright/test'

// Seeded by dev/localnet/seed.sh: alice follows bob, carol and dave.
// bob and carol have recordings; dave never uses Voicebook.

const accounts: Record<string, { did: string }> = JSON.parse(
  readFileSync(new URL('../../dev/localnet/localnet.json', import.meta.url), 'utf8'),
).accounts

// The backend learns about members when they sign in. bob and carol sign in
// once (which refreshes their accounts), so the tests don't depend on index
// state.
test.beforeAll(async ({ browser }, testInfo) => {
  for (const name of ['bob', 'carol']) {
    const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL })
    const page = await context.newPage()
    const refreshed = page.waitForResponse((r) => r.url().endsWith('/refresh') && r.ok())
    await signIn(page, `${name}.test`)
    await refreshed
    await context.close()
  }
})

// Content-Security-Policy violations on our origin fail the test. Recorded
// in sessionStorage, which survives the OAuth round trip to the PDS. Only
// meaningful when the backend serves the frontend (E2E_BASE_URL): Vite's dev
// server sends no CSP.
test.beforeEach(async ({ page }, testInfo) => {
  const origin = new URL(testInfo.project.use.baseURL!).origin
  await page.addInitScript((appOrigin) => {
    if (window.location.origin !== appOrigin) return
    document.addEventListener('securitypolicyviolation', (e) => {
      const seen = JSON.parse(sessionStorage.getItem('csp-violations') ?? '[]')
      seen.push(`${e.effectiveDirective} blocked ${e.blockedURI || '(inline)'}`)
      sessionStorage.setItem('csp-violations', JSON.stringify(seen))
    })
  }, origin)
})

test.afterEach(async ({ page }, testInfo) => {
  const origin = new URL(testInfo.project.use.baseURL!).origin
  if (page.isClosed() || !page.url().startsWith(origin)) return
  const violations = await page.evaluate(() => JSON.parse(sessionStorage.getItem('csp-violations') ?? '[]'))
  expect(violations, 'Content-Security-Policy violations').toEqual([])
})

async function signIn(page: Page, handle: string) {
  await page.goto('/')
  await page.getByLabel('Your Bluesky handle').fill(handle)
  await page.getByRole('button', { name: 'Sign in' }).click()
  // The local PDS's own sign-in and consent pages.
  await page.waitForURL(/\/oauth\/authorize/)
  await page.locator('input[name=password]').fill('password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.getByRole('button', { name: 'Authorize' }).click()
  await page.waitForURL((url) => url.hostname === '127.0.0.1' && !url.pathname.startsWith('/oauth'))
  await expect(page.locator('.account')).toContainText(`@${handle}`)
}

async function audioDuration(audio: Locator): Promise<number> {
  await expect(audio).toBeVisible()
  return audio.evaluate(
    (el: HTMLAudioElement) =>
      new Promise<number>((resolve) => (el.readyState >= 1 ? resolve(el.duration) : (el.onloadedmetadata = () => resolve(el.duration)))),
  )
}

function testTone(seconds: number): string {
  const file = join(mkdtempSync(join(tmpdir(), 'voicebook-e2e-')), 'tone.ogg')
  execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=262:duration=${seconds}`, '-c:a', 'libopus', file])
  return file
}

test('sign in, record, play back, and see friends', async ({ page }) => {
  await signIn(page, 'alice.test')

  await page.reload()
  await expect(page.locator('.account')).toContainText('@alice.test')

  // Upload a recording; a unique chapter identifies it across runs.
  const chapter = `e2e-${Date.now()}`
  await page.getByRole('button', { name: 'Start Practice' }).click()
  await page.getByLabel('Book or work').fill('Pride and Prejudice')
  await page.getByLabel(/Chapter or passage/).fill(chapter)
  await page.getByRole('tab', { name: 'Upload a file' }).click()
  await page.getByLabel('Audio file').setInputFiles(testTone(4))
  await page.getByRole('button', { name: 'Save recording' }).click()

  // Indexed via Jetstream and shown under today's date.
  const item = page.locator('.recording', { hasText: `Chapter ${chapter}` })
  await expect(item).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.day.today')).toHaveClass(/practiced/)

  // Playback from the PDS, with a known duration (seekable).
  await item.getByRole('button', { name: /Play/ }).click()
  const audio = item.locator('audio')
  await expect(audio).toBeVisible()
  const duration = await audio.evaluate(
    (el: HTMLAudioElement) =>
      new Promise<number>((resolve) => (el.readyState >= 1 ? resolve(el.duration) : (el.onloadedmetadata = () => resolve(el.duration)))),
  )
  expect(duration).toBeGreaterThan(3.5)
  expect(duration).toBeLessThan(4.5)

  await page.getByRole('button', { name: 'Recordings' }).click()
  await expect(page.locator('.recording', { hasText: `Chapter ${chapter}` })).toBeVisible()

  // Friends: members alice follows. dave is followed but has no recordings.
  await page.getByRole('button', { name: 'Friends' }).click()
  const friends = page.locator('.friend')
  await expect(friends.filter({ hasText: '@bob.test' })).toBeVisible()
  await expect(friends.filter({ hasText: '@carol.test' })).toBeVisible()
  await expect(friends.filter({ hasText: '@dave.test' })).toHaveCount(0)

  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByLabel('Your Bluesky handle')).toBeVisible()
})

test('record in the browser; the draft survives a reload until saved', async ({ page }) => {
  await signIn(page, 'alice.test')
  // Start clean: drop drafts left by earlier runs.
  for (const banner of await page.locator('.draft-banner').all()) {
    page.once('dialog', (d) => d.accept())
    await banner.getByRole('button', { name: 'Discard' }).click()
  }
  await expect(page.locator('.draft-banner')).toHaveCount(0)

  const chapter = `rec-${Date.now()}`
  await page.getByRole('button', { name: 'Start Practice' }).click()
  await page.getByLabel('Book or work').fill('Middlemarch')
  await page.getByLabel(/Chapter or passage/).fill(chapter)
  await page.getByRole('button', { name: '● Record' }).click()
  await expect(page.getByRole('timer')).toHaveText('0:03', { timeout: 10_000 })
  await page.getByRole('button', { name: '■ Stop' }).click()

  // Review: the recording plays back locally with a real duration.
  const preview = page.locator('.recorder audio')
  await expect(preview).toBeVisible()
  expect(await audioDuration(preview)).toBeGreaterThan(2.5)

  // Not saved yet: a reload offers it back, with what was typed.
  await page.reload()
  const banner = page.locator('.draft-banner')
  await expect(banner).toContainText('Unsaved recording')
  await expect(banner).toContainText('Middlemarch')
  await banner.getByRole('button', { name: 'Review and save' }).click()
  await expect(page.getByLabel(/Chapter or passage/)).toHaveValue(chapter)
  await page.getByRole('button', { name: 'Save recording' }).click()

  const item = page.locator('.recording', { hasText: `Chapter ${chapter}` })
  await expect(item).toBeVisible({ timeout: 15_000 })
  await item.getByRole('button', { name: /Play/ }).click()
  expect(await audioDuration(item.locator('audio'))).toBeGreaterThan(2.5)

  // Saved, so the browser copy is gone.
  await page.reload()
  await expect(page.getByRole('button', { name: 'Start Practice' })).toBeVisible()
  await expect(page.locator('.draft-banner')).toHaveCount(0)
})

test('a failed upload keeps the recording in the browser', async ({ page }) => {
  await signIn(page, 'alice.test')
  for (const banner of await page.locator('.draft-banner').all()) {
    page.once('dialog', (d) => d.accept())
    await banner.getByRole('button', { name: 'Discard' }).click()
  }

  await page.getByRole('button', { name: 'Start Practice' }).click()
  await page.getByLabel('Book or work').fill('Emma')
  await page.getByRole('button', { name: '● Record' }).click()
  await expect(page.getByRole('timer')).toHaveText('0:02', { timeout: 10_000 })
  await page.getByRole('button', { name: '■ Stop' }).click()
  await expect(page.locator('.recorder audio')).toBeVisible()

  // The PDS is unreachable for uploads.
  await page.route('**/xrpc/com.atproto.repo.uploadBlob', (route) => route.abort())
  await page.getByRole('button', { name: 'Save recording' }).click()
  await expect(page.getByRole('alert')).toContainText('still kept in this browser')

  await page.unroute('**/xrpc/com.atproto.repo.uploadBlob')
  await page.reload()
  const banner = page.locator('.draft-banner')
  await expect(banner).toContainText('Emma')

  // Clean up.
  page.once('dialog', (d) => d.accept())
  await banner.getByRole('button', { name: 'Discard' }).click()
  await expect(banner).toHaveCount(0)
})

test('an account not on the allowlist sees the invite-only screen', async ({ page }) => {
  // Development is open; simulate the closed beta's answer for this account.
  await page.route('**/api/session', (route) =>
    route.request().method() === 'POST' ? route.fulfill({ status: 403, json: { error: 'not_invited' } }) : route.continue(),
  )
  await page.goto('/')
  await page.getByLabel('Your Bluesky handle').fill('dave.test')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/oauth\/authorize/)
  await page.locator('input[name=password]').fill('password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.getByRole('button', { name: 'Authorize' }).click()

  await expect(page.getByText('invite-only during the beta')).toBeVisible()
  await expect(page.getByText('@dave.test')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start Practice' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByLabel('Your Bluesky handle')).toBeVisible()
})

test('the API requires a session, CSRF headers on changes, and admin rights for others', async ({ page, request }) => {
  // No session: 401.
  expect((await request.get('/api/members')).status()).toBe(401)
  expect((await request.get(`/api/users/${accounts.alice.did}/recordings`)).status()).toBe(401)

  await signIn(page, 'carol.test')
  const csrf = { 'x-voicebook-csrf': '1' }
  // The page's request context shares carol's session cookie.
  expect((await page.request.get('/api/members')).status()).toBe(200)
  const session = await (await page.request.get('/api/session')).json()
  expect(session.did).toBe(accounts.carol.did)
  // Changes need the CSRF header.
  expect((await page.request.post(`/api/members/${accounts.carol.did}/refresh`)).status()).toBe(403)
  expect((await page.request.post(`/api/members/${accounts.carol.did}/refresh`, { headers: csrf })).status()).toBe(200)
  // Not an admin: only her own account.
  const other = await page.request.post(`/api/members/${accounts.bob.did}/refresh`, { headers: csrf })
  expect(other.status()).toBe(403)
  expect((await page.request.post('/api/admin/reindex', { headers: csrf })).status()).toBe(403)

  // Signing out ends the backend session.
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByLabel('Your Bluesky handle')).toBeVisible()
  expect((await page.request.get('/api/members')).status()).toBe(401)
})

test('an admin can refresh any account and reindex', async ({ page }) => {
  const admin = process.env.E2E_ADMIN
  test.skip(!admin, 'set E2E_ADMIN to an account the backend lists in access.admins')
  await signIn(page, `${admin}.test`)
  const csrf = { 'x-voicebook-csrf': '1' }
  expect((await (await page.request.get('/api/session')).json()).admin).toBe(true)
  expect((await page.request.post(`/api/members/${accounts.bob.did}/refresh`, { headers: csrf })).status()).toBe(200)
  expect((await page.request.post('/api/admin/reindex', { headers: csrf })).status()).toBe(200)
})

test('a lost backend session is renewed transparently', async ({ page, context }) => {
  await signIn(page, 'alice.test')
  // As if the backend's database were lost, or the session expired.
  await context.clearCookies({ name: 'vb_session' })
  const renewed = page.waitForResponse((r) => r.url().endsWith('/api/session') && r.request().method() === 'POST' && r.ok())
  await page.getByRole('button', { name: 'Recordings' }).click()
  await renewed
  await expect(page.locator('.recording').first()).toBeVisible()
  await expect(page.locator('.error')).toHaveCount(0)
})

test('security headers are sent', async ({ request }) => {
  test.skip(!process.env.E2E_BASE_URL, 'the backend serves the frontend only in the image test (E2E_BASE_URL)')
  const page = await request.get('/')
  const csp = page.headers()['content-security-policy']
  expect(csp).toContain("script-src 'self'")
  expect(csp).toContain("frame-ancestors 'none'")
  expect(page.headers()['x-content-type-options']).toBe('nosniff')
  expect(page.headers()['referrer-policy']).toBe('same-origin')
  expect(page.headers()['permissions-policy']).toContain('microphone=(self)')
  expect(page.headers()['cross-origin-opener-policy']).toBe('same-origin')
  const api = await request.get('/api/session')
  expect(api.headers()['cache-control']).toBe('no-store')
})

test('the CSP blocks injected inline script, and the violation tracker sees it', async ({ page }) => {
  test.skip(!process.env.E2E_BASE_URL, 'the backend serves the frontend only in the image test (E2E_BASE_URL)')
  await page.goto('/')
  await page.getByLabel('Your Bluesky handle').waitFor()
  // What an XSS payload would do: inject and run a script.
  const ran = await page.evaluate(async () => {
    const script = document.createElement('script')
    script.textContent = 'window.__injected = true'
    document.body.append(script)
    await new Promise((resolve) => setTimeout(resolve, 200))
    return (window as unknown as { __injected?: boolean }).__injected === true
  })
  expect(ran, 'inline script must not run').toBe(false)
  const violations: string[] = await page.evaluate(() => JSON.parse(sessionStorage.getItem('csp-violations') ?? '[]'))
  expect(violations.some((v) => v.startsWith('script-src'))).toBe(true)
  await page.evaluate(() => sessionStorage.removeItem('csp-violations')) // expected; don't fail afterEach
})

test('a busy backend (429) keeps the OAuth session, and a reload signs in', async ({ page }) => {
  await page.route('**/api/session', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ status: 429, headers: { 'retry-after': '60' }, json: { error: 'too_many_sign_ins' } })
      : route.continue(),
  )
  await page.goto('/')
  await page.getByLabel('Your Bluesky handle').fill('carol.test')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/oauth\/authorize/)
  await page.locator('input[name=password]').fill('password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.getByRole('button', { name: 'Authorize' }).click()
  await expect(page.getByRole('alert')).toContainText('reload in a minute')

  // The minute passes; no new OAuth sign-in needed.
  await page.unroute('**/api/session')
  await page.reload()
  await expect(page.locator('.account')).toContainText('@carol.test')
})
