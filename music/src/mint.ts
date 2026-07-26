// Phase 2: mint a unique chiptune per identity.
//
//   tune_seed = HKDF(DID, salt = "freeq-world-chiptune", info = "chiptune-v1")
//
// Same shape as the PFP project: everything is derived from the DID, nothing is
// uploaded, and the same DID always mints the same track. The personal
// leitmotif (§11.5, its own HKDF domain) becomes the head of the melody, so a
// minted tune and the little motif that plays when you walk into a room are
// audibly the same character.

import type { BassStyle, DrumStyle, HarmonyStyle, Theme } from './compose.ts'
import type { Chord, ScaleName } from './theory.ts'
import { deriveMotif, deriveStinger, motifForScale, type Leitmotif } from './motif.ts'
import type { Score } from './score.ts'
import { hkdfSha256, pick, seededPrng, weighted, type Rng } from './seed.ts'

const KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

const MODES: { scale: ScaleName; label: string; mood: string }[] = [
  { scale: 'major', label: 'major', mood: 'sunlit' },
  { scale: 'minor', label: 'natural minor', mood: 'wistful' },
  { scale: 'dorian', label: 'dorian', mood: 'cool' },
  { scale: 'lydian', label: 'lydian', mood: 'wondering' },
  { scale: 'mixolydian', label: 'mixolydian', mood: 'roving' },
  { scale: 'phrygian', label: 'phrygian', mood: 'shadowed' },
  { scale: 'harmonicMinor', label: 'harmonic minor', mood: 'arcane' },
  { scale: 'majorPentatonic', label: 'major pentatonic', mood: 'open' },
  { scale: 'minorPentatonic', label: 'minor pentatonic', mood: 'stark' },
]

/** Progressions in scale degrees — they work in any mode because they're
 *  degree-relative, and every one of them is a known-good game-music loop. */
const PROGRESSIONS: { name: string; chords: Chord[] }[] = [
  { name: 'wanderer', chords: [{ degree: 0 }, { degree: 5 }, { degree: 3 }, { degree: 4 }] },
  { name: 'ascent', chords: [{ degree: 0 }, { degree: 3 }, { degree: 4 }, { degree: 4 }] },
  { name: 'plaza', chords: [{ degree: 0, quality: 'sus2' }, { degree: 4 }, { degree: 5 }, { degree: 3 }] },
  { name: 'descent', chords: [{ degree: 5 }, { degree: 3 }, { degree: 0 }, { degree: 4 }] },
  { name: 'lantern', chords: [{ degree: 0 }, { degree: 6 }, { degree: 3 }, { degree: 4 }] },
  { name: 'stairs', chords: [{ degree: 0 }, { degree: 1 }, { degree: 3 }, { degree: 4 }] },
  { name: 'pendulum', chords: [{ degree: 0, bars: 2 }, { degree: 5, bars: 2 }] },
  { name: 'engine', chords: [{ degree: 0, quality: 'power', bars: 2 }, { degree: 2, quality: 'power' }, { degree: 4, quality: 'power' }] },
  { name: 'atrium', chords: [{ degree: 0, quality: 'seventh' }, { degree: 3, quality: 'seventh' }, { degree: 5, quality: 'seventh' }, { degree: 4, quality: 'sus4' }] },
  { name: 'circuit', chords: [{ degree: 0 }, { degree: 4 }, { degree: 5 }, { degree: 4 }] },
  { name: 'hollow', chords: [{ degree: 0, bars: 2 }, { degree: 1, bars: 2 }] },
  { name: 'market', chords: [{ degree: 3 }, { degree: 4 }, { degree: 0 }, { degree: 5 }] },
]

const BASSES: { style: BassStyle; label: string }[] = [
  { style: 'walking', label: 'walking triangle' },
  { style: 'root5', label: 'root-and-fifth' },
  { style: 'pulse', label: 'driving eighths' },
  { style: 'ostinato', label: 'ostinato loop' },
  { style: 'funk', label: 'syncopated' },
  { style: 'sparse', label: 'held low notes' },
]

const HARMONIES: { style: HarmonyStyle; label: string }[] = [
  { style: 'arp', label: 'rising arpeggio' },
  { style: 'arp-down', label: 'falling arpeggio' },
  { style: 'chord', label: 'buzz chord' },
  { style: 'stab', label: 'offbeat stabs' },
  { style: 'pad', label: 'sustained pad' },
]

const DRUMS: { style: DrumStyle; label: string }[] = [
  { style: 'straight', label: 'straight backbeat' },
  { style: 'four', label: 'four on the floor' },
  { style: 'mechanical', label: 'mechanical clank' },
  { style: 'breaks', label: 'broken beat' },
  { style: 'sparse', label: 'sparse pulse' },
  { style: 'none', label: 'no percussion' },
]

