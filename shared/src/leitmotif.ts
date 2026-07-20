// Deterministic personal leitmotifs (spec §11.5).
// motif_seed = HKDF-SHA256(ikm=DID, salt="freeq-world-motif", info="motif-v1")

import { hkdfSha256, pick, seededPrng } from './hkdf'

export interface Leitmotif {
  did: string
  /** midi note numbers, 3–5 of them */
  notes: number[]
  /** fixed interval contour (semitone deltas between successive notes) */
  interval_contour: number[]
  /** fixed rhythmic cell — beat lengths per note */
  rhythmic_cell: number[]
  instrument: 'pulse' | 'triangle' | 'fmbell' | 'square25'
}

// pentatonic-ish interval moves keep any motif consonant
const MOVES = [2, 3, 4, 5, 7, -2, -3, -4, -5] as const
const RHYTHMS: readonly number[][] = [
  [0.5, 0.5, 1],
  [0.5, 0.5, 0.5, 1.5],
  [1, 0.5, 0.5, 1, 1],
  [0.5, 1, 0.5],
  [1, 1, 0.5, 0.5, 2],
]

export async function deriveLeitmotif(did: string): Promise<Leitmotif> {
  const seed = await hkdfSha256(did, 'freeq-world-motif', 'motif-v1', 32)
  const rng = seededPrng(seed)
  const count = 3 + Math.floor(rng() * 3) // 3..5
  const root = 60 + Math.floor(rng() * 12) // C4..B4
  const notes = [root]
  const contour: number[] = []
  while (notes.length < count) {
    const move = pick(rng, MOVES)
    let next = notes[notes.length - 1]! + move
    if (next < 48) next += 12
    if (next > 96) next -= 12
    contour.push(next - notes[notes.length - 1]!)
    notes.push(next)
  }
  const rhythm = RHYTHMS.filter((r) => r.length === count)
  const rhythmic_cell = rhythm.length ? pick(rng, rhythm) : notes.map(() => 1)
  const instrument = pick(rng, ['pulse', 'triangle', 'fmbell', 'square25'] as const)
  return { did, notes, interval_contour: contour, rhythmic_cell: [...rhythmic_cell], instrument }
}
