import { describe, expect, it } from 'vitest'
import { roomFor } from './world'

describe('roomFor: every channel maps to a room (spec 7.2, 7.5)', () => {
  it('returns the curated room for launch channels', () => {
    expect(roomFor('#lobby').name).toBe('The Plaza')
    expect(roomFor('#private-demo').encrypted).toBe(true)
  })

  it('synthesizes a walkable room for unknown channels', () => {
    const room = roomFor('#some-random-channel')
    expect(room.channel).toBe('#some-random-channel')
    expect(room.width).toBeGreaterThan(10)
    expect(room.exits.some((e) => e.channel === '#lobby')).toBe(true)
    expect(room.encrypted).toBe(false)
  })

  it('is deterministic for the same unknown channel', () => {
    expect(roomFor('#x')).toEqual(roomFor('#x'))
  })
})
