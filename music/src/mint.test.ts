import { describe, expect, it } from 'vitest'
import { contourLabel, deriveMotif, motifSeed } from './motif.ts'
import { deriveLeitmotif } from '../../shared/src/leitmotif.ts'
import { mintChiptune, mintStinger, tuneSeed } from './mint.ts'
import { compose } from './compose.ts'
import { renderScore } from './synth.ts'

const DID = 'did:plc:z72i7hdynmk6r22z27h6tvur'
const OTHER = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz'

describe('leitmotif (spec §11.5)', () => {
  it('gives a DID the same three-to-five notes forever', async () => {
    const a = await deriveMotif(DID)
    const b = await deriveMotif(DID)
    expect(a).toEqual(b)
    expect(a.degrees.length).toBeGreaterThanOrEqual(3)
    expect(a.degrees.length).toBeLessThanOrEqual(5)
    expect(a.rhythm.length).toBe(a.degrees.length)
    expect(a.contour).toBe(contourLabel(a.canonical.interval_contour))
  })

  // The whole point of the adapter: one identity, ONE official motif.
  it('is the canonical conformance-locked motif, not a second derivation', async () => {
    const canon = await deriveLeitmotif(DID)
    const m = await deriveMotif(DID)
    expect(m.notes).toEqual(canon.notes)
    expect(m.canonical).toEqual(canon)
    expect(m.noteCount).toBe(canon.notes.length)
  })

  it('keeps the canonical contour when translated into a key', async () => {
    const canon = await deriveLeitmotif(DID)
    for (const scale of ['major', 'minor', 'dorian', 'minorPentatonic'] as const) {
      const m = await deriveMotif(DID, scale)
      // direction of every interval survives the snap to scale degrees
      const dirs = m.degrees.slice(1).map((d, i) => Math.sign(d - m.degrees[i]!))
      expect(dirs).toEqual(canon.interval_contour.map((c) => Math.sign(c)))
    }
  })

  it('gives different identities different motifs', async () => {
    const a = await deriveMotif(DID)
    const b = await deriveMotif(OTHER)
    expect(a.seedHex).not.toEqual(b.seedHex)
    expect([a.degrees, a.rhythm, a.patch]).not.toEqual([b.degrees, b.rhythm, b.patch])
  })

  it('uses its own HKDF domain, distinct from the tune seed', async () => {
    expect(await motifSeed(DID)).not.toEqual(await tuneSeed(DID))
  })

  it('keeps the motif short enough not to annoy', async () => {
    const m = await deriveMotif(DID)
    const sixteenths = m.rhythm.reduce((a, b) => a + b, 0)
    expect(sixteenths).toBeLessThanOrEqual(24) // under a bar and a half
  })
})

describe('minted chiptune', () => {
  it('mints the same track for the same DID', async () => {
    const a = await mintChiptune(DID)
    const b = await mintChiptune(DID)
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b))
  })

  it('mints different tracks for different DIDs', async () => {
    const a = await mintChiptune(DID)
    const b = await mintChiptune(OTHER)
    expect(a.seedHex).not.toEqual(b.seedHex)
    expect(JSON.stringify(compose(a.theme).notes)).not.toEqual(JSON.stringify(compose(b.theme).notes))
  })

  it('reveals a human-readable card', async () => {
    const { card } = await mintChiptune(DID)
    expect(card.map(([k]) => k)).toEqual([
      'key', 'tempo', 'mood', 'progression', 'motif', 'voice', 'bass', 'harmony', 'percussion',
    ])
    for (const [, v] of card) expect(typeof v).toBe('string')
  })

  it('plants the identity motif at the head of the melody', async () => {
    const { motif, theme } = await mintChiptune(DID)
    expect(theme.motif?.degrees).toEqual(motif.degrees)
    expect(theme.lead.patch).toBe(motif.patch)
  })

  it('renders to audible audio', async () => {
    const { theme } = await mintChiptune(DID, 8)
    const audio = renderScore(compose(theme), { sampleRate: 22050 })
    expect(audio.left.length).toBeGreaterThan(1000)
    let peak = 0
    for (const v of audio.left) peak = Math.max(peak, Math.abs(v))
    expect(peak).toBeGreaterThan(0.2)
  })

  it('mints an arrival stinger from the literal canonical pitches', async () => {
    const canon = await deriveLeitmotif(DID)
    const score = await mintStinger(DID)
    const lead = score.notes.filter((n) => n.ch === 'pulse1')
    expect(lead.map((n) => n.midi)).toEqual(canon.notes) // untransposed, unsnapped
    expect(score.length).toBeLessThanOrEqual(4 * 192) // stays brief
  })

  it('spreads a population of DIDs across many distinct tunes', async () => {
    const seen = new Set<string>()
    for (let i = 0; i < 40; i++) {
      const m = await mintChiptune(`did:plc:test${i}`)
      seen.add(m.card.map(([, v]) => v).join('|'))
    }
    expect(seen.size).toBeGreaterThan(35) // essentially no collisions
  })
})

describe('minted tunes stay musical, not just unique', () => {
  it('rarely leaves someone without percussion, and never without a pulse', async () => {
    let drumless = 0
    let inert = 0
    for (let i = 0; i < 300; i++) {
      const { theme } = await mintChiptune(`did:plc:groove${i}`)
      if (theme.drums === 'none') {
        drumless++
        // a drumless tune must still have a moving inner voice
        if (theme.harmony === 'pad' || theme.harmony === 'chord' || theme.harmony === 'none') inert++
      }
    }
    expect(drumless / 300).toBeLessThan(0.1)
    expect(inert).toBe(0)
  })

  it('matches the groove to the tempo', async () => {
    let fast = 0
    let fastAndSparse = 0
    let slow = 0
    let slowAndBusy = 0
    for (let i = 0; i < 400; i++) {
      const { theme } = await mintChiptune(`did:plc:tempo${i}`)
      if (theme.bpm >= 132) {
        fast++
        if (theme.bass === 'sparse') fastAndSparse++ // a drone can work, but rarely
      }
      if (theme.bpm <= 92) {
        slow++
        if (theme.drums === 'breaks') slowAndBusy++
      }
    }
    expect(fastAndSparse / fast).toBeLessThan(0.12)
    expect(slowAndBusy / slow).toBeLessThan(0.12)
  })
})
