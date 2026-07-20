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

    // fresh identities hit the #freeq policy gate on spawn — the gate itself
    // is asserted here, then dismissed so the rest of the flow can run
    for (const p of [a, b]) {
      await expect(p.getByTestId('gate')).toBeVisible({ timeout: 20_000 })
      await expect(p.locator('#gate-rules')).toContainText('#freeq')
      await p.locator('#gate-later').click()
    }

    const stateA = await hookState(a)
    expect(stateA.town).toBe('irc.freeq.at')
    expect(stateA.did).toMatch(/^did:key:z6Mk/)

    // the world was generated from the server's real channel list:
    // spawn is the busiest gathering channel, and the plaza doors + directory
    // point at channels that actually exist
    expect(stateA.channel).toMatch(/^#/)
    const doors = (await a.evaluate(() => (window as any).__fimp.doors())) as { channel: string }[]
    expect(doors.length).toBeGreaterThanOrEqual(3)
    const directory = (await a.evaluate(() => (window as any).__fimp.directory())) as { channel: string; users: number }[]
    expect(directory.length).toBeGreaterThan(20) // the real server has many real channels
    for (const door of doors) {
      expect(directory.some((d) => d.channel === door.channel), `door to ${door.channel} not in live directory`).toBe(true)
    }

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

    // sparks: both spawned on the same tile, so first-touch autographs
    // exchange over TAGMSG — each collects the other as a unique contact
    await expect
      .poll(async () => (await hookState(a)).sparks, { timeout: 25_000 })
      .toBeGreaterThanOrEqual(1)
    await expect
      .poll(async () => (await hookState(b)).sparks, { timeout: 25_000 })
      .toBeGreaterThanOrEqual(1)

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
