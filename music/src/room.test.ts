import { describe, expect, it } from 'vitest'
import {
  MotifBudget, motifNotesInKey, nextBarTime, nextBeatTime, quoteScore, splitStems, stemGains, STEMS,
} from './room.ts'
import { compose } from './compose.ts'
import { getTheme, themeForCue, THEMES } from './themes.ts'
import { deriveLeitmotif } from '../../shared/src/leitmotif.ts'
import { SCALES, noteToMidi } from './theory.ts'

const DID = 'did:plc:z72i7hdynmk6r22z27h6tvur'

describe('layer gains (spec §11.3 adaptation)', () => {
  it('keeps the harmonic bed present at all times', () => {
    for (const s of [
      { energy: 0, tension: 0, density: 0, brightness: 0 },
      { energy: 1, tension: 1, density: 1, brightness: 1 },
    ]) {
      const g = stemGains(s)
      expect(g.base).toBeGreaterThan(0.8)
      for (const v of Object.values(g)) {
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(1.01) // never doubles the mix
      }
    }
  })

  it('fades the drums in with activity — an empty room has no backbeat', () => {
    expect(stemGains({ energy: 0.05, tension: 0, density: 0, brightness: 0.5 }).rhythm).toBe(0)
    expect(stemGains({ energy: 0.8, tension: 0.2, density: 0.8, brightness: 0.5 }).rhythm)
      .toBeGreaterThan(0.7)
  })

  it('has a sane default when the server has told us nothing yet', () => {
    const g = stemGains(null)
    expect(g.base).toBeGreaterThan(0)
    expect(g.lead).toBeGreaterThan(0)
  })
})

describe('scheduling on the grid', () => {
  const bpm = 120 // 2 s per 4/4 bar, 0.5 s per beat

  it('lands quotes on the next bar line, never between bars', () => {
    expect(nextBarTime(10.0, 10.0, bpm)).toBeCloseTo(10.0 + 2, 5)
    expect(nextBarTime(11.2, 10.0, bpm)).toBeCloseTo(12.0, 5)
    expect(nextBarTime(12.0001, 10.0, bpm)).toBeCloseTo(14.0, 5)
  })

  it('always schedules far enough ahead to actually be heard', () => {
    for (let now = 10; now < 14; now += 0.017) {
      expect(nextBarTime(now, 10, bpm)).toBeGreaterThan(now)
    }
  })

  it('answers deliberate actions on the next beat instead', () => {
    expect(nextBeatTime(10.1, 10.0, bpm)).toBeCloseTo(10.5, 5)
    expect(nextBeatTime(10.6, 10.0, bpm)).toBeCloseTo(11.0, 5)
  })

  it('respects odd meters', () => {
    expect(nextBarTime(10.0, 10.0, bpm, 5)).toBeCloseTo(12.5, 5) // 5/4
  })
})

describe('motif budget (spec §30.5 "limit identity motifs")', () => {
  it('quotes an arrival once, then holds that person back', () => {
    const b = new MotifBudget({ cooldownMs: 45_000, gapMs: 2_500 })
    expect(b.allow(DID, 'arrival', 0)).toBe(true)
    expect(b.allow(DID, 'arrival', 3_000)).toBe(false) // still cooling down
    expect(b.allow(DID, 'arrival', 46_000)).toBe(true)
  })

  it('never lets two ambient quotes stack on top of each other', () => {
    const b = new MotifBudget({ gapMs: 2_500 })
    expect(b.allow('did:a', 'arrival', 0)).toBe(true)
    expect(b.allow('did:b', 'arrival', 500)).toBe(false) // a crowd walking in
    expect(b.allow('did:b', 'arrival', 3_000)).toBe(true)
  })

  it('stops quoting arrivals in a crowded room', () => {
    const b = new MotifBudget({ crowd: 8 })
    expect(b.allow('did:a', 'arrival', 0, 20)).toBe(false)
    // but a deliberate action still answers, or the UI feels broken
    expect(b.allow('did:a', 'inspect', 0, 20)).toBe(true)
    expect(b.allow('did:b', 'mention', 100, 20)).toBe(true)
  })

  it('still refuses to machine-gun deliberate actions', () => {
    const b = new MotifBudget()
    expect(b.allow(DID, 'inspect', 0)).toBe(true)
    expect(b.allow(DID, 'inspect', 300)).toBe(false)
    expect(b.allow(DID, 'inspect', 2_000)).toBe(true)
  })
})

