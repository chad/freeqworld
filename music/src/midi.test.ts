import { describe, expect, it } from 'vitest'
import { compose } from './compose'
import { drumNote, encodeMidi, keySignatureFifths, PPQ } from './midi'
import { mintChiptune } from './mint'

// Minting composes and is the slowest thing in this file; do it once.
const mintOnce = (() => {
  const cache = new Map<string, Promise<Awaited<ReturnType<typeof mintChiptune>>>>()
  return (did: string, bars: number) => {
    const key = `${did}:${bars}`
    let hit = cache.get(key)
    if (!hit) {
      hit = mintChiptune(did, bars)
      cache.set(key, hit)
    }
    return hit
  }
})()
import { monophonize, TPQ, type Score } from './score'

// A real parser, not a byte-for-byte snapshot. A snapshot proves the output has
// not changed; parsing proves it is a Standard MIDI File. Written from the SMF
// spec so it can catch a malformed varlen or a wrong chunk length.
interface ParsedEvent {
  track: number
  tick: number
  status: number
  data: number[]
}

function parseSmf(bytes: Uint8Array): {
  format: number
  ntracks: number
  division: number
  events: ParsedEvent[]
} {
  let p = 0
  const str = (n: number) => {
    const s = String.fromCharCode(...bytes.slice(p, p + n))
    p += n
    return s
  }
  const u32 = () => {
    const v = (bytes[p]! << 24) | (bytes[p + 1]! << 16) | (bytes[p + 2]! << 8) | bytes[p + 3]!
    p += 4
    return v >>> 0
  }
  const u16 = () => {
    const v = (bytes[p]! << 8) | bytes[p + 1]!
    p += 2
    return v
  }
  expect(str(4)).toBe('MThd')
  expect(u32()).toBe(6)
  const format = u16()
  const ntracks = u16()
  const division = u16()
  const events: ParsedEvent[] = []
  for (let t = 0; t < ntracks; t++) {
    expect(str(4), `track ${t} header`).toBe('MTrk')
    const len = u32()
    const end = p + len
    let tick = 0
    let running = 0
    while (p < end) {
      // variable-length delta
      let delta = 0
      for (;;) {
        const b = bytes[p++]!
        delta = delta * 128 + (b & 0x7f)
        if (!(b & 0x80)) break
      }
      tick += delta
      let status = bytes[p]!
      if (status & 0x80) p++
      else status = running // running status
      if (status < 0xf0) running = status
      const data: number[] = []
      if (status === 0xff) {
        const type = bytes[p++]!
        let n = 0
        for (;;) {
          const b = bytes[p++]!
          n = n * 128 + (b & 0x7f)
          if (!(b & 0x80)) break
        }
        data.push(type, ...bytes.slice(p, p + n))
        p += n
      } else {
        const hi = status & 0xf0
        const nData = hi === 0xc0 || hi === 0xd0 ? 1 : 2
        for (let i = 0; i < nData; i++) data.push(bytes[p++]!)
      }
      events.push({ track: t, tick, status, data })
    }
    expect(p, `track ${t} length was wrong`).toBe(end)
  }
  expect(p, 'trailing bytes after last track').toBe(bytes.length)
  return { format, ntracks, division, events }
}

const SCORE: Score = {
  id: 'test',
  name: 'Test Piece',
  bpm: 120,
  meter: [4, 4],
  length: TPQ * 8,
  notes: [
    { ch: 'pulse1', patch: 'lead', t: 0, dur: TPQ, midi: 60, vel: 0.9 },
    { ch: 'pulse1', patch: 'lead', t: TPQ, dur: TPQ, midi: 62 },
    { ch: 'triangle', patch: 'bass', t: 0, dur: TPQ * 2, midi: 36 },
    { ch: 'noise', patch: 'kick', t: 0, dur: 6, midi: 36 },
    { ch: 'noise', patch: 'hat', t: TPQ, dur: 6, midi: 54 },
  ],
}

