import { describe, expect, it } from 'vitest'
import { deriveAvatar } from '../../shared/src/avatar'
import { traitSummary } from './render'

// The PFP is a pure function of the DID: same identity → same face, forever.
// (Canvas compositing is exercised by the e2e/headless path; here we lock the
// derivation + the summary card that the reveal screen shows.)
describe('FreeqWorld ID / PFP', () => {
  const DID = 'did:plc:z72i7hdynmk6r22z27h6tvur'

  it('derives the same traits for a DID every time', async () => {
    const a = await deriveAvatar(DID)
    const b = await deriveAvatar(DID)
    expect(a.traits).toEqual(b.traits)
    expect(a.canonical_seed_hex).toEqual(b.canonical_seed_hex)
  })

  it('summarises the human-readable traits for the reveal card', async () => {
    const av = await deriveAvatar(DID)
    const summary = traitSummary(av)
    const keys = summary.map(([k]) => k)
    expect(keys).toEqual(['silhouette', 'hair', 'eyes', 'accessory', 'walk', 'arrival'])
    for (const [, v] of summary) expect(typeof v).toBe('string')
  })

  it('gives different identities different faces', async () => {
    const a = await deriveAvatar('did:key:z6MkmZEQrXQ6aaaaaaaaaaaaaaaaaaaaaaaaaaaaaSCDSG9')
    const b = await deriveAvatar('did:key:z6Mkdifferentdifferentdifferentdifferentdiff')
    expect(a.canonical_seed_hex).not.toEqual(b.canonical_seed_hex)
  })
})
