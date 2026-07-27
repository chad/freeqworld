// Standard MIDI File export.
//
// The point of this is portability: a theme derived from your DID stops being a
// thing only this engine can play and becomes a file you can open in a DAW, a
// notation program, or a tracker. Nothing here is lossy about *pitch and time* —
// which is what a score is — but the timbre is necessarily an approximation,
// because "NES pulse wave at 12.5% duty" is not a General MIDI program. The
// mapping is stated in PATCH_PROGRAM below rather than hidden.
//
// Format 1 (one tempo map track + one track per voice), 480 ticks per quarter
// note, which is the common DAW resolution and an exact multiple of the score's
// TPQ (48), so every event lands on an integer tick with no rounding.

import { CHANNELS, monophonize, TPQ, type Channel, type Note, type Score } from './score'

/** SMF division. 480 = 10 × TPQ, so score ticks convert exactly. */
export const PPQ = 480
const SCALE = PPQ / TPQ

/**
 * Chiptune voice → General MIDI program. These are choices, not truths: the
 * aim is that an untouched playback in any GM synth sounds like the same piece
 * of music, with the right voice in the right role.
 */
export const PATCH_PROGRAM: Record<Channel, { program: number; name: string }> = {
  pulse1: { program: 80, name: 'Lead 1 (square)' },
  pulse2: { program: 80, name: 'Lead 1 (square)' },
  triangle: { program: 38, name: 'Synth Bass 1' },
  noise: { program: 0, name: 'Drums (channel 10)' },
  dpcm: { program: 0, name: 'Drums (channel 10)' },
  aux: { program: 89, name: 'Pad 2 (warm)' },
}

/** Percussion lands on GM channel 10. The engine's noise/dpcm "pitch" selects a
 *  drum sound, so map it to the nearest GM drum rather than a literal note. */
export function drumNote(midi: number): number {
  if (midi <= 40) return 36 // bass drum
  if (midi <= 48) return 38 // snare
  if (midi <= 56) return 42 // closed hat
  if (midi <= 64) return 46 // open hat
  return 49 // crash
}

// --- byte helpers -----------------------------------------------------------

function varLen(n: number): number[] {
  if (n < 0) throw new Error(`negative delta: ${n}`)
  const out = [n & 0x7f]
  let v = Math.floor(n / 128)
  while (v > 0) {
    out.unshift((v & 0x7f) | 0x80)
    v = Math.floor(v / 128)
  }
  return out
}

function be32(n: number): number[] {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
}

function be16(n: number): number[] {
  return [(n >>> 8) & 255, n & 255]
}

/** SMF text events are specified as ASCII, and tools decode them as latin-1.
 *  Writing UTF-8 makes "G# harmonic minor — pendulum" arrive as
 *  "G# harmonic minor â€” pendulum" in anything that follows the spec (verified
 *  with mido), so transliterate the few typographic characters the composer
 *  actually emits and drop anything else non-ASCII. */
export function asciiFold(s: string): string {
  return s
    .replace(/[—–]/g, '-')
    .replace(/[""„]/g, '"')
    .replace(/['']/g, "'")
    .replace(/…/g, '...')
    .replace(/[♭]/g, 'b')
    .replace(/[♯]/g, '#')
    .replace(/[^\x20-\x7e]/g, '')
}

function textEvent(type: number, s: string): number[] {
  const bytes = [...new TextEncoder().encode(asciiFold(s))]
  return [0xff, type, ...varLen(bytes.length), ...bytes]
}

function chunk(id: string, body: number[]): number[] {
  return [...[...id].map((c) => c.charCodeAt(0)), ...be32(body.length), ...body]
}

interface Ev {
  t: number
  /** note-offs sort before note-ons at the same tick, so a repeated pitch
   *  retriggers instead of being cut by its own predecessor's off */
  order: number
  bytes: number[]
}

/**
 * The key signature meta event wants a number of sharps (positive) or flats
 * (negative). Modes are expressed relative to their major, which is what the
 * `mode` byte cannot capture — MIDI only knows major/minor — so a dorian tune
 * is written with its parent major's accidentals and flagged minor when its
 * third is minor. Notation programs then show the right accidentals.
 */
export function keySignatureFifths(tonicPc: number, scale: readonly number[]): number {
  // semitone offset from the tonic down to the relative major's tonic
  const third = scale[2] ?? 4
  const isMinorish = third === 3
  // fifths for a major tonic pitch class: C=0 G=1 D=2 ... F=-1
  const MAJOR_FIFTHS = [0, -5, 2, -3, 4, -1, 6, 1, -4, 3, -2, 5]
  const relMajorPc = isMinorish ? (tonicPc + 3) % 12 : tonicPc
  return MAJOR_FIFTHS[relMajorPc] ?? 0
}

