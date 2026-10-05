import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test, type Page } from '@playwright/test'

// Seeded by dev/localnet/seed.sh: alice follows bob, carol and dave.
async function signIn(page: Page, handle: string) {
  await page.goto('/')
  await page.getByLabel('Your Bluesky handle').fill(handle)
  await page.getByRole('button', { name: 'Sign in' }).click()
  // The local PDS's own sign-in and consent pages.
  await page.waitForURL(/\/oauth\/authorize/)
  await page.locator('input[name=password]').fill('password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.getByRole('button', { name: 'Authorize' }).click()
  await page.waitForURL('http://127.0.0.1:5173/**')
  await expect(page.locator('.account')).toContainText(`@${handle}`)
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
  await page.getByLabel('Recording', { exact: true }).setInputFiles(testTone(4))
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