describe('MIDI export', () => {
  it('is a well-formed format-1 file that parses back', () => {
    const parsed = parseSmf(encodeMidi(SCORE))
    expect(parsed.format).toBe(1)
    expect(parsed.division).toBe(PPQ)
    // tempo track + one per sounding voice (pulse1, triangle, noise)
    expect(parsed.ntracks).toBe(4)
  })

  it('writes the tempo the score asks for', () => {
    const { events } = parseSmf(encodeMidi(SCORE))
    const tempo = events.find((e) => e.status === 0xff && e.data[0] === 0x51)
    expect(tempo).toBeDefined()
    const us = (tempo!.data[1]! << 16) | (tempo!.data[2]! << 8) | tempo!.data[3]!
    expect(Math.round(60_000_000 / us)).toBe(120)
  })

  it('writes the meter', () => {
    const { events } = parseSmf(encodeMidi({ ...SCORE, meter: [3, 4] }))
    const time = events.find((e) => e.status === 0xff && e.data[0] === 0x58)
    expect(time!.data[1]).toBe(3) // beats
    expect(time!.data[2]).toBe(2) // 2^2 = quarter
  })

  it('every note-on is matched by a note-off', () => {
    const { events } = parseSmf(encodeMidi(SCORE))
    const open = new Map<string, number>()
    for (const e of events) {
      const hi = e.status & 0xf0
      const key = `${e.status & 0x0f}:${e.data[0]}`
      if (hi === 0x90 && (e.data[1] ?? 0) > 0) open.set(key, (open.get(key) ?? 0) + 1)
      if (hi === 0x80 || (hi === 0x90 && e.data[1] === 0)) open.set(key, (open.get(key) ?? 0) - 1)
    }
    for (const [key, n] of open) expect(n, `${key} left hanging`).toBe(0)
  })

  it('puts notes at the right ticks, scaled from score time', () => {
    const { events } = parseSmf(encodeMidi(SCORE))
    const ons = events.filter((e) => (e.status & 0xf0) === 0x90 && e.data[1]! > 0)
    const c4 = ons.find((e) => e.data[0] === 60)
    const d4 = ons.find((e) => e.data[0] === 62)
    expect(c4!.tick).toBe(0)
    expect(d4!.tick).toBe(PPQ) // one quarter note in
  })

  it('routes percussion to GM channel 10 and pitches to their own channels', () => {
    const { events } = parseSmf(encodeMidi(SCORE))
    const ons = events.filter((e) => (e.status & 0xf0) === 0x90 && e.data[1]! > 0)
    const drums = ons.filter((e) => (e.status & 0x0f) === 9)
    expect(drums.length).toBe(2)
    expect(drums.map((d) => d.data[0])).toEqual([drumNote(36), drumNote(54)])
    expect(ons.filter((e) => e.data[0] === 60).every((e) => (e.status & 0x0f) !== 9)).toBe(true)
  })

  it('expands an arpeggio into the notes it implies', () => {
    const arp: Score = {
      ...SCORE,
      notes: [{ ch: 'pulse2', patch: 'arp', t: 0, dur: TPQ * 2, midi: 60, arp: [0, 4, 7] }],
    }
    const { events } = parseSmf(encodeMidi(arp))
    const pitches = new Set(
      events.filter((e) => (e.status & 0xf0) === 0x90 && e.data[1]! > 0).map((e) => e.data[0]),
    )
    expect([...pitches].sort((a, b) => a! - b!)).toEqual([60, 64, 67])
  })

  it('never emits a pitch outside MIDI range', () => {
    const wild: Score = {
      ...SCORE,
      notes: [
        { ch: 'pulse1', patch: 'x', t: 0, dur: 12, midi: -20 },
        { ch: 'pulse2', patch: 'x', t: 0, dur: 12, midi: 200 },
      ],
    }
    const { events } = parseSmf(encodeMidi(wild))
    for (const e of events) {
      if ((e.status & 0xf0) === 0x90) expect(e.data[0]).toBeGreaterThanOrEqual(0)
      if ((e.status & 0xf0) === 0x90) expect(e.data[0]).toBeLessThanOrEqual(127)
    }
  })

  it('does not invent notes the hardware could not play', () => {
    // two notes at the same tick on one channel: the score monophonises, and the
    // file must agree, or the export sounds fuller than the piece
    const clash: Score = {
      ...SCORE,
      notes: [
        { ch: 'pulse1', patch: 'x', t: 0, dur: TPQ, midi: 60 },
        { ch: 'pulse1', patch: 'x', t: 0, dur: TPQ, midi: 64 },
      ],
    }
    const kept = monophonize(clash.notes).filter((n) => n.ch === 'pulse1').length
    const { events } = parseSmf(encodeMidi(clash))
    const ons = events.filter((e) => (e.status & 0xf0) === 0x90 && e.data[1]! > 0)
    expect(ons.length).toBe(kept)
  })

  it('key signatures: minor keys are written with their relative major', () => {
    const minor = [0, 2, 3, 5, 7, 8, 10]
    expect(keySignatureFifths(9, minor)).toBe(0) // A minor -> C major, no accidentals
    expect(keySignatureFifths(4, minor)).toBe(1) // E minor -> G major, one sharp
    expect(keySignatureFifths(2, minor)).toBe(-1) // D minor -> F major, one flat
    const major = [0, 2, 4, 5, 7, 9, 11]
    expect(keySignatureFifths(0, major)).toBe(0) // C
    expect(keySignatureFifths(7, major)).toBe(1) // G
    expect(keySignatureFifths(5, major)).toBe(-1) // F
  })

  it('exports a real minted theme', async () => {
    const minted = await mintOnce('did:plc:4qsyxmnsblo4luuycm3572bq', 8)
    const score = compose(minted.theme)
    const bytes = encodeMidi(score, { title: minted.theme.name, comment: minted.did })
    const parsed = parseSmf(bytes)
    expect(parsed.format).toBe(1)
    expect(parsed.ntracks).toBeGreaterThan(1)
    expect(bytes.length).toBeGreaterThan(200)
    // the DID it was derived from travels with the file
    expect(new TextDecoder().decode(bytes)).toContain('did:plc:4qsyxmnsblo4luuycm3572bq')
  })
})

describe('text encoding', () => {
  it('folds typographic characters to ASCII, as the SMF spec requires', async () => {
    const { asciiFold } = await import('./midi')
    expect(asciiFold('G# harmonic minor — pendulum')).toBe('G# harmonic minor - pendulum')
    expect(asciiFold('a…b')).toBe('a...b')
    expect(asciiFold('B♭ major')).toBe('Bb major')
    expect(asciiFold('naïve ✦')).toBe('nave ')
  })

  it('writes no high bytes in a track name', () => {
    const bytes = encodeMidi(SCORE, { title: 'G# harmonic minor — pendulum' })
    // find the track-name meta event and check every byte is printable ASCII
    const s = new TextDecoder('latin1').decode(bytes)
    const i = s.indexOf('G# harmonic')
    expect(i).toBeGreaterThan(0)
    const name = s.slice(i, s.indexOf('\x00', i))
    for (const c of name) expect(c.charCodeAt(0)).toBeLessThan(0x7f)
    expect(name).toContain('minor - pendulum')
  })
})
