// Generative chiptune composer: Theme -> Score.
//
// The rules that make it sound like game music rather than noodling:
//   1. Four-bar phrases with an AABA'-style form — repetition is the melody.
//   2. Strong beats are snapped to chord tones; weak beats step through the
//      scale. Reused phrases re-snap to the new chord, so a repeat sounds
//      intentional rather than wrong.
//   3. Hard NES channel budget: one lead, one harmony, one bass, drums.
//   4. Arrangement layers in (intro -> full -> break -> full) so a 32-bar loop
//      has somewhere to go.

import {
  chordTones, degreeToMidi, noteToMidi, SCALES, voiceChord,
  type Chord, type ScaleName,
} from './theory.ts'
import { TPQ, ticksPerBar, type Channel, type Note, type Score } from './score.ts'
import { chance, randInt, rngFromString, weighted, type Rng } from './seed.ts'

export type BassStyle = 'root5' | 'walking' | 'pulse' | 'ostinato' | 'sparse' | 'funk'
export type HarmonyStyle = 'arp' | 'arp-down' | 'chord' | 'stab' | 'pad' | 'none'
export type DrumStyle = 'straight' | 'four' | 'mechanical' | 'sparse' | 'breaks' | 'none'

export interface Motif {
  /** 3–5 scale-degree offsets — the identity contour (spec §11.5) */
  degrees: number[]
  /** rhythm cell in 16th-note units, same length as degrees */
  rhythm: number[]
  patch: string
}

export interface Theme {
  id: string
  name: string
  bpm: number
  meter: [number, number]
  /** tonic of the melodic register, e.g. 'C4' */
  key: string
  scale: ScaleName
  progression: Chord[]
  bass: BassStyle
  harmony: HarmonyStyle
  drums: DrumStyle
  lead: { patch: string; density: number; rest: number; octave?: number; shape?: Shape }
  /** low-level noise bed, only used when the drums are sparse */
  texture?: 'wind' | 'none'
  motif?: Motif
  /** total bars; defaults to 4 progression cycles rounded to 16–32 bars */
  bars?: number
  /** odd-meter insert, e.g. a 5/4 bar every 8 measures (the Workshop) */
  insert?: { everyBars: number; meter: [number, number] }
  seed?: string
}

interface PhraseEvent {
  /** offset within the bar, in 16th units */
  pos: number
  len: number
  /** absolute scale degree (0 = tonic of `key`) */
  deg: number
  strong: boolean
  rest: boolean
}

const U = TPQ / 4 // ticks per 16th note

// ---------------------------------------------------------------------------
// helpers

function expandProgression(prog: Chord[]): Chord[] {
  const out: Chord[] = []
  for (const c of prog) for (let i = 0; i < (c.bars ?? 1); i++) out.push({ ...c, bars: 1 })
  return out
}

/** Chord tones expressed as scale degrees (so we can snap in degree space). */
function chordDegrees(chord: Chord): number[] {
  const stacks: Record<string, number[]> = {
    power: [0, 4], triad: [0, 2, 4], sixth: [0, 2, 4, 5], seventh: [0, 2, 4, 6],
    ninth: [0, 2, 4, 6, 8], sus4: [0, 3, 4], sus2: [0, 1, 4],
  }
  return (stacks[chord.quality ?? 'triad'] ?? stacks.triad!).map((s) => chord.degree + s)
}

/** Octave-fold a note into [lo,hi] so no part drifts out of its register. */
function foldInto(midi: number, lo: number, hi: number): number {
  let n = midi
  while (n < lo) n += 12
  while (n > hi) n -= 12
  return n
}

/** Nearest chord tone to `deg`, searching in degree space across octaves. */
function snapDegree(deg: number, chordDegs: number[]): number {
  let best = deg
  let bestDist = Infinity
  for (const cd of chordDegs) {
    for (let oct = -2; oct <= 2; oct++) {
      const cand = cd + oct * 7
      const d = Math.abs(cand - deg)
      if (d < bestDist) {
        bestDist = d
        best = cand
      }
    }
  }
  return best
}

