import { expect, test } from '@playwright/test'
import { enterAsGuest, hookJoin, hookState, uniqueName } from './helpers'

// These tests run the world client against the REAL irc.freeq.at server —
// guest nicks in a throwaway scratch channel, so production channels stay
// clean. They skip gracefully when the server is unreachable.

const SCRATCH = `#fimp-e2e-${Date.now() % 1000000}`

test.beforeEach(async ({ request }) => {
  try {
    const res = await request.get('https://irc.freeq.at/', { timeout: 5000 })
    test.skip(!res.ok(), 'irc.freeq.at unreachable')
  } catch {
    test.skip(true, 'irc.freeq.at unreachable')
  }
})

test.describe('live against irc.freeq.at (spec 4.1: the protocol is real)', () => {
  test('the world client is a real freeq client: did:key SASL, real channel, two browsers', async ({ browser }) => {
    test.setTimeout(90_000)
    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    const a = await ctxA.newPage()
    const b = await ctxB.newPage()
    const nameA = uniqueName('fwa')
    const nameB = uniqueName('fwb')

    // no ?server param → freeq backend (default)
    await enterAsGuest(a, nameA, '/')
    await enterAsGuest(b, nameB, '/')
    const stateA = await hookState(a)
    expect(stateA.town).toBe('irc.freeq.at')
    expect(stateA.did).toMatch(/^did:key:z6Mk/)

    // move both to a scratch channel (any channel maps to a room, spec 7.5)
    await hookJoin(a, SCRATCH)
    await hookJoin(b, SCRATCH)
    await expect(a.getByTestId('header-loc')).toContainText(SCRATCH, { timeout: 20_000 })
    await expect(b.getByTestId('header-loc')).toContainText(SCRATCH, { timeout: 20_000 })

    // B sees A in the member list (real IRC roster)
    await expect(b.getByTestId('member-list')).toContainText(nameA, { timeout: 20_000 })

    // a real message crosses the real server
    const line = `world-client e2e ${Date.now()}`
    await a.getByTestId('msg-input').fill(line)
    await a.getByTestId('send-btn').click()
    await expect(a.getByTestId('transcript')).toContainText(line, { timeout: 20_000 })
    await expect(b.getByTestId('transcript')).toContainText(line, { timeout: 20_000 })

    // spatial presence rides ephemeral TAGMSG: A walks, B sees a moving avatar
    await a.getByTestId('world-canvas').click({ position: { x: 30, y: 30 } })
    await a.keyboard.down('d')
    await a.waitForTimeout(1200)
    await a.keyboard.up('d')
    await expect
      .poll(async () => (await hookState(b)).remotes, { timeout: 20_000 })
      .toBeGreaterThan(0)

    await ctxA.close()
    await ctxB.close()
  })
})
