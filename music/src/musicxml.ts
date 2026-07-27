// MusicXML 4.0 (partwise) export — the theme as readable sheet music.
//
// MIDI gives you something a DAW can play; MusicXML gives you something
// MuseScore, Sibelius, Finale or Dorico can *engrave*. That is a different and
// more interesting artefact: your identity's theme as a page of notation you
// could hand to a person with an instrument.
//
// Two things make this harder than MIDI and are handled explicitly:
//   1. Measures must be filled exactly — every division of every bar accounted
//      for by a note or a rest, or the file is invalid and editors reject it.
//   2. A note crossing a bar line must be split into tied notes, because
//      notation has no way to write a duration that spans a barline.

import { keySignatureFifths, pitchedLanes } from './midi'
import { ticksPerBar, TPQ, type Channel, type Note, type Score } from './score'

const STEP_SHARP = ['C', 'C', 'D', 'D', 'E', 'F', 'F', 'G', 'G', 'A', 'A', 'B'] as const
const ALTER_SHARP = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0] as const
const STEP_FLAT = ['C', 'D', 'D', 'E', 'E', 'F', 'G', 'G', 'A', 'A', 'B', 'B'] as const
const ALTER_FLAT = [0, -1, 0, -1, 0, 0, -1, 0, -1, 0, -1, 0] as const

export interface Pitch {
  step: string
  alter: number
  octave: number
}

/** Spell a MIDI note. Which enharmonic to use is a function of the key: writing
 *  A♭ minor with sharps is legal MIDI and unreadable notation. */
export function spell(midi: number, useFlats: boolean): Pitch {
  const pc = ((midi % 12) + 12) % 12
  const octave = Math.floor(midi / 12) - 1
  return useFlats
    ? { step: STEP_FLAT[pc]!, alter: ALTER_FLAT[pc]!, octave }
    : { step: STEP_SHARP[pc]!, alter: ALTER_SHARP[pc]!, octave }
}

/** Note type name for a duration in divisions (TPQ = quarter). Notation needs a
 *  name, not just a number; anything unusual falls back to the nearest smaller
 *  named value, which is what the tie logic then makes up for. */
