// Deterministic randomness. Shares the HKDF + sfc32 primitives with the avatar
// system (fimp/shared/src/hkdf.ts) so a DID's motif and a DID's face come from
// the same family of derivations — different salt/info domains, same maths.

export { hkdfSha256, pick, seededPrng } from '../../shared/src/hkdf.ts'
import { seededPrng } from '../../shared/src/hkdf.ts'

export type Rng = () => number

/** xmur3 string hash -> 16 seed bytes -> sfc32. Synchronous, for theme seeds. */
export function rngFromString(str: string): Rng {
  let h = 1779033703 ^ str.length
  const words: number[] = []
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  for (let i = 0; i < 4; i++) {
    h = Math.imul(h ^ (h >>> 16), 2246822507)
    h = Math.imul(h ^ (h >>> 13), 3266489909)
    words.push((h ^= h >>> 16) >>> 0)
  }
  const bytes = new Uint8Array(16)
  const dv = new DataView(bytes.buffer)
  words.forEach((w, i) => dv.setUint32(i * 4, w >>> 0, true))
  return seededPrng(bytes)
}

export function randInt(rng: Rng, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1))
}

export function chance(rng: Rng, p: number): boolean {
  return rng() < p
}

/** Weighted pick: `items` parallel to `weights`. */
export function weighted<T>(rng: Rng, items: readonly T[], weights: readonly number[]): T {
  const total = weights.reduce((a, b) => a + b, 0)
  let r = rng() * total
  for (let i = 0; i < items.length; i++) {
    r -= weights[i]!
    if (r <= 0) return items[i]!
  }
  return items[items.length - 1]!
}
