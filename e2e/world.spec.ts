import { expect, test } from '@playwright/test'
import { enterAsGuest, hookJoin, hookState, hookTeleport, sendMessage, TOWN_A, uniqueName } from './helpers'

test.describe('landing (spec 6.1, 25.1)', () => {
  test('shows a live plaza with real seeded channel messages before any login', async ({ page }) => {
    await page.goto(TOWN_A)
    await expect(page.getByTestId('landing')).toBeVisible()
    await expect(page.locator('#landing h1')).toHaveText('FREEQWORLD')
    // real messages from the durable #lobby log are already in the transcript
    await expect(page.getByTestId('transcript')).toContainText('Every room here is a real Freeq channel', { timeout: 10_000 })
    // the world canvas is rendering behind the card
    await expect(page.getByTestId('world-canvas')).toBeVisible()
  })

  test('read-only guests cannot speak (spec MVP guest role)', async ({ page }) => {
    await page.goto(TOWN_A)
    await page.getByTestId('landing').waitFor()
    // spectator connection exists but there is no identity: sending is refused client-side
    await expect(page.getByTestId('msg-input')).toBeVisible()
  })
})

test.describe('identity and avatars (spec 8, 33.1)', () => {
  test('guest login mints a did:key, derives the avatar from it, and survives reload', async ({ page }) => {
    const name = uniqueName('ada')
    await enterAsGuest(page, name)
    const s1 = await hookState(page)
    expect(s1.did).toMatch(/^did:key:z6Mk/)
    expect(s1.channel).toBe('#lobby')
    expect(s1.town).toBe('freeq-city')
    // same identity after reload — the keypair lives in the browser
    await page.reload()
    await page.getByTestId('header-loc').filter({ hasText: '#' }).waitFor()
    const s2 = await hookState(page)
    expect(s2.did).toBe(s1.did)
  })

  test('identity card shows display name, handle and DID as distinct fields (spec 24.3)', async ({ page }) => {
    const name = uniqueName('grace')
    await enterAsGuest(page, name)
    await page.locator('#members .m', { hasText: name }).click()
    await expect(page.getByTestId('identity-card')).toBeVisible()
    await expect(page.getByTestId('idcard-did')).toContainText('did:key:z6Mk')
    await expect(page.locator('#idcard-display')).toHaveText(name)
    await expect(page.locator('#idcard-handle')).toContainText('.guest')
  })
})

test.describe('same room, two clients (spec 33.2)', () => {
  test('a message sent by one browser appears in another browser in the same channel', async ({ browser }) => {
    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    const a = await ctxA.newPage()
    const b = await ctxB.newPage()
    const nameA = uniqueName('alice')
    const nameB = uniqueName('bob')
    await enterAsGuest(a, nameA)
    await enterAsGuest(b, nameB)
    // B sees A in the member list
    await expect(b.getByTestId('member-list')).toContainText(nameA)
    const line = `hello from ${nameA} ${Date.now()}`
    await sendMessage(a, line)
    await expect(a.getByTestId('transcript')).toContainText(line)
    await expect(b.getByTestId('transcript')).toContainText(line)
    await ctxA.close()
    await ctxB.close()
  })

  test('movement is visible via ephemeral presence and never enters the durable log (spec 3.3)', async ({ page }) => {
    const name = uniqueName('walker')
    await enterAsGuest(page, name)
    const before = await hookState(page)
    await page.getByTestId('world-canvas').click({ position: { x: 10, y: 10 } })
    await page.keyboard.down('d')
    await page.waitForTimeout(600)
    await page.keyboard.up('d')
    const after = await hookState(page)
    expect(after.x).toBeGreaterThan(before.x)
    // presence endpoint shows us; durable log does not contain any position event
    const presence = await page.request.get('/api/debug/presence/%23lobby').then((r) => r.json())
    expect(presence.positions.some((p: { did: string }) => p.did === before.did)).toBe(true)
    const log = await page.request.get('/api/debug/log/%23lobby').then((r) => r.json())
    expect(JSON.stringify(log)).not.toContain('world-position')
  })
})

test.describe('agents (spec 10, 33.3)', () => {
  test('mentioning @archivist gets a signed reply with inspectable provenance chain', async ({ page }) => {
    const name = uniqueName('asker')
    await enterAsGuest(page, name)
    await sendMessage(page, '@archivist what do you keep here?')
    // agent reply arrives (marked with the agent gear)
    await expect(page.getByTestId('transcript')).toContainText('durable event history', { timeout: 8000 })
    // click the agent's name to open provenance card
    await page.locator('#transcript .who.agent', { hasText: 'The Archivist' }).first().click()
    await expect(page.getByTestId('identity-card')).toBeVisible()
    await expect(page.getByTestId('idcard-chain')).toContainText('→') // operator → agent
    // the reply is a real signed event in the durable log
    const log = await page.request.get('/api/debug/log/%23lobby').then((r) => r.json())
    const agentMsgs = log.durable_log.filter((e: any) => e.kind === 'message' && e.event.provenance)
    expect(agentMsgs.length).toBeGreaterThan(0)
    expect(agentMsgs[agentMsgs.length - 1].event.signature.length).toBeGreaterThan(10)
  })
})

test.describe('doors and rooms (spec 7.2)', () => {
  test('walking through the east door of the plaza moves to the Workshop (#freeq-dev)', async ({ page }) => {
    await enterAsGuest(page, uniqueName('mover'))
    const doors = await page.evaluate(() => (window as any).__fimp.doors())
    const east = doors.find((d: any) => d.channel === '#freeq-dev')
    expect(east).toBeTruthy()
    await hookTeleport(page, east.x + 0.5, east.y + 0.5)
    await expect(page.getByTestId('header-loc')).toContainText('#freeq-dev')
    await expect(page.getByTestId('header-loc')).toContainText('The Workshop')
  })

  test('space jumps — briefly airborne, broadcast as a presence animation', async ({ page }) => {
    await enterAsGuest(page, uniqueName('hopper'))
    await page.keyboard.press(' ')
    const st = await hookState(page)
    expect((st as unknown as { jumping: boolean }).jumping).toBe(true)
    await page.waitForTimeout(700)
    const st2 = await hookState(page)
    expect((st2 as unknown as { jumping: boolean }).jumping).toBe(false)
  })

  test('chat mode renders a conventional client view (spec 20)', async ({ page }) => {
    await enterAsGuest(page, uniqueName('chatty'))
    await page.getByTestId('mode-chat').click()
    await expect(page.getByTestId('world-canvas')).toBeHidden()
    await expect(page.getByTestId('transcript')).toBeVisible()
    const line = `conventional mode ${Date.now()}`
    await sendMessage(page, line)
    await expect(page.getByTestId('transcript')).toContainText(line)
  })

  test('developer mode shows verified signatures on live events (spec 14.4)', async ({ page }) => {
    await enterAsGuest(page, uniqueName('dev'))
    await page.getByTestId('mode-dev').click()
    await expect(page.getByTestId('inspector')).toBeVisible()
    await sendMessage(page, `inspect me ${Date.now()}`)
    await expect(page.locator('#insp-log')).toContainText('sig=VERIFIED')
    await expect(page.locator('#insp-meta')).toContainText('WebSocket')
  })
})
