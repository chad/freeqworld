import { beforeEach, describe, expect, it } from 'vitest'
import { explorerTitle, Journal, shouldRekindle } from './journal'

const store = new Map<string, string>()
beforeEach(() => {
  store.clear()
  ;(globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  }
})

describe('passport stamps (first visit per real channel)', () => {
  it('stamps each channel once and counts places', () => {
    const j = new Journal()
    expect(j.stamp('#freeq', 1000)).toBe(true)
    expect(j.stamp('#freeq', 2000)).toBe(false)
    expect(j.stamp('#dev', 3000)).toBe(true)
    expect(j.stampCount()).toBe(2)
    expect(j.stamps()[0]!.channel).toBe('#dev') // newest first
  })

  it('persists', () => {
    new Journal().stamp('#freeq', 1)
    expect(new Journal().stampCount()).toBe(1)
  })
})

describe('deeds', () => {
  it('accumulates courier stars', () => {
    const j = new Journal()
    j.addStars(1)
    j.addStars(2)
    expect(j.stars()).toBe(3)
  })

  it('records rekindled channels once each', () => {
    const j = new Journal()
    expect(j.rekindle('#dust')).toBe(true)
    expect(j.rekindle('#dust')).toBe(false)
    expect(j.rekindled()).toBe(1)
  })

  it('credits an introduction once per unordered pair', () => {
    const j = new Journal()
    expect(j.introduce('did:b', 'did:c')).toBe(true)
    expect(j.introduce('did:c', 'did:b')).toBe(false)
    expect(j.introductions()).toBe(1)
  })
})

describe('shouldRekindle', () => {
  const DAY = 24 * 3600 * 1000
  it('true when the previous message is older than a day', () => {
    expect(shouldRekindle(1000 + DAY + 1, 1000)).toBe(true)
    expect(shouldRekindle(1000 + DAY - 1, 1000)).toBe(false)
    expect(shouldRekindle(5000, null)).toBe(false) // an empty room is new, not rekindled
  })
})

describe('explorerTitle', () => {
  it('progresses with places stamped', () => {
    expect(explorerTitle(0)).toBe('Homebody')
    expect(explorerTitle(3)).toBe('Tourist')
    expect(explorerTitle(8)).toBe('Wayfarer')
    expect(explorerTitle(15)).toBe('Pathfinder')
    expect(explorerTitle(30)).toBe("Cartographer's Friend")
  })
})
