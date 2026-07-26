// Personal leitmotifs (spec §11.5) — an ADAPTER, not a second generator.
//
// The canonical derivation already lives in `shared/src/leitmotif.ts` and is
// locked by the public conformance fixtures (spec §31, fixtures/avatar-
// conformance.json). It shares the exact HKDF domain this engine would have
// used —  HKDF(DID, salt="freeq-world-motif", info="motif-v1") — so inventing
// our own reading of that seed would give one identity two different "official"
// motifs: one in the world client, another here. Instead we take the canonical
// motif (MIDI notes + beat cell + instrument) and translate it into the shapes
// the composer speaks (scale degrees + 16th units + a patch name).

import { deriveLeitmotif, type Leitmotif as CanonicalMotif } from '../../shared/src/leitmotif.ts'
import type { Motif } from './compose.ts'
import { TPQ, type Note, type Score } from './score.ts'
import { degreeToMidi, SCALES, type ScaleName } from './theory.ts'
import { hkdfSha256 } from './seed.ts'

export type { CanonicalMotif }

/** How the canonical instrument choice maps onto this engine's voices. */
export const MOTIF_VOICES: Record<CanonicalMotif['instrument'], { patch: string; label: string }> = {
  pulse: { patch: 'lead.pulse50', label: 'round square' },
  square25: { patch: 'lead.pulse25', label: 'bright pulse' },
  triangle: { patch: 'lead.tri', label: 'soft triangle' },
  fmbell: { patch: 'lead.bell', label: 'fm bell' },
}

export type ContourLabel = 'rising' | 'falling' | 'arch' | 'valley' | 'zigzag' | 'leaping' | 'level'

/** A human-readable name for the fixed interval contour, for the reveal card.
 *  Purely descriptive — it never feeds back into the music. */
export function contourLabel(contour: readonly number[]): ContourLabel {
  if (contour.length === 0) return 'level'
  const ups = contour.filter((c) => c > 0).length
  const downs = contour.filter((c) => c < 0).length
  const big = contour.filter((c) => Math.abs(c) >= 5).length
  const flips = contour.filter((c, i) => i > 0 && Math.sign(c) !== Math.sign(contour[i - 1]!)).length
  if (big >= 2) return 'leaping'
  if (downs === 0) return 'rising'
  if (ups === 0) return 'falling'
  if (flips >= 2) return 'zigzag'
  const peak = contour.findIndex((c) => c < 0)
  return peak > 0 ? 'arch' : 'valley'
}

export interface Leitmotif extends Motif {
  did: string
  seedHex: string
  /** the canonical form, exactly as the conformance fixtures pin it */
  canonical: CanonicalMotif
  /** absolute MIDI notes from the canonical motif */
  notes: number[]
  contour: ContourLabel
  voiceLabel: string
  noteCount: number
}

export async function motifSeed(did: string): Promise<Uint8Array> {
  return hkdfSha256(did, 'freeq-world-motif', 'motif-v1', 32)
}

/** Nearest note of `scale` (as a degree) to an absolute MIDI pitch. */
function nearestDegree(root: number, scale: readonly number[], midi: number): number {
  let best = 0
  let bestDist = Infinity
  for (let d = -14; d <= 14; d++) {
    const dist = Math.abs(degreeToMidi(root, scale, d) - midi)
    if (dist < bestDist) {
      bestDist = dist
      best = d
    }
  }
  return best
}

/** Canonical motif -> composer motif in a given mode. The motif is transposed
 *  to start on the tonic and each interval snapped to the nearest scale degree,
 *  which keeps the contour recognisable while staying inside the key. */
export function motifForScale(canon: CanonicalMotif, scaleName: ScaleName): Motif {
  const scale = SCALES[scaleName]
  const root = canon.notes[0] ?? 60
  const degrees = canon.notes.map((n) => nearestDegree(root, scale, root + (n - root)))
  // octave-fold the whole figure (contour preserved exactly) into lead range
  const shift = Math.max(...degrees) > 8 ? -7 : Math.min(...degrees) < -4 ? 7 : 0
  const rhythm = canon.rhythmic_cell.map((beats) => Math.max(1, Math.round(beats * 4)))
  while (rhythm.length < degrees.length) rhythm.push(rhythm[rhythm.length - 1] ?? 4)
  return {
    degrees: degrees.map((d) => d + shift),
    rhythm: rhythm.slice(0, degrees.length),
    patch: MOTIF_VOICES[canon.instrument].patch,
  }
}

/** DID -> leitmotif, described and ready for the composer. */
export async function deriveMotif(did: string, scale: ScaleName = 'majorPentatonic'): Promise<Leitmotif> {
  const canonical = await deriveLeitmotif(did)
  const seed = await motifSeed(did)
  const seedHex = [...seed].map((b) => b.toString(16).padStart(2, '0')).join('')
  const voice = MOTIF_VOICES[canonical.instrument]
  return {
    ...motifForScale(canonical, scale),
    did,
    seedHex,
    canonical,
    notes: canonical.notes,
    contour: contourLabel(canonical.interval_contour),
    voiceLabel: voice.label,
    noteCount: canonical.notes.length,
  }
}

/** The arrival stinger plays the canonical motif at its literal pitches —
 *  no key, no accompaniment, nothing to bend it out of shape. */
export function stingerScore(canon: CanonicalMotif, bpm = 132): Score {
  const patch = MOTIF_VOICES[canon.instrument].patch
  const notes: Note[] = []
  let t = 0
  canon.notes.forEach((midi, i) => {
    const beats = canon.rhythmic_cell[i] ?? 1
    const dur = Math.round(beats * TPQ)
    notes.push({ ch: 'pulse1', patch, t, dur: Math.max(TPQ / 4, dur - 4), midi, vel: i === 0 ? 1 : 0.9 })
    // a quiet triangle root underneath gives the figure a floor
    if (i === 0) notes.push({ ch: 'triangle', patch: 'bass.tri', t, dur: dur * 2, midi: midi - 24, vel: 0.5 })
    t += dur
  })
  return {
    id: `stinger:${canon.did}`,
    name: 'arrival stinger',
    bpm,
    meter: [4, 4],
    length: t,
    notes,
  }
}

export async function deriveStinger(did: string): Promise<Score> {
  return stingerScore(await deriveLeitmotif(did))
}
