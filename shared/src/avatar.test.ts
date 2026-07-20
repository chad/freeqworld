import { describe, expect, it } from 'vitest'
import {
  canonicalSeed,
  deriveAvatar,
  renderSpritePixels,
  spriteHash,
  TRAIT_KEYS,
} from './avatar'

const DID_A = 'did:plc:ewvi7nmzuoqusbcablsm7c4h'
const DID_B = 'did:plc:z72i7hdynmk6r22z27h6tvur'

describe('canonicalSeed (spec 8.2)', () => {
  it('derives HKDF-SHA256 seed from DID with fixed salt/info', async () => {
    const seed = await canonicalSeed(DID_A)
    expect(seed).toBeInstanceOf(Uint8Array)
    expect(seed.length).toBe(32)
  })

  it('is deterministic: same DID always yields identical bytes', async () => {
    const a = await canonicalSeed(DID_A)
    const b = await canonicalSeed(DID_A)
    expect(Buffer.from(a).toString('hex')).toEqual(Buffer.from(b).toString('hex'))
  })

  it('different DIDs yield different seeds', async () => {
    const a = await canonicalSeed(DID_A)
    const b = await canonicalSeed(DID_B)
    expect(Buffer.from(a).toString('hex')).not.toEqual(Buffer.from(b).toString('hex'))
  })

  it('matches the reference vector (conformance fixture, spec 31)', async () => {
    // HKDF-SHA256(ikm=UTF8(did), salt=UTF8("freeq-world-avatar"), info=UTF8("avatar-v1"), len=32)
    // computed with node:crypto hkdfSync as an independent reference
    const { hkdfSync } = await import('node:crypto')
    const ref = Buffer.from(
      hkdfSync('sha256', Buffer.from(DID_A, 'utf8'), Buffer.from('freeq-world-avatar', 'utf8'), Buffer.from('avatar-v1', 'utf8'), 32),
    )
    const seed = await canonicalSeed(DID_A)
    expect(Buffer.from(seed).toString('hex')).toEqual(ref.toString('hex'))
  })
})

describe('deriveAvatar traits (spec 8.3)', () => {
  it('produces all sixteen required trait keys', async () => {
    const av = await deriveAvatar(DID_A)
    for (const key of TRAIT_KEYS) {
      expect(av.traits[key], `missing trait ${key}`).toBeDefined()
    }
    expect(TRAIT_KEYS).toContain('body_silhouette')
    expect(TRAIT_KEYS).toContain('musical_leitmotif')
    expect(TRAIT_KEYS.length).toBe(16)
  })

  it('is deterministic across calls', async () => {
    const a = await deriveAvatar(DID_A)
    const b = await deriveAvatar(DID_A)
    expect(a.traits).toEqual(b.traits)
  })

  it('records generator name+version (spec 8.2/8.6)', async () => {
    const av = await deriveAvatar(DID_A)
    expect(av.base_generator).toBe('avatar-v1')
    expect(av.did).toBe(DID_A)
    expect(av.schema).toBe('freeq.at/profile/avatar/v1')
  })

  it('produces diverse silhouettes across a population (spec 30.3)', async () => {
    const dids = Array.from({ length: 64 }, (_, i) => `did:plc:test${i}`)
    const silhouettes = new Set<string>()
    for (const did of dids) {
      const av = await deriveAvatar(did)
      silhouettes.add(String(av.traits.body_silhouette))
    }
    expect(silhouettes.size).toBeGreaterThanOrEqual(4)
  })
})

describe('sprite rendering (spec 12.2)', () => {
  it('renders a 16x24 pixel grid with four facings', async () => {
    const av = await deriveAvatar(DID_A)
    for (const facing of ['south', 'north', 'east', 'west'] as const) {
      const px = renderSpritePixels(av, facing, 0)
      expect(px.width).toBe(16)
      expect(px.height).toBe(24)
      expect(px.pixels.length).toBe(16 * 24)
    }
  })

  it('sprite is deterministic: identical inputs produce identical hash (spec 31)', async () => {
    const av1 = await deriveAvatar(DID_A)
    const av2 = await deriveAvatar(DID_A)
    expect(await spriteHash(av1)).toEqual(await spriteHash(av2))
  })

  it('different DIDs produce different sprites', async () => {
    const a = await deriveAvatar(DID_A)
    const b = await deriveAvatar(DID_B)
    expect(await spriteHash(a)).not.toEqual(await spriteHash(b))
  })

  it('walk frames differ from idle frame (small expressive animation, spec 4.4)', async () => {
    const av = await deriveAvatar(DID_A)
    const idle = renderSpritePixels(av, 'south', 0)
    const step = renderSpritePixels(av, 'south', 1)
    expect(idle.pixels).not.toEqual(step.pixels)
  })
})
