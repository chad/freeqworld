import { describe, expect, it } from 'vitest'
import { deriveAvatar } from '../../shared/src/avatar'
import { mintChiptune } from '../../music/src/mint.ts'
import { motifForScale } from '../../music/src/motif.ts'
import { deriveLeitmotif } from '../../shared/src/leitmotif'
import { themeSummary } from './theme'

// The face and the theme tune are two renderings of one identity: same DID,
// same HKDF family, separate info/salt domains (spec §8, §11.5).
describe('FreeqWorld ID / theme tune', () => {
  const DID = 'did:plc:z72i7hdynmk6r22z27h6tvur'

  it('mints the same tune for a DID every time', async () => {
    const a = await mintChiptune(DID)
    const b = await mintChiptune(DID)
    expect(a.seedHex).toEqual(b.seedHex)
    expect(a.card).toEqual(b.card)
  })

  it('derives from the DID, never from the face', async () => {
    const avatar = await deriveAvatar(DID)
    const tune = await mintChiptune(DID)
    // the avatar reserves a slot pointing at the leitmotif derivation…
    expect(avatar.traits.musical_leitmotif).toBe('motif-v1')
    // …and the two seeds are independent domains of the same identity
    expect(tune.seedHex).not.toEqual(avatar.canonical_seed_hex)
    expect(tune.motif.seedHex).not.toEqual(avatar.canonical_seed_hex)
  })

  it('summarises the tune for the reveal card, next to the face traits', async () => {
    const summary = themeSummary(await mintChiptune(DID))
    expect(summary.map(([k]) => k)).toEqual(['key', 'tempo', 'motif', 'voice', 'percussion'])
    for (const [, v] of summary) expect(typeof v).toBe('string')
  })

  it('gives different identities different tunes', async () => {
    const a = await mintChiptune(DID)
    const b = await mintChiptune('did:plc:ewvi7nxzyoun6zhxrhs64oiz')
    expect(a.seedHex).not.toEqual(b.seedHex)
  })

  it('plants the one canonical motif at the head of the tune', async () => {
    const { theme, motif } = await mintChiptune(DID)
    // the motif in the melody is the conformance-locked leitmotif, translated
    // into the minted key — same notes, same contour, one identity
    const canonical = await deriveLeitmotif(DID)
    expect(motif.canonical).toEqual(canonical)
    expect(theme.motif?.degrees).toEqual(motifForScale(canonical, theme.scale).degrees)
    expect(theme.lead.patch).toBe(motif.patch)
  })
})
