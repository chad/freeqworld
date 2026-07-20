import { expect, test } from '@playwright/test'
import { enterAsGuest, hookJoin, hookState, hookTeleport, sendMessage, uniqueName } from './helpers'

test.describe('federation (spec 14, 33.5)', () => {
  test('traveling through the portal reaches an independent town with the same DID', async ({ page }) => {
    await enterAsGuest(page, uniqueName('voyager'))
    const before = await hookState(page)
    expect(before.town).toBe('freeq-city')

    await hookJoin(page, '#federation')
    await expect(page.getByTestId('header-loc')).toContainText('#federation')

    // step onto the northern portal door
    const doors = await page.evaluate(() => (window as any).__fimp.doors())
    const portal = doors.find((d: any) => d.remote_url)
    expect(portal).toBeTruthy()
    await hookTeleport(page, portal.x + 0.5, portal.y + 0.5)

    // trust display before connecting (spec 14.2)
    await expect(page.getByTestId('travel-confirm')).toBeVisible()
    await expect(page.locator('#travel-dest')).toContainText('neonwharf')
    await page.getByTestId('travel-go').click()

    await expect(page.getByTestId('header-loc')).toContainText('Neon Wharf', { timeout: 10_000 })
    const after = await hookState(page)
    expect(after.town).toBe('neonwharf')
    expect(after.did).toBe(before.did) // identity crossed the border intact
  })

  test('a #federation message relays between the two towns with origin preserved (spec 14.3)', async ({ browser }) => {
    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    const a = await ctxA.newPage()
    const b = await ctxB.newPage()
    await enterAsGuest(a, uniqueName('east'))
    // B connects straight to the peer town
    await enterAsGuest(b, uniqueName('west'), '/?server=http://localhost:8788')
    await hookJoin(a, '#federation')
    await hookJoin(b, '#federation')
    const stateB = await hookState(b)
    expect(stateB.town).toBe('neonwharf')

    const line = `border crossing ${Date.now()}`
    await sendMessage(a, line)
    await expect(a.getByTestId('transcript')).toContainText(line)
    // arrives on the other server, marked with its origin
    await expect(b.getByTestId('transcript')).toContainText(line, { timeout: 10_000 })
    await expect(b.getByTestId('transcript')).toContainText('via freeq-city')

    // and it is durable on both stores
    const rawB = await b.request.get('http://localhost:8788/api/debug/log/%23federation').then((r) => r.text())
    expect(rawB).toContain(line)

    await ctxA.close()
    await ctxB.close()
  })
})