describe('re-keying identity into the room', () => {
  it('puts the quote in the room\u2019s scale, so it cannot clash with the bed', async () => {
    const canon = await deriveLeitmotif(DID)
    for (const theme of Object.values(THEMES)) {
      const notes = motifNotesInKey(canon, theme)
      const root = noteToMidi(theme.key)
      const allowed = new Set(SCALES[theme.scale].map((s) => (root + s) % 12))
      for (const n of notes) expect(allowed.has(((n % 12) + 12) % 12), `${theme.id}: ${n}`).toBe(true)
      expect(notes.length).toBe(canon.notes.length)
    }
  })

  it('preserves the contour that makes the motif recognisable', async () => {
    const canon = await deriveLeitmotif(DID)
    const notes = motifNotesInKey(canon, getTheme('vault'))
    const dirs = notes.slice(1).map((n, i) => Math.sign(n - notes[i]!))
    expect(dirs).toEqual(canon.interval_contour.map((c) => Math.sign(c)))
  })

  it('sits in a register that carries over the bed', async () => {
    const canon = await deriveLeitmotif(DID)
    for (const theme of Object.values(THEMES)) {
      for (const n of motifNotesInKey(canon, theme)) {
        expect(n).toBeGreaterThan(55)
        expect(n).toBeLessThan(100)
      }
    }
  })

  it('builds a short one-shot score at the room\u2019s tempo', async () => {
    const canon = await deriveLeitmotif(DID)
    const theme = getTheme('club')
    const score = quoteScore(canon, theme, 'arrival')
    expect(score.bpm).toBe(theme.bpm)
    expect(score.notes.length).toBe(canon.notes.length)
    expect(score.notes.every((n) => n.ch === 'pulse1')).toBe(true)
    expect(score.length).toBeLessThanOrEqual(48 * 4 * 2) // under two bars: a quote
  })
})

describe('stems', () => {
  it('splits the bed without losing or duplicating a single note', () => {
    const score = compose({ ...getTheme('plaza'), bars: 8 })
    const stems = splitStems(score)
    const total = Object.values(stems).reduce((n, s) => n + s.notes.length, 0)
    expect(total).toBe(score.notes.length)
    for (const [name, channels] of Object.entries(STEMS)) {
      for (const n of stems[name as keyof typeof STEMS].notes) {
        expect(channels as readonly string[]).toContain(n.ch)
      }
    }
  })

  it('gives every stem something to play in a full arrangement', () => {
    const stems = splitStems(compose({ ...getTheme('club'), bars: 16 }))
    expect(stems.base.notes.length).toBeGreaterThan(0)
    expect(stems.rhythm.notes.length).toBeGreaterThan(0)
    expect(stems.lead.notes.length).toBeGreaterThan(0)
  })
})

describe('room cues', () => {
  it('maps the world\u2019s cue names onto the authored themes', () => {
    expect(themeForCue('plaza_108bpm').id).toBe('plaza')
    expect(themeForCue('lab_118bpm').id).toBe('laboratory')
    expect(themeForCue('vault_64bpm').id).toBe('vault')
    expect(themeForCue('station_112bpm').id).toBe('station')
    expect(themeForCue('outskirts_100bpm').id).toBe('outskirts')
  })

  it('lets the world decide the tempo', () => {
    expect(themeForCue('plaza_108bpm', 96).bpm).toBe(96)
    expect(themeForCue('plaza_108bpm').bpm).toBe(108)
  })

  it('never leaves a new room silent, and sounds the same to everyone', () => {
    const a = themeForCue('greenhouse_120bpm', 120, '#greenhouse')
    const b = themeForCue('greenhouse_120bpm', 120, '#greenhouse')
    expect(a).toEqual(b)
    expect(a.bpm).toBe(120)
    expect(compose(a).notes.length).toBeGreaterThan(20)
    expect(themeForCue('other_120bpm', 120, '#other')).not.toEqual(a)
  })
})

describe('every room the world can build has authored music', () => {
  // shared/src/protocol.ts RoomTemplate — the live world classifies every
  // channel into one of these and names the cue `${template}_live`
  const TEMPLATES = [
    'plaza', 'workshop', 'club', 'library', 'laboratory', 'office', 'classroom',
    'lounge', 'vault', 'theater', 'garden', 'train car', 'dungeon chamber',
    'empty tile grid',
  ]

  it('resolves the live world\u2019s cue names, not just the static ones', () => {
    expect(themeForCue('plaza_live', 108).id).toBe('plaza')
    expect(themeForCue('train car_live', 112).id).toBe('station')
    expect(themeForCue('empty tile grid_live', 100).id).toBe('outskirts')
    expect(themeForCue('office_live', 96).id).toBe('workshop')
  })

  it('gives all fourteen templates a real composed cue', () => {
    for (const t of TEMPLATES) {
      const theme = themeForCue(`${t}_live`, 104)
      expect(Object.keys(THEMES), `${t} is authored, not derived`).toContain(theme.id)
      expect(theme.bpm).toBe(104) // the world sets the tempo
      const score = compose({ ...theme, bars: 8 })
      expect(score.notes.length, t).toBeGreaterThan(20)
      expect(splitStems(score).base.notes.length, t).toBeGreaterThan(0)
    }
  })
})
