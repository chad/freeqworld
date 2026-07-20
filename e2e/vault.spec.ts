import { expect, test } from '@playwright/test'
import { enterAsGuest, hookJoin, sendMessage, uniqueName } from './helpers'

test.describe('the vault: real client-side encryption (spec 15, 33.6)', () => {
  test('messages decrypt in the browser while the server stores only ciphertext', async ({ browser }) => {
    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    const a = await ctxA.newPage()
    const b = await ctxB.newPage()
    await enterAsGuest(a, uniqueName('keeper'))
    await enterAsGuest(b, uniqueName('confidant'))
    await hookJoin(a, '#private-demo')
    await hookJoin(b, '#private-demo')
    await expect(a.getByTestId('header-loc')).toContainText('#private-demo')
    await expect(a.getByTestId('vault-status')).toContainText('retrieved')

    const secret = `the launch code is horse-battery-${Date.now()}`
    await sendMessage(a, secret)

    // both browsers see the plaintext (decrypted locally)
    await expect(a.getByTestId('transcript')).toContainText(secret)
    await expect(b.getByTestId('transcript')).toContainText(secret)

    // the server's durable store has the envelope, never the words
    const raw = await a.request.get('/api/debug/log/%23private-demo').then((r) => r.text())
    expect(raw).not.toContain('horse-battery')
    expect(raw).not.toContain('launch code')
    expect(raw).toContain('"alg":"aes-gcm"')
    expect(raw).toContain('"ct":')

    await ctxA.close()
    await ctxB.close()
  })

  test('the vault room is visually marked encrypted with key status (spec 12.6)', async ({ page }) => {
    await enterAsGuest(page, uniqueName('visitor'))
    await hookJoin(page, '#private-demo')
    await expect(page.getByTestId('vault-status')).toBeVisible()
    await expect(page.getByTestId('vault-status')).toContainText('e2e')
    await expect(page.getByTestId('header-topic')).toContainText('server only ever sees ciphertext')
  })
})
