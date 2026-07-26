import { describe, expect, it } from 'vitest'
import { compose } from './compose.ts'
import { CHANNELS, monophonize, ticksPerBar } from './score.ts'
import { THEMES, getTheme } from './themes.ts'

describe('composer', () => {
  it('is deterministic: a theme always produces the same score', () => {
    const a = compose(getTheme('plaza'))
    const b = compose(getTheme('plaza'))
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b))
  })

  it('changing the seed changes the music but not the shape', () => {
    const a = compose(getTheme('plaza'))
    const b = compose({ ...getTheme('plaza'), seed: 'other' })
    expect(a.length).toEqual(b.length)
    expect(JSON.stringify(a.notes)).not.toEqual(JSON.stringify(b.notes))
  })

  it('composes every launch-room theme with all the expected parts', () => {
    for (const [id, theme] of Object.entries(THEMES)) {
      const score = compose(theme)
      expect(score.notes.length, id).toBeGreaterThan(20)
      const used = new Set(score.notes.map((n) => n.ch))
      expect(used.has('triangle'), `${id} has bass`).toBe(true)
      expect(used.has('pulse1'), `${id} has a lead`).toBe(true)
      for (const n of score.notes) {
        expect(CHANNELS, id).toContain(n.ch)
        expect(n.midi, `${id} in hearing range`).toBeGreaterThan(20)
        expect(n.midi, `${id} in hearing range`).toBeLessThan(108)
        expect(n.dur, id).toBeGreaterThan(0)
        expect(n.t + n.dur, `${id} stays inside the loop + tail`).toBeLessThanOrEqual(score.length + ticksPerBar(theme.meter) * 4)
      }
    }
  })

  it('respects the hardware: one note at a time per channel', () => {
    const score = compose(getTheme('club'))
    const notes = monophonize(score.notes)
    for (const ch of CHANNELS) {
      const lane = notes.filter((n) => n.ch === ch).sort((a, b) => a.t - b.t)
      for (let i = 1; i < lane.length; i++) {
        expect(lane[i - 1]!.t + lane[i - 1]!.dur, ch).toBeLessThanOrEqual(lane[i]!.t)
      }
    }
  })

  it('repeats phrases — bars 0-1 and 2-3 are the same melody (AABA\u2032)', () => {
    // the lead sits out the intro, so look at the first full 8-bar period
    const theme = { ...getTheme('plaza'), bars: 24 }
    const score = compose(theme)
    const bar = ticksPerBar(theme.meter)
    const lead = score.notes.filter((n) => n.ch === 'pulse1')
    const slice = (b: number) =>
      lead.filter((n) => n.t >= b * bar && n.t < (b + 1) * bar).map((n) => `${n.t - b * bar}:${n.midi}`)
    expect(slice(8)).toEqual(slice(10)) // A repeated
    expect(slice(8).length).toBeGreaterThan(0)
  })

  it('honours an odd-meter insert', () => {
    const score = compose(getTheme('workshop'))
    const four = ticksPerBar([4, 4])
    const five = ticksPerBar([5, 4])
    expect(score.length).toBe(28 * four + 4 * five) // 32 bars, every 8th is 5/4
  })
})
