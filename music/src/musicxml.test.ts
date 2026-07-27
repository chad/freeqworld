import { describe, expect, it } from 'vitest'
import { compose } from './compose'
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
import {
  encodeMusicXml, layOutMeasures, NOTATION_GRID, noteType, quantizeForNotation, spell,
} from './musicxml'
import { ticksPerBar, TPQ, type Note, type Score } from './score'

const SCORE: Score = {
  id: 'test',
  name: 'Test Piece',
  bpm: 120,
  meter: [4, 4],
  length: TPQ * 8,
  notes: [
    { ch: 'pulse1', patch: 'lead', t: 0, dur: TPQ, midi: 60 },
    { ch: 'pulse1', patch: 'lead', t: TPQ * 2, dur: TPQ, midi: 62 },
    { ch: 'triangle', patch: 'bass', t: 0, dur: TPQ * 4, midi: 36 },
  ],
}

/** Sum every <duration> inside one <measure>. The single most important
 *  invariant in MusicXML: an under- or over-filled measure is rejected by
 *  editors, and it is the mistake this format invites. */
function measureDurations(xml: string): number[][] {
  const parts = xml.split('<part id=').slice(1)
  return parts.map((part) =>
    part
      .split('<measure ')
      .slice(1)
      .map((m) =>
        [...m.matchAll(/<duration>(\d+)<\/duration>/g)].reduce((a, x) => a + Number(x[1]), 0),
      ),
  )[0] !== undefined
    ? parts.map((part) =>
        part
          .split('<measure ')
          .slice(1)
          .map((m) =>
            [...m.matchAll(/<duration>(\d+)<\/duration>/g)].reduce((a, x) => a + Number(x[1]), 0),
          ),
      )
    : []
}

describe('pitch spelling', () => {
  it('spells with sharps or flats as the key requires', () => {
    expect(spell(61, false)).toEqual({ step: 'C', alter: 1, octave: 4 }) // C#4
    expect(spell(61, true)).toEqual({ step: 'D', alter: -1, octave: 4 }) // Db4
  })

  it('gets middle C right', () => {
    expect(spell(60, false)).toEqual({ step: 'C', alter: 0, octave: 4 })
  })

  it('handles octaves below and above', () => {
    expect(spell(24, false).octave).toBe(1)
    expect(spell(96, false).octave).toBe(7)
  })
})

describe('note types', () => {
  it('names the common durations', () => {
    expect(noteType(TPQ * 4).type).toBe('whole')
    expect(noteType(TPQ * 2).type).toBe('half')
    expect(noteType(TPQ).type).toBe('quarter')
    expect(noteType(TPQ / 2).type).toBe('eighth')
    expect(noteType(TPQ / 4).type).toBe('16th')
  })

  it('marks a dotted note', () => {
    expect(noteType(TPQ * 1.5)).toEqual({ type: 'quarter', dots: 1 })
    expect(noteType(TPQ * 3)).toEqual({ type: 'half', dots: 1 })
  })
})