export function noteType(divisions: number): { type: string; dots: number } {
  const q = divisions / TPQ
  const table: [number, string][] = [
    [4, 'whole'], [2, 'half'], [1, 'quarter'], [0.5, 'eighth'],
    [0.25, '16th'], [0.125, '32nd'], [0.0625, '64th'],
  ]
  for (const [len, type] of table) {
    if (Math.abs(q - len) < 1e-6) return { type, dots: 0 }
    if (Math.abs(q - len * 1.5) < 1e-6) return { type, dots: 1 }
    if (Math.abs(q - len * 1.75) < 1e-6) return { type, dots: 2 }
  }
  for (const [len, type] of table) if (q > len) return { type, dots: 0 }
  return { type: '64th', dots: 0 }
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

interface Slot {
  /** null = rest */
  note: Note | null
  start: number
  dur: number
  tieStart: boolean
  tieStop: boolean
}

/**
 * Cut one voice's notes into bar-sized groups, filling gaps with rests and
 * splitting anything that crosses a bar line into tied halves.
 */
export function layOutMeasures(notes: Note[], barTicks: number, totalTicks: number): Slot[][] {
  const bars = Math.max(1, Math.ceil(totalTicks / barTicks))
  const sorted = [...notes].sort((a, b) => a.t - b.t)
  const measures: Slot[][] = []
  for (let b = 0; b < bars; b++) {
    const barStart = b * barTicks
    const barEnd = barStart + barTicks
    const slots: Slot[] = []
    let cursor = barStart
    for (const n of sorted) {
      const nStart = n.t
      const nEnd = n.t + Math.max(1, n.dur)
      if (nEnd <= barStart || nStart >= barEnd) continue
      const from = Math.max(nStart, barStart)
      const to = Math.min(nEnd, barEnd)
      if (from > cursor) slots.push({ note: null, start: cursor, dur: from - cursor, tieStart: false, tieStop: false })
      slots.push({
        note: n,
        start: from,
        dur: to - from,
        // a tie continues past this bar; a tie arrives from the previous one
        tieStart: nEnd > barEnd,
        tieStop: nStart < barStart,
      })
      cursor = to
    }
    if (cursor < barEnd) slots.push({ note: null, start: cursor, dur: barEnd - cursor, tieStart: false, tieStop: false })
    measures.push(slots)
  }
  return measures
}

export interface MusicXmlOptions {
  title?: string
  /** shown as the composer line; the world puts the handle or DID here */
  composer?: string
  comment?: string
  tonicPc?: number
  scale?: readonly number[]
}

const PART_LABEL: Record<Channel, string> = {
  pulse1: 'Lead (pulse)',
  pulse2: 'Counter (pulse)',
  triangle: 'Bass (triangle)',
  aux: 'Pad',
  noise: 'Percussion',
  dpcm: 'Percussion',
}

/** Bass parts read far better on an F clef than shoved onto a treble staff. */
function clefFor(ch: Channel): { sign: string; line: number } {
  return ch === 'triangle' ? { sign: 'F', line: 4 } : { sign: 'G', line: 2 }
}

export function encodeMusicXml(score: Score, opts: MusicXmlOptions = {}): string {
  const lanes = pitchedLanes(score)
  const barTicks = ticksPerBar(score.meter)
  const fifths = opts.scale ? keySignatureFifths(opts.tonicPc ?? 0, opts.scale) : 0
  const useFlats = fifths < 0
  const [beats, unit] = score.meter

  const partList = lanes
    .map(
      (l, i) =>
        `    <score-part id="P${i + 1}">\n` +
        `      <part-name>${esc(PART_LABEL[l.ch])}</part-name>\n` +
        `    </score-part>`,
    )
    .join('\n')

  const parts = lanes
    .map((lane, li) => {
      const measures = layOutMeasures(lane.notes, barTicks, score.length)
      const clef = clefFor(lane.ch)
      const body = measures
        .map((slots, mi) => {
          const attrs =
            mi === 0
              ? `      <attributes>\n` +
                `        <divisions>${TPQ}</divisions>\n` +
                `        <key><fifths>${fifths}</fifths></key>\n` +
                `        <time><beats>${beats}</beats><beat-type>${unit}</beat-type></time>\n` +
                `        <clef><sign>${clef.sign}</sign><line>${clef.line}</line></clef>\n` +
                `      </attributes>\n`
              : ''
          const notes = slots
            .map((s) => {
              const { type, dots } = noteType(s.dur)
              const dotTags = '<dot/>'.repeat(dots)
              if (!s.note) {
                return (
                  `      <note>\n        <rest/>\n        <duration>${s.dur}</duration>\n` +
                  `        <voice>1</voice>\n        <type>${type}</type>${dotTags}\n      </note>`
                )
              }
              const p = spell(s.note.midi, useFlats)
              const alter = p.alter !== 0 ? `<alter>${p.alter}</alter>` : ''
              const ties =
                (s.tieStop ? '        <tie type="stop"/>\n' : '') +
                (s.tieStart ? '        <tie type="start"/>\n' : '')
              const notations =
                s.tieStop || s.tieStart
                  ? `        <notations>${s.tieStop ? '<tied type="stop"/>' : ''}${
                      s.tieStart ? '<tied type="start"/>' : ''
                    }</notations>\n`
                  : ''
              return (
                `      <note>\n` +
                `        <pitch><step>${p.step}</step>${alter}<octave>${p.octave}</octave></pitch>\n` +
                `        <duration>${s.dur}</duration>\n` +
                ties +
                `        <voice>1</voice>\n        <type>${type}</type>${dotTags}\n` +
                notations +
                `      </note>`
              )
            })
            .join('\n')
          return `    <measure number="${mi + 1}">\n${attrs}${notes}\n    </measure>`
        })
        .join('\n')
      return `  <part id="P${li + 1}">\n${body}\n  </part>`
    })
    .join('\n')

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n` +
    `<score-partwise version="4.0">\n` +
    `  <work><work-title>${esc(opts.title ?? score.name)}</work-title></work>\n` +
    `  <identification>\n` +
    (opts.composer ? `    <creator type="composer">${esc(opts.composer)}</creator>\n` : '') +
    `    <encoding>\n      <software>freeq chiptune-v1</software>\n` +
    `      <encoding-date>${new Date().toISOString().slice(0, 10)}</encoding-date>\n    </encoding>\n` +
    (opts.comment ? `    <miscellaneous>\n      <miscellaneous-field name="derivation">${esc(opts.comment)}</miscellaneous-field>\n    </miscellaneous>\n` : '') +
    `  </identification>\n` +
    `  <defaults><music-font font-family="Bravura"/></defaults>\n` +
    `  <part-list>\n${partList}\n  </part-list>\n` +
    `${parts}\n` +
    `</score-partwise>\n`
  )
}
