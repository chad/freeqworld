import { describe, expect, it } from 'vitest'
import { FIRE_SPACING, isClearSpot, placeCampfire, type Spot } from './campfire'

// a plain open room with a wall border
const room = { width: 32, height: 18 }
const walkable = (x: number, y: number): boolean => x > 1 && y > 1 && x < room.width - 1 && y < room.height - 1

// a lousy generator that always suggests the same tile, to prove the rules bite
const stuck = (v: number) => () => v

function mulberry(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('campfire placement', () => {
  const furniture = [
    { x: 12.5, y: 4.5, r: 2.2 }, // quest board
    { x: 18.5, y: 4.5, r: 2.2 }, // directory
  ]

  it('keeps a fire out of the furniture', () => {
    const placed: Spot[] = []
    for (let i = 0; i < 40; i++) {
      const spot = placeCampfire({
        rng: mulberry(i * 7919),
        ...room,
        walkable,
        blocked: furniture,
        placed: [],
        fallback: { x: 2, y: 2 },
      })
      for (const f of furniture) {
        expect(Math.hypot(spot.x - f.x, spot.y - f.y), `fire ${i} sat in the furniture`).toBeGreaterThanOrEqual(f.r)
      }
      placed.push(spot)
    }
  })

  it('keeps fires apart from each other', () => {
    const placed: Spot[] = []
    for (let i = 0; i < 6; i++) {
      const spot = placeCampfire({
        rng: mulberry(i * 104729),
        ...room,
        walkable,
        blocked: furniture,
        placed,
        fallback: { x: 2, y: 2 },
      })
      placed.push(spot)
    }
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const d = Math.hypot(placed[i]!.x - placed[j]!.x, placed[i]!.y - placed[j]!.y)
        expect(d, `fires ${i} and ${j} were on top of each other`).toBeGreaterThanOrEqual(FIRE_SPACING)
      }
    }
  })

  it('never places a fire inside a wall', () => {
    for (let i = 0; i < 50; i++) {
      const spot = placeCampfire({
        rng: mulberry(i * 31337),
        ...room,
        walkable,
        blocked: furniture,
        placed: [],
        fallback: { x: 2, y: 2 },
      })
      expect(walkable(spot.x, spot.y), `fire ${i} was in a wall`).toBe(true)
    }
  })

  it('is deterministic: the same thread keeps its spot', () => {
    const make = () =>
      placeCampfire({
        rng: mulberry(42),
        ...room,
        walkable,
        blocked: furniture,
        placed: [],
        fallback: { x: 2, y: 2 },
      })
    expect(make()).toEqual(make())
  })

  it('still yields a walkable spot when every rule cannot be met', () => {
    // a generator that only ever offers a tile right on top of the quest board
    const spot = placeCampfire({
      rng: stuck(12.5 / room.width),
      ...room,
      walkable,
      blocked: [{ x: 0, y: 0, r: 999 }], // nothing can satisfy this
      placed: [],
      fallback: { x: 5, y: 5 },
    })
    expect(walkable(spot.x, spot.y)).toBe(true)
  })

  it('isClearSpot rejects the doorway and accepts open floor', () => {
    const doors = [{ x: 15.5, y: 0.5, r: 2.5 }]
    expect(isClearSpot(15.5, 1.5, { blocked: doors, placed: [] })).toBe(false)
    expect(isClearSpot(15.5, 8, { blocked: doors, placed: [] })).toBe(true)
  })
})