export interface Minted {
  did: string
  schema: 'freeq.at/profile/chiptune/v1'
  generator: 'chiptune-v1'
  seedHex: string
  motif: Leitmotif
  theme: Theme
  /** human-readable reveal card, mirrors the PFP trait summary */
  card: [string, string][]
}

export async function tuneSeed(did: string): Promise<Uint8Array> {
  return hkdfSha256(did, 'freeq-world-chiptune', 'chiptune-v1', 32)
}

export async function mintChiptune(did: string, bars = 32): Promise<Minted> {
  const seed = await tuneSeed(did)
  const seedHex = [...seed].map((b) => b.toString(16).padStart(2, '0')).join('')
  const rng: Rng = seededPrng(seed)

  const keyName = pick(rng, KEYS)
  const mode = pick(rng, MODES)
  // the leitmotif is canonical (shared/src/leitmotif.ts, conformance-locked);
  // here it is only translated into the minted tune's key
  const motif = await deriveMotif(did, mode.scale)
  // tempo lands on a musical value, weighted toward mid-tempo game music
  const bpm = weighted(
    rng,
    [72, 84, 92, 100, 108, 116, 124, 132, 144, 160],
    [1, 2, 3, 4, 5, 5, 4, 3, 2, 1],
  )
  const prog = pick(rng, PROGRESSIONS)

  // Tempo steers the groove. Fully independent picks give you 100 BPM tunes
  // with breakbeats and 160 BPM tunes with a sustained pad — unique, but they
  // sound assembled rather than written. Everything below is still derived
  // from the same seed; the weights just keep the combinations musical.
  const band = bpm < 96 ? 0 : bpm < 128 ? 1 : 2
  const bass = weighted(rng, BASSES, [
    [1, 3, 1, 2, 0.5, 3][band]!, // walking
    [2, 2, 1][band]!, // root-and-fifth
    [1, 2.5, 3][band]!, // driving eighths
    [2, 2, 1.5][band]!, // ostinato
    [0.5, 2, 2.5][band]!, // syncopated
    [2.5, 0.7, 0.3][band]!, // held low notes
  ])
  const harmony = weighted(rng, HARMONIES, [
    [1.5, 2.5, 2][band]!, // rising arp
    [1.5, 2, 1.5][band]!, // falling arp
    [1.5, 1, 1][band]!, // buzz chord
    [0.7, 2, 3][band]!, // offbeat stabs
    [3, 1, 0.5][band]!, // pad
  ])
  const drums = weighted(rng, DRUMS, [
    [2, 3, 2][band]!, // straight
    [0.5, 2, 3][band]!, // four on the floor
    [1.5, 2, 1][band]!, // mechanical
    [0.5, 1.5, 2.5][band]!, // breaks
    [3, 1, 0.5][band]!, // sparse
    [0.8, 0.25, 0.15][band]!, // silence is a choice, but a rare one
  ])
  // a drumless tune still needs a pulse, so give it a moving inner voice
  const harmonyStyle: (typeof HARMONIES)[number] =
    drums.style === 'none' && (harmony.style === 'pad' || harmony.style === 'chord')
      ? HARMONIES[rng() < 0.5 ? 0 : 3]!
      : harmony
  const density = 0.3 + rng() * 0.55
  const rest = 0.15 + rng() * 0.3
  const octave = pick(rng, [0, 1, 1, 1, 2])

  // keep every minted tonic inside one comfortable register (G3..F#4)
  const key = `${keyName}${KEYS.indexOf(keyName) <= 6 ? 4 : 3}`

  const theme: Theme = {
    id: `did:${seedHex.slice(0, 8)}`,
    name: `${keyName} ${mode.label} — ${prog.name}`,
    bpm,
    meter: [4, 4],
    key,
    scale: mode.scale,
    progression: prog.chords,
    bass: bass.style,
    harmony: harmonyStyle.style,
    drums: drums.style,
    lead: { patch: motif.patch, density, rest, octave },
    motif: motifForScale(motif.canonical, mode.scale),
    bars,
    seed: seedHex.slice(0, 16),
  }

  const card: [string, string][] = [
    ['key', `${keyName} ${mode.label}`],
    ['tempo', `${bpm} BPM`],
    ['mood', mode.mood],
    ['progression', prog.name],
    ['motif', `${motif.noteCount} notes, ${motif.contour}`],
    ['voice', motif.voiceLabel],
    ['bass', bass.label],
    ['harmony', harmonyStyle.label],
    ['percussion', drums.label],
  ]

  return { did, schema: 'freeq.at/profile/chiptune/v1', generator: 'chiptune-v1', seedHex, motif, theme, card }
}

/** The bare 3–5 note calling card: what plays when this DID walks into a room.
 *  Literal canonical pitches — no key and no accompaniment to bend it. */
export async function mintStinger(did: string): Promise<Score> {
  return deriveStinger(did)
}