/** Fill one bar with note lengths (16th units), shorter lengths as density rises. */
function rhythmCell(rng: Rng, units: number, density: number): number[] {
  const lens = [8, 6, 4, 3, 2, 1]
  const w = [
    1 + (1 - density) * 5,
    1.2,
    3 + (1 - density) * 3,
    0.8 + density * 1.5,
    2 + density * 7,
    density * 2,
  ]
  const cell: number[] = []
  let left = units
  while (left > 0) {
    let l = weighted(rng, lens, w)
    if (l > left) l = left
    cell.push(l)
    left -= l
  }
  return cell
}

// ---------------------------------------------------------------------------
// melody

export type Shape = 'arch' | 'rise' | 'fall' | 'wave' | 'hook' | 'plateau'

/** Normalised melodic contour: this is what makes a phrase feel *written*. */
function shapeAt(shape: Shape, u: number): number {
  switch (shape) {
    case 'arch': return Math.sin(Math.PI * u)
    case 'rise': return u
    case 'fall': return 1 - u
    case 'wave': return 0.5 + 0.5 * Math.sin(2 * Math.PI * u - Math.PI / 2)
    case 'hook': return u < 0.7 ? u / 0.7 : 1 - (u - 0.7) / 0.3
    case 'plateau': return u < 0.25 ? u * 4 : 1
  }
}

function makePhrase(rng: Rng, theme: Theme, units: number, motif?: Motif): PhraseEvent[] {
  const events: PhraseEvent[] = []
  let pos = 0

  // A motif seeds the head of the phrase: its contour is the identity.
  if (motif) {
    for (let i = 0; i < motif.degrees.length && pos < units; i++) {
      const len = Math.min(motif.rhythm[i]!, units - pos)
      events.push({ pos, len, deg: motif.degrees[i]!, strong: pos % 8 === 0, rest: false })
      pos += len
    }
  }

  const cell = rhythmCell(rng, units - pos, theme.lead.density)
  const n = cell.length
  // sparse phrases need a monotonic line — an arch across two notes is a
  // straight line, which is how melodies end up standing still.
  const shape: Shape = theme.lead.shape
    ?? (n <= 3
      ? weighted(rng, ['rise', 'fall', 'hook'] as Shape[], [2, 3, 1])
      : weighted(rng, ['arch', 'rise', 'fall', 'wave', 'hook', 'plateau'] as Shape[], [4, 2, 2, 3, 3, 1]))
  const amp = randInt(rng, 3, 6)
  const base = weighted(rng, [0, -3, 2, 4], [4, 2, 2, 1])

  for (let i = 0; i < n; i++) {
    const len = cell[i]!
    const strong = pos % 8 === 0
    const u = n === 1 ? 0 : i / (n - 1)
    // arc (centred on `base`, so phrases swing both ways) + neighbour motion
    let deg = base + Math.round((shapeAt(shape, u) - 0.4) * amp)
    if (!strong) deg += weighted(rng, [-1, 0, 1], [2, 3, 2])
    if (i === n - 1 && n >= 4) deg = base + (chance(rng, 0.5) ? 0 : 2) // land somewhere stable
    if (deg > 6) deg -= 7
    if (deg < -3) deg += 7
    // rests give the phrase a breath, but never on the downbeat or the head
    const rest = !strong && i > 1 && chance(rng, theme.lead.rest)
    events.push({ pos, len, deg, strong, rest })
    pos += len
  }
  return events
}

