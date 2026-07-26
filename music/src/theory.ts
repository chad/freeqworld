// Minimal music theory for the chiptune engine.
// Everything is integers (MIDI note numbers + scale degrees) so composition is
// deterministic and trivially serialisable.

export const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  majorPentatonic: [0, 2, 4, 7, 9],
  minorPentatonic: [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
} as const

export type ScaleName = keyof typeof SCALES

const NOTE_INDEX: Record<string, number> = {
  c: 0, 'c#': 1, db: 1, d: 2, 'd#': 3, eb: 3, e: 4, f: 5,
  'f#': 6, gb: 6, g: 7, 'g#': 8, ab: 8, a: 9, 'a#': 10, bb: 10, b: 11,
}

/** "C4" -> 60, "F#3" -> 54. */
export function noteToMidi(name: string): number {
  const m = /^([a-gA-G][#b]?)(-?\d+)$/.exec(name.trim())
  if (!m) throw new Error(`bad note name: ${name}`)
  const pc = NOTE_INDEX[m[1]!.toLowerCase()]
  if (pc === undefined) throw new Error(`bad pitch class: ${m[1]}`)
  return (Number(m[2]) + 1) * 12 + pc
}

export function midiToName(midi: number): string {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
  return `${names[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`
}

export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12)
}

/** Scale degree (0-based, may be negative or > scale length) -> MIDI note. */
export function degreeToMidi(root: number, scale: readonly number[], degree: number): number {
  const n = scale.length
  const oct = Math.floor(degree / n)
  const idx = ((degree % n) + n) % n
  return root + oct * 12 + scale[idx]!
}

/** Snap an arbitrary MIDI note to the nearest note in the scale. */
export function snapToScale(root: number, scale: readonly number[], midi: number): number {
  const pcs = scale.map((s) => (root + s) % 12)
  for (let d = 0; d < 7; d++) {
    if (pcs.includes(((midi - d) % 12 + 12) % 12)) return midi - d
    if (pcs.includes(((midi + d) % 12 + 12) % 12)) return midi + d
  }
  return midi
}

export type ChordQuality = 'triad' | 'seventh' | 'sus4' | 'sus2' | 'power' | 'sixth' | 'ninth'

export interface Chord {
  /** scale degree of the root, 0 = tonic */
  degree: number
  quality?: ChordQuality
  /** length in bars (default 1) */
  bars?: number
}

const STACKS: Record<ChordQuality, number[]> = {
  power: [0, 4],
  triad: [0, 2, 4],
  sixth: [0, 2, 4, 5],
  seventh: [0, 2, 4, 6],
  ninth: [0, 2, 4, 6, 8],
  sus4: [0, 3, 4],
  sus2: [0, 1, 4],
}

/** Diatonic chord tones as MIDI notes, voiced upward from the chord root. */
export function chordTones(root: number, scale: readonly number[], chord: Chord): number[] {
  const stack = STACKS[chord.quality ?? 'triad']
  return stack.map((s) => degreeToMidi(root, scale, chord.degree + s))
}

/** Chord tones folded into one octave starting at `low` — handy for arps. */
export function voiceChord(tones: readonly number[], low: number): number[] {
  return tones
    .map((t) => {
      let n = t
      while (n < low) n += 12
      while (n >= low + 12) n -= 12
      return n
    })
    .sort((a, b) => a - b)
}

/** Is this MIDI note a chord tone (pitch-class match)? */
export function isChordTone(midi: number, tones: readonly number[]): boolean {
  const pc = ((midi % 12) + 12) % 12
  return tones.some((t) => ((t % 12) + 12) % 12 === pc)
}
