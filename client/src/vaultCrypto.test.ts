import { describe, expect, it } from 'vitest'
import { decryptMessage, deriveRoomKey, encryptMessage } from './vaultCrypto'

describe('vault crypto (spec 15) — client-side AES-GCM', () => {
  it('round-trips a message through encrypt/decrypt', async () => {
    const key = await deriveRoomKey('#private-demo', 'freeq-vault-demo')
    const env = await encryptMessage(key, 'the secret plans')
    expect(env.alg).toBe('aes-gcm')
    const plain = await decryptMessage(key, env)
    expect(plain).toBe('the secret plans')
  })

  it('ciphertext does not contain the plaintext', async () => {
    const key = await deriveRoomKey('#private-demo', 'freeq-vault-demo')
    const env = await encryptMessage(key, 'the secret plans')
    expect(env.ct).not.toContain('secret')
    expect(env.iv.length).toBeGreaterThan(0)
  })

  it('uses a fresh iv per message', async () => {
    const key = await deriveRoomKey('#private-demo', 'freeq-vault-demo')
    const a = await encryptMessage(key, 'same text')
    const b = await encryptMessage(key, 'same text')
    expect(a.iv).not.toEqual(b.iv)
    expect(a.ct).not.toEqual(b.ct)
  })

  it('fails to decrypt with the wrong passphrase (returns null, not garbage)', async () => {
    const right = await deriveRoomKey('#private-demo', 'freeq-vault-demo')
    const wrong = await deriveRoomKey('#private-demo', 'incorrect-horse')
    const env = await encryptMessage(right, 'sealed')
    expect(await decryptMessage(wrong, env)).toBeNull()
  })
})
