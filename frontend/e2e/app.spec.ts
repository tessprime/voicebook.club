import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test, type Locator, type Page } from '@playwright/test'

// Seeded by dev/localnet/seed.sh: alice follows bob, carol and dave.
// bob and carol have recordings; dave never uses Voicebook.

// The backend learns about members when they sign in. Announce bob and carol
// as their own sign-ins would, so the tests don't depend on index state.
test.beforeAll(async ({ request }) => {
  const accounts = JSON.parse(readFileSync(new URL('../../dev/localnet/localnet.json', import.meta.url), 'utf8'))
  for (const name of ['bob', 'carol']) {
    const res = await request.post(`/api/members/${accounts.accounts[name].did}/refresh`)
    expect(res.ok()).toBe(true)
  }
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
