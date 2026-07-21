import { beforeEach, describe, expect, it } from 'vitest'
import { decodeTouchTag, encodeTouchTag, signTouch, SparkBook, titleFor, verifyTouch } from './sparks'
import { didFromPublicKey, generateKeypair } from '../../shared/src/signing'

// minimal localStorage shim for node
const store = new Map<string, string>()
beforeEach(() => {
  store.clear()
  ;(globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  }
})

describe('touch autographs (signed first-contact)', () => {
  it('signs and verifies a touch between two DIDs', () => {
    const a = generateKeypair()
    const didA = didFromPublicKey(a.publicKey)
    const didB = 'did:key:z6MkexampleTargetX'
    const ts = 1_800_000_000_000
    const sig = signTouch(didA, didB, ts, a.secretKey)
    expect(verifyTouch(didA, didB, ts, sig)).toBe(true)
    expect(verifyTouch(didA, 'did:key:z6MkSomeoneElse', ts, sig)).toBe(false)
    expect(verifyTouch(didA, didB, ts + 1, sig)).toBe(false)
  })

  it('round-trips the wire tag and rejects garbage', () => {
    const enc = encodeTouchTag('somenick', 1_800_000_000_000, 'zSigZig')
    const dec = decodeTouchTag(enc)
    expect(dec).toEqual({ toNick: 'somenick', ts: 1_800_000_000_000, sig: 'zSigZig', signerDid: undefined })
    expect(decodeTouchTag('nonsense')).toBeNull()
    expect(decodeTouchTag('')).toBeNull()
  })

  it('carries an explicit signer did for OAuth identities (device key signs)', () => {
    const enc = encodeTouchTag('somenick', 42, 'zSig', 'did:key:z6MkDevice')
    expect(decodeTouchTag(enc)).toEqual({ toNick: 'somenick', ts: 42, sig: 'zSig', signerDid: 'did:key:z6MkDevice' })
  })
})

describe('SparkBook', () => {
  it('collects each unique DID once — the count is unique players touched', () => {
    const book = new SparkBook()
    expect(book.count()).toBe(0)
    expect(book.add({ did: 'did:a', nick: 'ada', name: 'ada', channel: '#freeq', ts: 1, verified: true })).toBe(true)
    expect(book.add({ did: 'did:a', nick: 'ada', name: 'ada', channel: '#dev', ts: 2, verified: true })).toBe(false)
    expect(book.add({ did: 'did:b', nick: 'bob', name: 'bob', channel: '#freeq', ts: 3, verified: false })).toBe(true)
    expect(book.count()).toBe(2)
    expect(book.has('did:a')).toBe(true)
  })

  it('persists across instances (localStorage)', () => {
    const book = new SparkBook()
    book.add({ did: 'did:a', nick: 'ada', name: 'ada', channel: '#freeq', ts: 1, verified: true })
    const reloaded = new SparkBook()
    expect(reloaded.count()).toBe(1)
    expect(reloaded.entries()[0]!.nick).toBe('ada')
  })

  it('upgrades an unsigned brush to a verified autograph without double counting', () => {
    const book = new SparkBook()
    book.add({ did: 'did:a', nick: 'ada', name: 'ada', channel: '#freeq', ts: 1, verified: false })
    book.add({ did: 'did:a', nick: 'ada', name: 'ada', channel: '#freeq', ts: 2, verified: true })
    expect(book.count()).toBe(1)
    expect(book.entries()[0]!.verified).toBe(true)
  })

  it('never collects yourself', () => {
    const book = new SparkBook()
    expect(book.add({ did: 'did:me', nick: 'me', name: 'me', channel: '#x', ts: 1, verified: false, selfDid: 'did:me' })).toBe(false)
    expect(book.count()).toBe(0)
  })
})

describe('titles', () => {
  it('progresses with unique contacts', () => {
    expect(titleFor(0)).toBe('Stranger')
    expect(titleFor(1)).toBe('First Contact')
    expect(titleFor(5)).toBe('Acquainted')
    expect(titleFor(12)).toBe('Regular')
    expect(titleFor(25)).toBe('Connector')
    expect(titleFor(90)).toBe('Mayor of Freeq')
  })
})
