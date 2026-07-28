// Pixel-drawn music notation for the share card.
//
// The card is produced by a hand-rolled deterministic PNG encoder — no canvas,
// no fonts beyond our own pixel one — so the notation is drawn here from
// primitives. That constraint is the point: the same DID must always produce
// byte-identical bytes, and a browser or a font renderer would not guarantee it.
//
// This is engraving reduced to what reads at unfurl size: five lines, a clef,
// the key signature, note heads with stems and beams, ledger lines. No
// accidentals-in-the-bar logic, no rests — the card shows the *shape* of the
// opening phrase, and the /score page shows the real thing.

import { fillRect, type Bitmap, type RGB } from './png'

/** G clef, 12×32, hand-authored. '#' is ink, '.' is nothing.
 *  Drawn against the staff so its curl sits on the G line (line 2 from bottom). */
const G_CLEF = [
  '.......###....',
  '......#####...',
  '.....##...##..',
  '.....##....##.',
  '....##.....##.',
  '....##.....##.',
  '....##.....##.',
  '....##....##..',
  '....##...##...',
  '....##..##....',
  '....######....',
  '....#####.....',
  '...######.....',
  '...##..###....',
  '..###...###...',
  '..##.....##...',
  '.###.....###..',
  '.##.......##..',
  '###.......###.',
  '##.........##.',
  '##.........##.',
  '##.........##.',
  '##.........##.',
  '##........###.',
  '###.......###.',
  '.###.....###..',
  '..###...###...',
  '...#######....',
  '....#####.....',
  '.....###......',
  '.....##.......',
  '.....##.......',
  '.....##.......',
  '.....##.......',
  '.....##.......',
  '.....##.......',
  '.....##.......',
  '....###.......',
  '...####.......',
  '..####........',
  '.####.........',
  '####..........',
  '.##...........',
  '..#...........',
]

/** Sharp sign, 7×11. */
const SHARP = [
  '..#..#.',
  '..#..#.',
  '#######',
  '..#..#.',
  '..#..#.',
  '..#..#.',
  '#######',
  '..#..#.',
  '..#..#.',
  '..#..#.',
  '..#..#.',
]

/** Flat sign, 6×12. */
const FLAT = [
  '##....',
  '##....',
  '##....',
  '##....',
  '##....',
  '#####.',
  '##..##',
  '##..##',
  '##.##.',
  '#####.',
  '###...',
  '##....',
]

function stamp(bmp: Bitmap, rows: string[], x: number, y: number, c: RGB, a = 1): void {
  rows.forEach((row, dy) => {
    ;[...row].forEach((ch, dx) => {
      if (ch !== '.') fillRect(bmp, x + dx, y + dy, 1, 1, c, a)
    })
  })
}

/** A filled note head: a squat ellipse, slightly tilted the way real ones are. */
function noteHead(bmp: Bitmap, cx: number, cy: number, c: RGB, a = 1): void {
  // 9×7, hand-tuned so it reads as an oval and not a blob at this size
  const rows = [
    '..#####..',
    '.#######.',
    '#########',
    '#########',
    '#########',
    '.#######.',
    '..#####..',
  ]
  stamp(bmp, rows, Math.round(cx - 4), Math.round(cy - 3), c, a)
}

export interface StaffNote {
  /** MIDI pitch */
  midi: number
  /** ticks from the start of the phrase */
  t: number
  /** ticks */
  dur: number
}

export interface StaffOpts {
  x: number
  y: number
  /** total width to lay the phrase across */
  w: number
  /** distance between staff lines */
  gap?: number
  colour: RGB
  lineColour: RGB
  /** sharps (positive) or flats (negative), as in MusicXML */
  fifths?: number
  /** ticks spanned by the drawn phrase */
  span: number
  /** ticks per quarter, for deciding stems and beams */
  tpq: number
  /** draw a bar line every N ticks */
  barTicks?: number
  alpha?: number
}

/** Diatonic step index for a MIDI pitch: how many staff positions above C-1.
 *  Notation is diatonic, so C and C# occupy the same line — the accidental is
 *  what distinguishes them, and at this size we let the key signature carry it. */
