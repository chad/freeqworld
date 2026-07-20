import { describe, expect, it } from 'vitest'
import { deriveLeitmotif } from './leitmotif'

const DID = 'did:plc:ewvi7nmzuoqusbcablsm7c4h'

describe('deriveLeitmotif (spec 11.5)', () => {
  it('uses HKDF with salt freeq-world-motif / info motif-v1 and yields 3-5 notes', async () => {
    const m = await deriveLeitmotif(DID)
    expect(m.notes.length).toBeGreaterThanOrEqual(3)
    expect(m.notes.length).toBeLessThanOrEqual(5)
  })

  it('notes are playable midi numbers in a reasonable register', async () => {
    const m = await deriveLeitmotif(DID)
    for (const n of m.notes) {
      expect(n).toBeGreaterThanOrEqual(48)
      expect(n).toBeLessThanOrEqual(96)
    }
  })

  it('is deterministic per DID', async () => {
    const a = await deriveLeitmotif(DID)
    const b = await deriveLeitmotif(DID)
    expect(a).toEqual(b)
  })

  it('has fixed rhythmic cell and instrument selection', async () => {
    const m = await deriveLeitmotif(DID)
    expect(m.rhythmic_cell.length).toBe(m.notes.length)
    expect(['pulse', 'triangle', 'fmbell', 'square25']).toContain(m.instrument)
  })

  it('differs between DIDs', async () => {
    const a = await deriveLeitmotif(DID)
    const b = await deriveLeitmotif('did:plc:other')
    expect(JSON.stringify(a)).not.toEqual(JSON.stringify(b))
  })
})
