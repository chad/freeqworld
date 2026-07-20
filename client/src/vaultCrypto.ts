// Client-side encryption for the Vault (spec §15). The room key is derived
// in the browser from a passphrase; the server only ever relays the
// {alg, iv, ct} envelope. Decryption failure renders a sealed envelope,
// never garbage (spec §15.4).

export interface CipherEnvelope {
  alg: 'aes-gcm'
  iv: string
  ct: string
}

const enc = new TextEncoder()
const dec = new TextDecoder()

function toB64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function fromB64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
}

export async function deriveRoomKey(channel: string, passphrase: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode(`freeq-vault:${channel}`), iterations: 100_000, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export async function encryptMessage(key: CryptoKey, plaintext: string): Promise<CipherEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext))
  return { alg: 'aes-gcm', iv: toB64(iv), ct: toB64(new Uint8Array(ct)) }
}

export async function decryptMessage(key: CryptoKey, env: CipherEnvelope): Promise<string | null> {
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(env.iv) as BufferSource }, key, fromB64(env.ct) as BufferSource)
    return dec.decode(plain)
  } catch {
    return null
  }
}