/** A' — same phrase, small tail variation, so the fourth bar answers. */
function varyPhrase(rng: Rng, phrase: PhraseEvent[]): PhraseEvent[] {
  const out = phrase.map((e) => ({ ...e }))
  const last = out[out.length - 1]
  if (!last) return out
  if (chance(rng, 0.5) && last.len >= 4) {
    // split the last note into a two-note turn
    const half = Math.floor(last.len / 2)
    last.len = half
    out.push({ pos: last.pos + half, len: last.len, deg: last.deg + (chance(rng, 0.5) ? 1 : -1), strong: false, rest: false })
  } else {
    last.deg += chance(rng, 0.5) ? 2 : -2
  }
  for (const e of out) if (e.rest && chance(rng, 0.3)) e.rest = false
  return out
}

// ---------------------------------------------------------------------------
// parts

function bassBar(
  rng: Rng, style: BassStyle, root: number, tones: number[], units: number, ostinato: number[],
): { pos: number; len: number; midi: number; vel: number }[] {
  const fifth = tones[Math.min(2, tones.length - 1)] ?? root + 7
  const third = tones[1] ?? root + 4
  const out: { pos: number; len: number; midi: number; vel: number }[] = []
  const put = (pos: number, len: number, midi: number, vel = 1) => {
    if (pos < units) out.push({ pos, len: Math.min(len, units - pos), midi, vel })
  }
  switch (style) {
    case 'sparse':
      put(0, units, root)
      break
    case 'root5':
      put(0, Math.floor(units / 2), root)
      put(Math.floor(units / 2), Math.ceil(units / 2), fifth - 12 < root - 7 ? fifth : fifth - 12)
      break
    case 'pulse':
      for (let p = 0; p < units; p += 2) put(p, 2, p % 8 === 0 ? root : root, p % 4 === 0 ? 1 : 0.75)
      break
    case 'walking': {
      const line = [root, fifth - 12, root, third - 12 < root ? third : third - 12]
      for (let p = 0, i = 0; p < units; p += 2, i++) {
        const n = line[i % line.length]!
        put(p, 2, i % 8 === 7 && chance(rng, 0.5) ? n + 2 : n, p % 4 === 0 ? 1 : 0.8)
      }
      break
    }
    case 'funk': {
      const hits = [0, 3, 6, 7, 10, 12, 14]
      for (const h of hits) if (h < units) put(h, 2, chance(rng, 0.25) ? root + 12 : root, h === 0 ? 1 : 0.8)
      break
    }
    case 'ostinato': {
      let p = 0
      for (let i = 0; i < ostinato.length && p < units; i++) {
        const len = i % 2 === 0 ? 3 : 1
        put(p, len, root + ostinato[i]!, i === 0 ? 1 : 0.82)
        p += len
      }
      while (p < units) {
        for (let i = 0; i < ostinato.length && p < units; i++) {
          const len = i % 2 === 0 ? 3 : 1
          put(p, len, root + ostinato[i]!, 0.75)
          p += len
        }
      }
      break
    }
  }
  return out
}

function drumBar(rng: Rng, style: DrumStyle, units: number, fill: boolean): Note[] {
  const notes: Note[] = []
  const hit = (pos: number, patch: string, midi: number, vel = 1, ch: Channel = 'noise') => {
    if (pos < units) notes.push({ ch, patch, t: pos * U, dur: 2 * U, midi, vel })
  }
  const kick = (pos: number, vel = 1) => hit(pos, 'kick', 36, vel, 'dpcm')
  const snare = (pos: number, vel = 1) => hit(pos, 'snare', 60, vel)
  const hat = (pos: number, vel = 1) => hit(pos, 'hat', 84, vel)

  switch (style) {
    case 'straight':
      kick(0); kick(8, 0.9)
      snare(4); snare(12)
      for (let p = 0; p < units; p += 2) hat(p, p % 4 === 0 ? 0.9 : 0.6)
      break
    case 'four':
      for (let p = 0; p < units; p += 4) kick(p, p === 0 ? 1 : 0.9)
      snare(4, 0.85); snare(12, 0.85)
      for (let p = 2; p < units; p += 4) hit(p, 'hat.open', 82, 0.5)
      break
    case 'mechanical':
      kick(0); kick(7, 0.8); kick(10, 0.6)
      hit(4, 'clank', 66, 0.8); hit(12, 'clank', 62, 0.8)
      for (let p = 2; p < units; p += 4) hat(p, 0.45)
      break
    case 'sparse':
      if (chance(rng, 0.8)) kick(0, 0.85)
      snare(8, 0.6)
      if (chance(rng, 0.4)) hat(14, 0.35)
      break
    case 'breaks':
      kick(0); kick(6, 0.85); kick(11, 0.7)
      snare(4); snare(10, 0.5); snare(12)
      for (let p = 0; p < units; p += 2) hat(p, p % 4 === 0 ? 0.8 : 0.45)
      break
    case 'none':
      return notes
  }
  if (fill) {
    // (the 'none' style returned above)
    // clear the back half of the bar and roll into the next phrase
    const from = units - 4
    for (let i = notes.length - 1; i >= 0; i--) if (notes[i]!.t >= from * U) notes.splice(i, 1)
    for (let p = from; p < units; p++) snare(p, 0.5 + (p - from) * 0.14)
    kick(units - 1, 0.6)
  }
  return notes
}