describe('measure layout', () => {
  const bar = ticksPerBar([4, 4])

  it('fills gaps with rests so every bar is complete', () => {
    const notes: Note[] = [{ ch: 'pulse1', patch: 'x', t: TPQ, dur: TPQ, midi: 60 }]
    const measures = layOutMeasures(notes, bar, bar)
    const total = measures[0]!.reduce((a, s) => a + s.dur, 0)
    expect(total).toBe(bar)
    expect(measures[0]!.filter((s) => s.note === null).length).toBe(2) // before and after
  })

  it('ties a note that crosses a bar line', () => {
    const notes: Note[] = [{ ch: 'pulse1', patch: 'x', t: bar - TPQ, dur: TPQ * 2, midi: 60 }]
    const measures = layOutMeasures(notes, bar, bar * 2)
    const first = measures[0]!.find((s) => s.note)!
    const second = measures[1]!.find((s) => s.note)!
    expect(first.tieStart).toBe(true)
    expect(first.tieStop).toBe(false)
    expect(second.tieStop).toBe(true)
    expect(first.dur + second.dur).toBe(TPQ * 2)
  })

  it('gives an empty voice a bar of rest, not an empty measure', () => {
    const measures = layOutMeasures([], bar, bar * 2)
    expect(measures.length).toBe(2)
    for (const m of measures) {
      expect(m.length).toBe(1)
      expect(m[0]!.note).toBeNull()
      expect(m[0]!.dur).toBe(bar)
    }
  })

  it('every measure of a real theme is exactly full', async () => {
    const minted = await mintOnce('did:plc:4qsyxmnsblo4luuycm3572bq', 8)
    const score = compose(minted.theme)
    const barTicks = ticksPerBar(score.meter)
    for (const lane of ['pulse1', 'pulse2', 'triangle', 'aux'] as const) {
      const notes = score.notes.filter((n) => n.ch === lane)
      if (!notes.length) continue
      const measures = layOutMeasures(notes, barTicks, score.length)
      measures.forEach((m, i) => {
        const total = m.reduce((a, s) => a + s.dur, 0)
        expect(total, `${lane} bar ${i + 1} holds ${total}, wants ${barTicks}`).toBe(barTicks)
      })
    }
  })
})

describe('MusicXML document', () => {
  it('declares partwise 4.0 with the expected skeleton', () => {
    const xml = encodeMusicXml(SCORE, { title: 'Test Piece', composer: 'alice.com' })
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    expect(xml).toContain('<score-partwise version="4.0">')
    expect(xml).toContain('<work-title>Test Piece</work-title>')
    expect(xml).toContain('<creator type="composer">alice.com</creator>')
    expect(xml).toContain('</score-partwise>')
  })

  it('is balanced XML (every element closed, in order)', () => {
    const xml = encodeMusicXml(SCORE)
    const stack: string[] = []
    for (const m of xml.matchAll(/<(\/?)([a-z-]+)([^>]*?)(\/?)>/gi)) {
      const [, close, name, , selfClose] = m
      if (m[0].startsWith('<?') || m[0].startsWith('<!')) continue
      if (selfClose) continue
      if (close) {
        expect(stack.pop(), `</${name}> closed the wrong element`).toBe(name)
      } else {
        stack.push(name!)
      }
    }
    expect(stack, `unclosed: ${stack.join(', ')}`).toEqual([])
  })

  it('one part per sounding pitched voice, and no percussion part', () => {
    const xml = encodeMusicXml(SCORE)
    expect([...xml.matchAll(/<score-part id=/g)].length).toBe(2) // pulse1 + triangle
    expect(xml).toContain('Lead (pulse)')
    expect(xml).toContain('Bass (triangle)')
    expect(xml).not.toContain('Percussion')
  })

  it('every measure in the document is exactly one bar long', () => {
    for (const durs of measureDurations(encodeMusicXml(SCORE))) {
      for (const d of durs) expect(d).toBe(ticksPerBar(SCORE.meter))
    }
  })

  it('writes the key signature and puts the bass on an F clef', () => {
    const xml = encodeMusicXml(SCORE, { tonicPc: 9, scale: [0, 2, 3, 5, 7, 8, 10] })
    expect(xml).toContain('<fifths>0</fifths>') // A minor
    expect(xml).toContain('<sign>F</sign>')
    expect(xml).toContain('<sign>G</sign>')
  })

  it('escapes a title that would otherwise break the document', () => {
    const xml = encodeMusicXml(SCORE, { title: 'Rock & <Roll>', composer: '"quoted"' })
    expect(xml).toContain('Rock &amp; &lt;Roll&gt;')
    expect(xml).not.toContain('<Roll>')
  })

  it('exports a real minted theme with its DID recorded', async () => {
    const minted = await mintOnce('did:plc:4qsyxmnsblo4luuycm3572bq', 8)
    const score = compose(minted.theme)
    const xml = encodeMusicXml(score, {
      title: minted.theme.name,
      composer: 'chadfowler.com',
      comment: minted.did,
      tonicPc: 0,
      scale: [0, 2, 3, 5, 7, 8, 10],
    })
    expect(xml).toContain(minted.did)
    expect(xml.length).toBeGreaterThan(2000)
    for (const durs of measureDurations(xml)) {
      for (const d of durs) expect(d).toBe(ticksPerBar(score.meter))
    }
  })
})

