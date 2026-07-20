import { describe, expect, it } from 'vitest'
import { canonicalJson, didFromPublicKey, generateKeypair, signEvent, verifyEvent } from './signing'

describe('did:key identity (spec 13/24.3)', () => {
  it('encodes ed25519 public keys as did:key with multibase z prefix', () => {
    const kp = generateKeypair()
    const did = didFromPublicKey(kp.publicKey)
    expect(did.startsWith('did:key:z6Mk')).toBe(true)
  })

  it('is stable for the same key and distinct for different keys', () => {
    const a = generateKeypair()
    const b = generateKeypair()
    expect(didFromPublicKey(a.publicKey)).toEqual(didFromPublicKey(a.publicKey))
    expect(didFromPublicKey(a.publicKey)).not.toEqual(didFromPublicKey(b.publicKey))
  })
})

describe('canonicalJson', () => {
  it('sorts keys so logically equal objects serialize identically', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toEqual(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }))
  })
})

describe('signed events (spec 10.2, 4.1)', () => {
  it('signs and verifies an event payload', () => {
    const kp = generateKeypair()
    const event = { id: 'm1', channel: '#lobby', sender: didFromPublicKey(kp.publicKey), content: 'hi', ts: 123 }
    const sig = signEvent(event, kp.secretKey)
    expect(verifyEvent(event, sig, kp.publicKey)).toBe(true)
  })

  it('rejects tampered payloads', () => {
    const kp = generateKeypair()
    const event = { id: 'm1', channel: '#lobby', sender: didFromPublicKey(kp.publicKey), content: 'hi', ts: 123 }
    const sig = signEvent(event, kp.secretKey)
    expect(verifyEvent({ ...event, content: 'evil' }, sig, kp.publicKey)).toBe(false)
  })

  it('rejects signatures from a different key', () => {
    const kp = generateKeypair()
    const other = generateKeypair()
    const event = { id: 'm1', channel: '#lobby', sender: 'x', content: 'hi', ts: 123 }
    const sig = signEvent(event, kp.secretKey)
    expect(verifyEvent(event, sig, other.publicKey)).toBe(false)
  })

  it('recovers the verification key from the sender did itself', () => {
    const kp = generateKeypair()
    const did = didFromPublicKey(kp.publicKey)
    const event = { id: 'm2', channel: '#lobby', sender: did, content: 'yo', ts: 456 }
    const sig = signEvent(event, kp.secretKey)
    // verifyEvent accepts a did string in place of raw key bytes
    expect(verifyEvent(event, sig, did)).toBe(true)
  })
})