function diatonicStep(midi: number): number {
  const PC_TO_STEP = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6]
  const octave = Math.floor(midi / 12)
  return octave * 7 + (PC_TO_STEP[((midi % 12) + 12) % 12] ?? 0)
}

/**
 * Draw a phrase on a treble staff and return the width actually used.
 *
 * Positions are diatonic, so the melody's contour is the real contour — a leap
 * of a third looks like a third. Notes outside the staff get ledger lines.
 */
export function drawStaff(bmp: Bitmap, notes: StaffNote[], o: StaffOpts): void {
  const gap = o.gap ?? 10
  const a = o.alpha ?? 1
  const staffH = gap * 4
  const top = o.y

  // five lines
  for (let i = 0; i < 5; i++) {
    fillRect(bmp, o.x, top + i * gap, o.w, 1, o.lineColour, a * 0.85)
  }

  // The clef spans about 1.6 staff heights, as a real one does, and its spiral
  // (glyph row 21 of 44) sits on the G line — the second line up. Anything less
  // and it reads as a squiggle floating above the staff.
  const clefScale = Math.max(1, Math.round((staffH * 1.6) / 44))
  const clefW = 14 * clefScale
  const gLineY = top + 3 * gap
  drawScaled(bmp, G_CLEF, o.x + gap, gLineY - 21 * clefScale, clefScale, o.lineColour, a)

  // key signature: sharps on F#, C#, G#, D#, A# / flats on Bb, Eb, Ab, Db, Gb.
  // Treble staff: E4 sits on the bottom line, so step(E4) is our zero.
  const E4 = diatonicStep(64)
  const yFor = (step: number) => top + staffH - ((step - E4) * gap) / 2
  const fifths = o.fifths ?? 0
  const SHARP_ORDER = [77, 72, 79, 74, 69, 76, 71] // F5 C5 G5 D5 A4 E5 B4
  const FLAT_ORDER = [71, 76, 69, 74, 67, 72, 65] // B4 E5 A4 D5 G4 C5 F4
  let kx = o.x + gap + clefW + Math.round(gap * 0.6)
  const accidentals = Math.min(5, Math.abs(fifths)) // 6 or 7 gets cluttered here
  for (let i = 0; i < accidentals; i++) {
    const midi = fifths > 0 ? SHARP_ORDER[i]! : FLAT_ORDER[i]!
    const glyph = fifths > 0 ? SHARP : FLAT
    const gh = fifths > 0 ? 11 : 12
    stamp(bmp, glyph, kx, Math.round(yFor(diatonicStep(midi)) - gh / 2), o.lineColour, a * 0.9)
    kx += (fifths > 0 ? 7 : 6) + 2
  }

  // the notes
  const noteX0 = kx + Math.round(gap * 1.2)
  const usable = o.x + o.w - noteX0 - gap
  if (usable <= 20 || notes.length === 0) return
  const xFor = (t: number) => noteX0 + (t / o.span) * usable

  // bar lines, so the phrase has measures instead of being a stream of dots
  if (o.barTicks) {
    for (let t = o.barTicks; t <= o.span; t += o.barTicks) {
      fillRect(bmp, Math.round(xFor(t) - gap * 0.55), top, 1, staffH + 1, o.lineColour, a * 0.55)
    }
  }
  // and the closing double bar
  fillRect(bmp, o.x + o.w - 5, top, 1, staffH + 1, o.lineColour, a * 0.6)
  fillRect(bmp, o.x + o.w - 2, top, 3, staffH + 1, o.lineColour, a * 0.85)

  // stems point away from the middle line, as they should
  const midStep = E4 + 4 // B4, the middle line
  const placed = notes
    .filter((n) => n.t < o.span)
    .map((n) => {
      const step = diatonicStep(n.midi)
      return { ...n, step, cx: xFor(n.t), cy: yFor(step), up: step < midStep }
    })

  for (const n of placed) {
    // ledger lines, above and below
    const stepsAbove = n.step - (E4 + 8) // top line is F5
    const stepsBelow = E4 - n.step
    for (let s = 2; s <= stepsAbove; s += 2) {
      fillRect(bmp, n.cx - 8, yFor(E4 + 8 + s), 17, 1, o.lineColour, a * 0.85)
    }
    for (let s = 2; s <= stepsBelow; s += 2) {
      fillRect(bmp, n.cx - 8, yFor(E4 - s), 17, 1, o.lineColour, a * 0.85)
    }
    noteHead(bmp, n.cx, n.cy, o.colour, a)
  }

  // Stems and beams. Runs of equal short durations are beamed exactly as the
  // MusicXML export groups them, so the card and the sheet agree.
  const stemLen = gap * 3.2
  const minStem = gap * 2.2
  const beamed = new Set<number>()
  for (let i = 0; i < placed.length; i++) {
    if (beamed.has(i)) continue
    const n = placed[i]!
    if (n.dur >= o.tpq) continue
    let j = i
    while (j + 1 < placed.length && placed[j + 1]!.dur === n.dur && placed[j + 1]!.up === n.up) j++
    if (j === i) continue
    const run = placed.slice(i, j + 1)
    const up = n.up
    const first = run[0]!
    const last = run[run.length - 1]!

    // A horizontal beam over notes at different pitches looks like a staple.
    // Engravers slope it along the contour, gently — the slope is clamped so a
    // big leap does not produce a diagonal that fights the staff.
    const maxSlope = gap * 1.2
    let y0 = up ? first.cy - stemLen : first.cy + stemLen
    let y1 = up ? last.cy - stemLen : last.cy + stemLen
    const mid = (y0 + y1) / 2
    const half = Math.max(-maxSlope, Math.min(maxSlope, (y1 - y0) / 2))
    y0 = mid - half
    y1 = mid + half

    // then push the whole beam clear of every notehead in the run
    const at = (x: number) => y0 + ((y1 - y0) * (x - first.cx)) / Math.max(1, last.cx - first.cx)
    let push = 0
    for (const p2 of run) {
      const want = up ? p2.cy - minStem : p2.cy + minStem
      const have = at(p2.cx)
      if (up) push = Math.min(push, want - have)
      else push = Math.max(push, want - have)
    }
    y0 += push
    y1 += push

    const beams = n.dur <= o.tpq / 4 ? 2 : 1
    for (let bi = 0; bi < beams; bi++) {
      const off = (up ? 1 : -1) * bi * (gap * 0.42)
      drawBeam(bmp, first.cx + (up ? 4 : -4), y0 + off, last.cx + (up ? 4 : -4), y1 + off, 3, o.colour, a)
    }
    for (const p2 of run) {
      const sx = up ? p2.cx + 4 : p2.cx - 4
      const by = at(p2.cx) + push
      fillRect(bmp, sx, Math.min(p2.cy, by), 2, Math.abs(p2.cy - by), o.colour, a)
    }
    for (let k = i; k <= j; k++) beamed.add(k)
  }
  // everything else gets a plain stem (no flags: at this size a flag is mush)
  for (let i = 0; i < placed.length; i++) {
    if (beamed.has(i)) continue
    const p2 = placed[i]!
    const sx = p2.up ? p2.cx + 4 : p2.cx - 4
    const y0 = p2.up ? p2.cy - stemLen : p2.cy
    fillRect(bmp, sx, y0, 2, stemLen, o.colour, a)
  }
}

/** A sloped beam, thickness `t`, drawn as a column-wise fill so it stays crisp
 *  in a pixel renderer (no anti-aliasing to smear it). */
function drawBeam(
  bmp: Bitmap, x0: number, y0: number, x1: number, y1: number, t: number, c: RGB, a = 1,
): void {
  const x = Math.round(Math.min(x0, x1))
  const xe = Math.round(Math.max(x0, x1))
  const ya = x0 <= x1 ? y0 : y1
  const yb = x0 <= x1 ? y1 : y0
  const w = Math.max(1, xe - x)
  for (let i = 0; i <= w; i++) {
    const y = ya + ((yb - ya) * i) / w
    fillRect(bmp, x + i, Math.round(y), 1, t, c, a)
  }
}

function drawScaled(bmp: Bitmap, rows: string[], x: number, y: number, scale: number, c: RGB, a = 1): void {
  rows.forEach((row, dy) => {
    ;[...row].forEach((ch, dx) => {
      if (ch !== '.') fillRect(bmp, x + dx * scale, y + dy * scale, scale, scale, c, a)
    })
  })
}