describe('written durations vs sounding durations', () => {
  // The composer emits envelope lengths: a note in a 24-tick slot is written
  // dur:22 so the synth re-triggers cleanly. Exported literally that is 11/24 of
  // a quarter plus a 1/24 rest — not a note value. These tests pin the fix.
  const bass: Note[] = Array.from({ length: 8 }, (_, i) => ({
    ch: 'triangle' as const, patch: 'bass', t: i * 24, dur: 22, midi: 36,
  }))

  it('fills the slot when the shortfall is just the envelope', () => {
    const q = quantizeForNotation(bass, 8 * 24)
    expect(q.every((x) => x.dur === 24), 'every bass note should be a written eighth').toBe(true)
    expect(q.some((x) => x.staccato)).toBe(false) // 22/24 is not staccato
  })

  it('emits no rests at all for a continuous stream', () => {
    const measures = layOutMeasures(bass, ticksPerBar([4, 4]), 8 * 24)
    const rests = measures.flat().filter((s) => s.note === null)
    expect(rests.length, 'a continuous bass line needs no rests').toBe(0)
  })

  it('keeps a real rest when the composer meant one', () => {
    // sounding 24 in a 48-tick slot: half the slot is silence, and writing a
    // quarter note there would be a lie about the rhythm
    const detached: Note[] = [
      { ch: 'pulse2', patch: 'stab', t: 0, dur: 24, midi: 60 },
      { ch: 'pulse2', patch: 'stab', t: 48, dur: 24, midi: 60 },
    ]
    const q = quantizeForNotation(detached, 96)
    expect(q[0]!.dur).toBe(24)
    const measures = layOutMeasures(detached, ticksPerBar([4, 4]), 96)
    expect(measures.flat().filter((s) => s.note === null).length).toBeGreaterThan(0)
  })

  it('marks staccato when a filled slot is still much shorter than written', () => {
    const short: Note[] = [
      { ch: 'pulse1', patch: 'lead', t: 0, dur: 31, midi: 60 }, // 31/48 = 0.65
      { ch: 'pulse1', patch: 'lead', t: 48, dur: 48, midi: 62 },
    ]
    const q = quantizeForNotation(short, 96)
    expect(q[0]!.dur).toBe(48) // written as a quarter
    expect(q[0]!.staccato).toBe(true) // but marked short
    expect(q[1]!.staccato).toBe(false)
  })

  it('never writes a duration off the notation grid', () => {
    const q = quantizeForNotation(bass, 8 * 24)
    for (const x of q) expect(x.dur % NOTATION_GRID, `${x.dur} is off the 16th grid`).toBe(0)
  })

  it('a real theme produces only nameable note values', async () => {
    const minted = await mintOnce('did:plc:4qsyxmnsblo4luuycm3572bq', 8)
    const score = compose(minted.theme)
    const xml = encodeMusicXml(score, { tonicPc: 0, scale: [0, 2, 3, 5, 7, 8, 10] })
    // nothing shorter than a 16th should appear in readable notation
    expect(xml).not.toContain('<type>64th</type>')
    expect(xml).not.toContain('<type>32nd</type>')
    // and no double dots, which is what 7/16-of-a-quarter turned into
    expect(xml).not.toContain('<dot/><dot/>')
  })
})
