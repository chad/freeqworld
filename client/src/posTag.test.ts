import { describe, expect, it } from 'vitest'
import { decodePosTag, encodePosTag, POS_TAG } from './posTag'

describe('world-position TAGMSG codec (spec 7.4 over IRCv3 client tags)', () => {
  it('round-trips a position', () => {
    const enc = encodePosTag({ x: 12.53, y: 8.25, facing: 'east', animation: 'walk', sequence: 42 })
    const dec = decodePosTag(enc)
    expect(dec).not.toBeNull()
    expect(dec!.x).toBeCloseTo(12.53, 1)
    expect(dec!.y).toBeCloseTo(8.25, 1)
    expect(dec!.facing).toBe('east')
    expect(dec!.animation).toBe('walk')
    expect(dec!.sequence).toBe(42)
  })

  it('contains no characters needing IRC tag escaping', () => {
    const enc = encodePosTag({ x: -3.789, y: 1000.1, facing: 'north', animation: 'idle', sequence: 9 })
    expect(enc).toMatch(/^[0-9a-z.,-]+$/)
  })

  it('rejects malformed values', () => {
    expect(decodePosTag('garbage')).toBeNull()
    expect(decodePosTag('1,2,upward,idle,3')).toBeNull()
    expect(decodePosTag('')).toBeNull()
  })

  it('uses a vendored client tag name', () => {
    expect(POS_TAG.startsWith('+')).toBe(true)
    expect(POS_TAG).toContain('world-pos')
  })
})
