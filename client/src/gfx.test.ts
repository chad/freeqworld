import { describe, expect, it } from 'vitest'
import { drawTag } from './gfx'

/** the few canvas calls drawTag makes, recorded */
function fakeCtx(height = 180) {
  return {
    canvas: { height, width: 320 },
    fillStyle: '',
    fillRect: () => {},
    fillText: () => {},
  } as unknown as CanvasRenderingContext2D
}

describe('label placement', () => {
  it('does not stack two tags at the same spot', () => {
    const taken: { x: number; y: number; w: number; h: number }[] = []
    drawTag(fakeCtx(), 'cartographer', 80, 60, '#fff', taken)
    drawTag(fakeCtx(), 'archivist', 80, 60, '#fff', taken)
    const [a, b] = taken
    const overlap = a!.x < b!.x + b!.w && a!.x + a!.w > b!.x && a!.y < b!.y + b!.h && a!.y + a!.h > b!.y
    expect(overlap, 'two tags at one point ended up on top of each other').toBe(false)
  })

  it('finds room for a crowd', () => {
    const taken: { x: number; y: number; w: number; h: number }[] = []
    for (let i = 0; i < 5; i++) drawTag(fakeCtx(), `player${i}`, 100, 90, '#fff', taken)
    for (let i = 0; i < taken.length; i++) {
      for (let j = i + 1; j < taken.length; j++) {
        const a = taken[i]!
        const b = taken[j]!
        const overlap = a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
        expect(overlap, `tags ${i} and ${j} overlapped`).toBe(false)
      }
    }
  })

  it('goes downward when there is no room above', () => {
    // against the top wall, where the door labels live
    const taken: { x: number; y: number; w: number; h: number }[] = []
    drawTag(fakeCtx(), '#lobby (5)', 60, 2, '#fff', taken)
    drawTag(fakeCtx(), 'somebody', 60, 2, '#fff', taken)
    expect(taken[1]!.y).toBeGreaterThan(taken[0]!.y)
    expect(taken.every((r) => r.y >= 1)).toBe(true)
  })

  it('keeps tags on the canvas', () => {
    const taken: { x: number; y: number; w: number; h: number }[] = []
    for (let i = 0; i < 6; i++) drawTag(fakeCtx(180), `n${i}`, 50, 176, '#fff', taken)
    expect(taken.every((r) => r.y + r.h <= 180 && r.y >= 1), 'a tag ran off the canvas').toBe(true)
  })
})
