// HKDF-SHA256 + seeded PRNG primitives shared by avatar and leitmotif
// generation. Uses WebCrypto so identical bytes come out in Node and browsers.

export async function hkdfSha256(
  ikm: string,
  salt: string,
  info: string,
  length = 32,
): Promise<Uint8Array> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(ikm), 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(salt), info: enc.encode(info) },
    key,
    length * 8,
  )
  return new Uint8Array(bits)
}

// sfc32 seeded from the first 16 bytes of a derived seed. Deterministic
// across platforms; good enough distribution for trait selection.
export function seededPrng(seed: Uint8Array): () => number {
  const dv = new DataView(seed.buffer, seed.byteOffset, seed.byteLength)
  let a = dv.getUint32(0, true)
  let b = dv.getUint32(4, true)
  let c = dv.getUint32(8, true)
  let d = dv.getUint32(12, true)
  return () => {
    a |= 0; b |= 0; c |= 0; d |= 0
    const t = (a + b | 0) + d | 0
    d = d + 1 | 0
    a = b ^ b >>> 9
    b = c + (c << 3) | 0
    c = c << 21 | c >>> 11
    c = c + t | 0
    return (t >>> 0) / 4294967296
  }
}

export function pick<T>(rng: () => number, options: readonly T[]): T {
  const i = Math.floor(rng() * options.length)
  return options[Math.min(i, options.length - 1)]!
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('')
}
