import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { deriveAvatar, spriteHash } from './avatar'
import { deriveLeitmotif } from './leitmotif'

interface Fixture {
  did: string
  avatar_version: string
  canonical_seed: string
  expected_traits: Record<string, string | number>
  sprite_hash: string
  leitmotif: { notes: number[]; rhythmic_cell: number[]; instrument: string }
}

const fixtures = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'fixtures', 'avatar-conformance.json'), 'utf8'),
) as Fixture[]

// The public conformance suite (spec §31): identical inputs must always
// produce identical seeds, traits, sprites, and motifs — across versions of
// this codebase and across independent implementations.
describe('avatar conformance fixtures', () => {
  for (const f of fixtures) {
    it(`reproduces ${f.did}`, async () => {
      const avatar = await deriveAvatar(f.did)
      expect(avatar.base_generator).toBe(f.avatar_version)
      expect(avatar.canonical_seed_hex).toBe(f.canonical_seed)
      expect(avatar.traits).toEqual(f.expected_traits)
      expect(await spriteHash(avatar)).toBe(f.sprite_hash)
      const motif = await deriveLeitmotif(f.did)
      expect(motif.notes).toEqual(f.leitmotif.notes)
      expect(motif.rhythmic_cell).toEqual(f.leitmotif.rhythmic_cell)
      expect(motif.instrument).toBe(f.leitmotif.instrument)
    })
  }

  it('has a meaningful number of fixtures', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(5)
  })
})