export interface MidiOptions {
  /** written into a track-name meta event */
  title?: string
  /** copyright / provenance line, e.g. the DID this was derived from */
  comment?: string
  tonicPc?: number
  scale?: readonly number[]
}

/**
 * Encode a Score as a format-1 Standard MIDI File.
 *
 * Monophonises first, because the score's channels model real hardware where a
 * later note cuts an earlier one — writing overlaps would produce a file that
 * plays back *fuller* than the piece actually is.
 */
export function encodeMidi(score: Score, opts: MidiOptions = {}): Uint8Array {
  const notes = monophonize(score.notes)
  const lanes = CHANNELS.map((ch) => ({ ch, notes: notes.filter((n) => n.ch === ch) })).filter(
    (l) => l.notes.length > 0,
  )

  // --- track 0: tempo, meter, key, names ---
  const meta: number[] = []
  const push = (delta: number, bytes: number[]) => meta.push(...varLen(delta), ...bytes)
  push(0, textEvent(0x03, opts.title ?? score.name))
  if (opts.comment) push(0, textEvent(0x02, opts.comment))
  const usPerQuarter = Math.round(60_000_000 / score.bpm)
  push(0, [0xff, 0x51, 0x03, (usPerQuarter >> 16) & 255, (usPerQuarter >> 8) & 255, usPerQuarter & 255])
  const [beats, unit] = score.meter
  push(0, [0xff, 0x58, 0x04, beats, Math.round(Math.log2(unit)), 24, 8])
  if (opts.scale) {
    const fifths = keySignatureFifths(opts.tonicPc ?? 0, opts.scale)
    const minor = (opts.scale[2] ?? 4) === 3 ? 1 : 0
    push(0, [0xff, 0x59, 0x02, fifths & 0xff, minor])
  }
  push(score.length * SCALE, [0xff, 0x2f, 0x00]) // end of track, at the loop point
  const tracks: number[][] = [chunk('MTrk', meta)]

  // --- one track per voice ---
  for (const lane of lanes) {
    const isDrums = lane.ch === 'noise' || lane.ch === 'dpcm'
    const chan = isDrums ? 9 : Math.min(8, lanes.filter((l) => l !== lane).length) // 0-based; 9 = GM drums
    const evs: Ev[] = []
    for (const n of lane.notes) {
      const midi = isDrums ? drumNote(n.midi) : clampMidi(n.midi)
      const vel = Math.max(1, Math.min(127, Math.round((n.vel ?? 0.8) * 127)))
      const t0 = n.t * SCALE
      const t1 = (n.t + Math.max(1, n.dur)) * SCALE
      // An arpeggio is one channel cycling through offsets at ~60Hz. As MIDI
      // that is a rapid sequence of short notes; writing only the root would
      // silently drop the chord the arp exists to imply.
      if (n.arp && n.arp.length > 1 && !isDrums) {
        const step = Math.max(1, Math.round(PPQ / 16))
        let t = t0
        let i = 0
        while (t < t1) {
          const end = Math.min(t1, t + step)
          const p = clampMidi(n.midi + (n.arp[i % n.arp.length] ?? 0))
          evs.push({ t, order: 1, bytes: [0x90 | chan, p, vel] })
          evs.push({ t: end, order: 0, bytes: [0x80 | chan, p, 0] })
          t = end
          i++
        }
        continue
      }
      evs.push({ t: t0, order: 1, bytes: [0x90 | chan, midi, vel] })
      evs.push({ t: t1, order: 0, bytes: [0x80 | chan, midi, 0] })
    }
    evs.sort((a, b) => a.t - b.t || a.order - b.order)

    const body: number[] = []
    body.push(...varLen(0), ...textEvent(0x03, `${lane.ch} — ${lane.notes[0]?.patch ?? ''}`.trim()))
    if (!isDrums) body.push(...varLen(0), 0xc0 | chan, PATCH_PROGRAM[lane.ch].program)
    let last = 0
    for (const e of evs) {
      body.push(...varLen(e.t - last), ...e.bytes)
      last = e.t
    }
    body.push(...varLen(Math.max(0, score.length * SCALE - last)), 0xff, 0x2f, 0x00)
    tracks.push(chunk('MTrk', body))
  }

  const header = chunk('MThd', [...be16(1), ...be16(tracks.length), ...be16(PPQ)])
  return new Uint8Array([...header, ...tracks.flat()])
}

function clampMidi(m: number): number {
  return Math.max(0, Math.min(127, Math.round(m)))
}

/** Notes, flattened and monophonised — shared with the MusicXML writer so the
 *  two exports can never disagree about what the piece is. */
export function pitchedLanes(score: Score): { ch: Channel; notes: Note[] }[] {
  const notes = monophonize(score.notes)
  return CHANNELS.filter((ch) => ch !== 'noise' && ch !== 'dpcm')
    .map((ch) => ({ ch, notes: notes.filter((n) => n.ch === ch) }))
    .filter((l) => l.notes.length > 0)
}
