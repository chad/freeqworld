import { describe, expect, it } from 'vitest'
import {
  deriveFamiliar,
  familiarNick,
  hatchDecision,
  isLegalNick,
  SPECIES,
} from './familiar'

// CONFORMANCE FIXTURES. Like avatar.ts and leitmotif.ts, this derivation is
// frozen: a familiar's species and name are its identity, and changing the
// algorithm silently re-homes everybody's pet. If a change here fails these
// tests, the change is wrong — bump to familiar-v2 instead.
const FIXTURES = [
  { did: 'did:plc:4qsyxmnsblo4luuycm3572bq', species: 'crow', name: 'bilir', nick: 'crow-bilir' },
  { did: 'did:key:z6MkmrGtLPhLoS8jNfyJZqmKFSCJZsqfFJb4Mb8FoBv785KH', species: 'snail', name: 'vothor', nick: 'snail-vothor' },
  { did: 'did:web:example.com', species: 'crow', name: 'lirno', nick: 'crow-lirno' },
] as const

describe('familiar derivation (frozen)', () => {
  for (const f of FIXTURES) {
    it(`is stable for ${f.did.slice(0, 24)}…`, async () => {
      const fam = await deriveFamiliar(f.did)
      expect(fam.species).toBe(f.species)
      expect(fam.name).toBe(f.name)
      expect(familiarNick(fam)).toBe(f.nick)
    })
  }

  it('derives the same familiar every time', async () => {
    const a = await deriveFamiliar('did:plc:abc')
    const b = await deriveFamiliar('did:plc:abc')
    expect(a).toEqual(b)
  })

  it('gives different owners different familiars', async () => {
    const seen = new Set<string>()
    for (let i = 0; i < 40; i++) {
      const f = await deriveFamiliar(`did:plc:owner${i}`)
      seen.add(`${f.species}-${f.name}`)
    }
    // 40 owners should not collide into a handful of pets
    expect(seen.size).toBeGreaterThan(35)
  })

  it('only ever uses a known species, and a colour', async () => {
    for (let i = 0; i < 30; i++) {
      const f = await deriveFamiliar(`did:plc:s${i}`)
      expect(SPECIES).toContain(f.species)
      expect(f.colour).toMatch(/^#[0-9a-f]{6}$/)
      expect(f.glow).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  it('is a pronounceable, IRC-legal nick', async () => {
    for (let i = 0; i < 40; i++) {
      const f = await deriveFamiliar(`did:plc:n${i}`)
      const nick = familiarNick(f)
      expect(isLegalNick(nick), `${nick} is not a legal nick`).toBe(true)
      // no three consonants in a row: that is the difference between "bilir"
      // and something nobody can say
      expect(f.name, `${f.name} is a mouthful`).not.toMatch(/[bcdfgkl-npr-tv]{3}/)
    }
  })

  it('suffixes only the wire nick when one is taken', async () => {
    const f = await deriveFamiliar('did:plc:abc')
    expect(familiarNick(f, 2)).toBe(`${familiarNick(f)}-2`)
    expect(isLegalNick(familiarNick(f, 2))).toBe(true)
    expect(f.name).not.toContain('-') // the derived name is untouched
  })
})

describe('hatch decision', () => {
  const base = { level: 12, required: 12, xp: 2050, nextAt: 2600, existing: null }

  it('allows a hatch at the promised level', () => {
    expect(hatchDecision(base)).toEqual({ ok: true })
  })

  it('refuses below the level and says how short they are', () => {
    const d = hatchDecision({ ...base, level: 10, xp: 1300, nextAt: 1600 })
    expect(d.ok).toBe(false)
    if (d.ok) return
    expect(d.reason).toBe('too-low')
    if (d.reason !== 'too-low') return
    expect(d.short).toBe(300)
    expect(d.level).toBe(10)
    expect(d.required).toBe(12)
  })

  it('refuses a second familiar, naming the first', () => {
    const d = hatchDecision({ ...base, existing: { name: 'crow-bilir', ts: 1 } })
    expect(d.ok).toBe(false)
    if (d.ok || d.reason !== 'already') return
    expect(d.name).toBe('crow-bilir')
  })

  it('an existing familiar beats a level check, so a demotion cannot orphan a pet', () => {
    const d = hatchDecision({ ...base, level: 1, xp: 0, existing: { name: 'cat-reto', ts: 1 } })
    expect(d.ok).toBe(false)
    if (d.ok) return
    expect(d.reason).toBe('already')
  })
})
