import { describe, expect, it } from 'vitest'
import { compose } from './compose.ts'
import { getTheme } from './themes.ts'
import { renderScore } from './synth.ts'
import { encodeWav } from './wav.ts'
import { ticksToSeconds } from './score.ts'

const SR = 22050 // half rate keeps the test suite quick

describe('synth', () => {
  const score = compose({ ...getTheme('plaza'), bars: 4 })

  it('renders audio the exact length of the loop', () => {
    const audio = renderScore(score, { sampleRate: SR, loop: true })
    const expected = Math.round(ticksToSeconds(score.length, score.bpm) * SR)
    expect(audio.left.length).toBe(expected)
    expect(audio.right.length).toBe(expected)
  })

  it('produces clean, non-silent, non-clipping samples', () => {
    const { left, right } = renderScore(score, { sampleRate: SR })
    let peak = 0
    let energy = 0
    for (let i = 0; i < left.length; i++) {
      expect(Number.isFinite(left[i]!)).toBe(true)
      peak = Math.max(peak, Math.abs(left[i]!), Math.abs(right[i]!))
      energy += left[i]! * left[i]!
    }
    expect(peak).toBeGreaterThan(0.5)
    expect(peak).toBeLessThanOrEqual(1)
    expect(Math.sqrt(energy / left.length)).toBeGreaterThan(0.05) // actually loud
  })

  it('is bit-for-bit deterministic', () => {
    const a = renderScore(score, { sampleRate: SR })
    const b = renderScore(score, { sampleRate: SR })
    expect(Array.from(a.left.slice(0, 5000))).toEqual(Array.from(b.left.slice(0, 5000)))
  })

  it('loops seamlessly — no gap of silence at the seam', () => {
    const { left } = renderScore(score, { sampleRate: SR, loop: true })
    const window = 256
    const head = left.slice(0, window).reduce((a, v) => a + Math.abs(v), 0) / window
    const tail = left.slice(-window).reduce((a, v) => a + Math.abs(v), 0) / window
    expect(head).toBeGreaterThan(0.01)
    expect(tail).toBeGreaterThan(0.01)
  })

  it('writes a valid 16-bit stereo wav', () => {
    const audio = renderScore(score, { sampleRate: SR })
    const wav = encodeWav(audio)
    const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
    const tag = (o: number) => String.fromCharCode(...wav.slice(o, o + 4))
    expect(tag(0)).toBe('RIFF')
    expect(tag(8)).toBe('WAVE')
    expect(tag(36)).toBe('data')
    expect(dv.getUint16(22, true)).toBe(2) // channels
    expect(dv.getUint32(24, true)).toBe(SR)
    expect(dv.getUint16(34, true)).toBe(16) // bit depth
    expect(wav.byteLength).toBe(44 + audio.left.length * 4)
  })
})