function harmonyBar(
  rng: Rng, style: HarmonyStyle, tones: number[], low: number, units: number, patchName: string,
): Note[] {
  const notes: Note[] = []
  const voiced = voiceChord(tones, low)
  const offsets = voiced.map((v) => v - voiced[0]!)
  switch (style) {
    case 'none':
      break
    case 'arp':
    case 'arp-down': {
      const seq = style === 'arp' ? voiced : [...voiced].reverse()
      const full = [...seq, ...(chance(rng, 0.5) ? [...seq].reverse().slice(1, -1) : seq.slice(0, 2))]
      for (let p = 0, i = 0; p < units; p += 1, i++) {
        notes.push({
          ch: 'pulse2', patch: patchName, t: p * U, dur: U,
          midi: full[i % full.length]! + (i % 8 === 0 ? 0 : 0),
          vel: p % 4 === 0 ? 0.95 : 0.7,
        })
      }
      break
    }
    case 'chord':
      // one voice, arpeggiated at 60 Hz — the classic chip "chord"
      notes.push({
        ch: 'pulse2', patch: patchName, t: 0, dur: units * U,
        midi: voiced[0]!, vel: 0.8, arp: offsets,
      })
      break
    case 'stab':
      for (let p = 2; p < units; p += 4) {
        notes.push({ ch: 'pulse2', patch: patchName, t: p * U, dur: 2 * U, midi: voiced[0]!, vel: 0.8, arp: offsets })
      }
      break
    case 'pad':
      notes.push({
        ch: 'pulse2', patch: patchName, t: 0, dur: units * U,
        midi: voiced[0]!, vel: 0.7, arp: offsets,
      })
      break
  }
  return notes
}

// ---------------------------------------------------------------------------

