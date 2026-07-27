import { describe as suite, expect, it } from 'vitest'
import { checkable, describe, type FaceState } from './verify'

const base: FaceState = {
  did: 'did:plc:4qsyxmnsblo4luuycm3572bq',
  handle: 'chadfowler.com',
  avatar_cid: null,
  avatar_size: null,
  source: 'https://puffball.us-east.host.bsky.network/xrpc',
  expected: {
    explorer: 'bafkreido7xelo43nx6vttlivw5nnolqhenhfafyk6oy6n7gohh4joezfnm',
    portrait: 'bafkreidvx7rltkfcukgxj27j52fr7fvc3tf5f2qpw25mvmwoqbhnbuybgy',
  },
  wearing: null,
}

suite('telling someone where they stand, before they have to ask', () => {
  it('only speaks for an identity that has a profile to check', () => {
    expect(checkable('did:plc:4qsyxmnsblo4luuycm3572bq')).toBe(true)
    expect(checkable('did:web:example.com')).toBe(true)
    // a guest browser key has no Bluesky profile; saying anything would be noise
    expect(checkable('did:key:z6MkThrowaway000000')).toBe(false)
  })

  it('confirms a verified face, and says who can check it', () => {
    const d = describe({ ...base, wearing: 'explorer', avatar_cid: base.expected.explorer!, avatar_size: 8287 })
    expect(d.verified).toBe(true)
    expect(d.action).toBe(false)
    expect(d.text).toMatch(/verified/)
    expect(d.text).toMatch(/bafkreido7xelo/) // the actual evidence, not a badge
    expect(d.text).toMatch(/nobody has to take your word/)
  })

  it("names the mismatch instead of just saying no — the real case that cost an afternoon", () => {
    // exactly what the live record said: a 176kB canvas-encoded PNG
    const d = describe({ ...base, avatar_cid: 'bafkreibpd35w6qtfp6h6r4dsfahg5rc5zhl723b5yngkkaqfpk2v6o4z4i', avatar_size: 176445 })
    expect(d.verified).toBe(false)
    expect(d.action).toBe(true)
    expect(d.text).toMatch(/172kB/) // the size is the tell: ours is 8kB
    expect(d.text).toMatch(/hash of the bytes/)
  })

  it('handles having no avatar at all', () => {
    const d = describe(base)
    expect(d.verified).toBe(false)
    expect(d.text).toMatch(/no Bluesky avatar/)
  })

  it('never claims verification it has not done', () => {
    for (const s of [base, { ...base, avatar_cid: 'bafkreiX', avatar_size: 1 }]) {
      expect(describe(s).text).not.toMatch(/verified/)
    }
  })
})
