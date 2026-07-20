// Ed25519 signing + did:key encoding. tweetnacl works identically in Node
// and browsers, so client-signed events verify on the server and vice versa.

import nacl from 'tweetnacl'

export interface Keypair {
  publicKey: Uint8Array
  secretKey: Uint8Array
}

export function generateKeypair(): Keypair {
  const kp = nacl.sign.keyPair()
  return { publicKey: kp.publicKey, secretKey: kp.secretKey }
}

export function keypairFromSeed(seed: Uint8Array): Keypair {
  const kp = nacl.sign.keyPair.fromSeed(seed)
  return { publicKey: kp.publicKey, secretKey: kp.secretKey }
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

export function base58btc(bytes: Uint8Array): string {
  const digits = [0]
  for (const byte of bytes) {
    let carry = byte
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i]! << 8
      digits[i] = carry % 58
      carry = (carry / 58) | 0
    }
    while (carry) {
      digits.push(carry % 58)
      carry = (carry / 58) | 0
    }
  }
  let out = ''
  for (const byte of bytes) {
    if (byte === 0) out += B58[0]
    else break
  }
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]!]
  return out
}

export function base58btcDecode(s: string): Uint8Array {
  const bytes = [0]
  for (const ch of s) {
    let carry = B58.indexOf(ch)
    if (carry < 0) throw new Error('bad base58 char')
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i]! * 58
      bytes[i] = carry & 0xff
      carry >>= 8
    }
    while (carry) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }
  for (const ch of s) {
    if (ch === B58[0]) bytes.push(0)
    else break
  }
  return new Uint8Array(bytes.reverse())
}

/** did:key for ed25519: multicodec 0xed 0x01 prefix, multibase 'z' base58btc. */
export function didFromPublicKey(publicKey: Uint8Array): string {
  const prefixed = new Uint8Array(2 + publicKey.length)
  prefixed[0] = 0xed
  prefixed[1] = 0x01
  prefixed.set(publicKey, 2)
  return `did:key:z${base58btc(prefixed)}`
}

export function publicKeyFromDid(did: string): Uint8Array {
  if (!did.startsWith('did:key:z')) throw new Error(`not a did:key: ${did}`)
  const bytes = base58btcDecode(did.slice('did:key:z'.length))
  if (bytes[0] !== 0xed || bytes[1] !== 0x01) throw new Error('not an ed25519 did:key')
  return bytes.slice(2)
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

const enc = new TextEncoder()

export function signEvent(event: object, secretKey: Uint8Array): string {
  const sig = nacl.sign.detached(enc.encode(canonicalJson(event)), secretKey)
  return base58btc(sig)
}

export function verifyEvent(event: object, signature: string, key: Uint8Array | string): boolean {
  try {
    const pub = typeof key === 'string' ? publicKeyFromDid(key) : key
    return nacl.sign.detached.verify(enc.encode(canonicalJson(event)), base58btcDecode(signature), pub)
  } catch {
    return false
  }
}
