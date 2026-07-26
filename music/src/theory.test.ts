import { describe, expect, it } from 'vitest'
import {
  chordTones, degreeToMidi, midiToFreq, midiToName, noteToMidi, SCALES, snapToScale, voiceChord,
} from './theory.ts'

describe('theory', () => {
  it('parses and prints note names', () => {
    expect(noteToMidi('C4')).toBe(60)
    expect(noteToMidi('A4')).toBe(69)
    expect(noteToMidi('F#3')).toBe(54)
    expect(midiToName(60)).toBe('C4')
    expect(midiToName(54)).toBe('F#3')
  })

  it('tunes A4 to 440 Hz', () => {
    expect(midiToFreq(69)).toBeCloseTo(440, 6)
    expect(midiToFreq(81)).toBeCloseTo(880, 6)
  })

  it('walks scale degrees across octaves', () => {
    const maj = SCALES.major
    expect(degreeToMidi(60, maj, 0)).toBe(60) // C
    expect(degreeToMidi(60, maj, 4)).toBe(67) // G
    expect(degreeToMidi(60, maj, 7)).toBe(72) // C an octave up
    expect(degreeToMidi(60, maj, -1)).toBe(59) // B below
  })

  it('builds diatonic chords', () => {
    expect(chordTones(60, SCALES.major, { degree: 0 })).toEqual([60, 64, 67]) // C E G
    expect(chordTones(60, SCALES.major, { degree: 4, quality: 'seventh' })).toEqual([67, 71, 74, 77])
    expect(chordTones(60, SCALES.minor, { degree: 0 })).toEqual([60, 63, 67]) // C Eb G
  })

  it('voices a chord inside one octave', () => {
    const v = voiceChord([60, 64, 67], 55)
    expect(Math.min(...v)).toBeGreaterThanOrEqual(55)
    expect(Math.max(...v)).toBeLessThan(67)
  })

  it('snaps chromatic notes back into the scale', () => {
    expect(SCALES.major.map((s) => 60 + s)).toContain(snapToScale(60, SCALES.major, 61))
  })
})

describe('handles', () => {
  it('passes raw DIDs straight through without a network call', async () => {
    const { resolveHandleToDid } = await import('./handle.ts')
    expect(await resolveHandleToDid('did:plc:z72i7hdynmk6r22z27h6tvur')).toBe('did:plc:z72i7hdynmk6r22z27h6tvur')
    expect(await resolveHandleToDid('  did:web:example.com ')).toBe('did:web:example.com')
  })
})