export function compose(theme: Theme): Score {
  const rng = rngFromString(`${theme.id}:${theme.seed ?? 'v1'}`)
  const scale = SCALES[theme.scale]
  const root = noteToMidi(theme.key)
  const prog = expandProgression(theme.progression)
  const barTicks = ticksPerBar(theme.meter)
  const insertTicks = theme.insert ? ticksPerBar(theme.insert.meter) : barTicks
  const barTicksAt = (bar: number): number =>
    theme.insert && (bar + 1) % theme.insert.everyBars === 0 ? insertTicks : barTicks
  const units = Math.round(barTicks / U)
  const totalBars = theme.bars ?? Math.max(16, prog.length * (prog.length <= 4 ? 8 : 4))

  const leadOct = (theme.lead.octave ?? 1) * 12
  const harmonyPatch = theme.harmony === 'pad' ? 'pad.pulse50'
    : theme.harmony === 'stab' ? 'stab.pulse25'
    : theme.harmony === 'chord' ? 'arp.pulse25' : 'arp.pulse125'

  // --- phrase bank: two-bar phrases in an eight-bar AABA' period ----------
  const span = units * 2
  const A = makePhrase(rng, theme, span, theme.motif)
  const B = makePhrase(rng, theme, span)
  const A2 = varyPhrase(rng, A)
  const form: PhraseEvent[][] = [A, A, B, A2]

  const ostinato = [0, 7, 0, 3, 0, 7, 10, 7].slice(0, randInt(rng, 4, 8))
  const notes: Note[] = []

  let t0 = 0
  for (let bar = 0; bar < totalBars; bar++) {
    const barLen = barTicksAt(bar)
    const barUnits = Math.round(barLen / U)
    const chord = prog[bar % prog.length]!
    const cds = chordDegrees(chord)
    const tones = chordTones(root, scale, chord)
    // registers: bass A1..E3, harmony sits a fourth below the tonic, lead above
    const bassRoot = foldInto(degreeToMidi(root - 24, scale, chord.degree), 33, 52)
    const phrasePos = bar % 4
    const section = Math.floor(bar / 4)
    const sections = Math.max(1, Math.ceil(totalBars / 4))

    // arrangement: intro / full / break / full, so a long loop breathes
    const isIntro = sections >= 4 && section === 0
    const isBreak = sections >= 6 && section === Math.floor(sections / 2)
    const leadOn = !isIntro && !(isBreak && phrasePos < 2)
    const harmonyOn = !(isIntro && phrasePos < 2) && !isBreak
    const drumsOn = !(isIntro && phrasePos < 1)
    // classic last-chorus lift, but only where it won't shriek
    const octaveLift =
      sections >= 6 && section === sections - 1 && degreeToMidi(root, scale, 6) + leadOct <= 80 ? 12 : 0

    // bass
    for (const b of bassBar(rng, theme.bass, bassRoot, tones.map((t) => t - 24), barUnits, ostinato)) {
      notes.push({
        ch: 'triangle', patch: 'bass.tri', t: t0 + b.pos * U,
        dur: Math.max(U, b.len * U - 2), midi: b.midi, vel: b.vel,
      })
    }

    // harmony
    if (harmonyOn) {
      for (const n of harmonyBar(rng, theme.harmony, tones, foldInto(root - 5, 52, 64), barUnits, harmonyPatch)) {
        notes.push({ ...n, t: t0 + n.t })
      }
    }

    // lead
    if (leadOn) {
      const phrase = form[Math.floor((bar % 8) / 2)]!
      const off = (bar % 2) * units
      for (const e of phrase) {
        const pos = e.pos - off
        if (e.rest || pos < 0 || pos >= barUnits) continue
        const deg = e.strong ? snapDegree(e.deg, cds) : e.deg
        const midi = degreeToMidi(root, scale, deg) + leadOct + octaveLift
        notes.push({
          ch: 'pulse1', patch: theme.lead.patch, t: t0 + pos * U,
          dur: Math.max(U, Math.min(e.len, barUnits - pos) * U - 3), midi,
          vel: e.strong ? 1 : 0.85,
          slide: pos === 0 && bar % 8 === 0 && chance(rng, 0.2) ? -2 : undefined,
        })
      }
    }

    // drums
    if (drumsOn) {
      const fill = bar % 8 === 7 && chance(rng, 0.8) && !isIntro
      for (const n of drumBar(rng, theme.drums, barUnits, fill)) notes.push({ ...n, t: t0 + n.t })
    }

    // texture bed
    if (theme.texture === 'wind' && bar % 4 === 0) {
      notes.push({ ch: 'aux', patch: 'wind', t: t0, dur: barLen * 4, midi: 72, vel: 0.8 })
    }

    t0 += barLen
  }

  return {
    id: theme.id,
    name: theme.name,
    bpm: theme.bpm,
    meter: theme.meter,
    length: t0,
    notes: notes.sort((a, b) => a.t - b.t),
  }
}
