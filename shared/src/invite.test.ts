import { describe, expect, it } from 'vitest'
import nacl from 'tweetnacl'
import {
  checkInvite, decodeInvite, encodeInvite, inviteCanonical, INVITE_REASONS, INVITE_TTL_SECONDS,
  type InvitePayload,
} from './invite'
import { didFromPublicKey } from './signing'

const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3))
const WITNESS = didFromPublicKey(kp.publicKey)
const HOST = 'did:plc:host0000000000000000000'
const GUEST = 'did:plc:guest000000000000000000'
const NOW = 1_785_000_000

function mint(over: Partial<InvitePayload> = {}, signer = kp): string {
  const payload: InvitePayload = {
    k: 'invite', inviter: HOST, id: 'inv-1', iat: NOW, exp: NOW + INVITE_TTL_SECONDS, witness: WITNESS, ...over,
  }
  const sig = nacl.sign.detached(new TextEncoder().encode(inviteCanonical(payload)), signer.secretKey)
  return encodeInvite(payload, sig)
}

describe('invite tokens carry their own proof', () => {
  it('round-trips through a URL-safe string', () => {
    const token = mint()
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    expect(decodeInvite(token)?.payload.inviter).toBe(HOST)
    expect(checkInvite(token, GUEST, { now: NOW }).ok).toBe(true)
  })

  it('needs no server state: the token is the record', () => {
    // no ledger consulted anywhere in checkInvite
    const token = mint({ id: 'minted-before-a-restart' })
    expect(checkInvite(token, GUEST, { now: NOW + 3600 }).ok).toBe(true)
  })
})

describe('what a referral must not accept', () => {
  it('refuses a token this witness did not sign', () => {
    const impostor = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9))
    const r = checkInvite(mint({}, impostor), GUEST, { now: NOW })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('bad-signature')
  })

  it('refuses a token whose inviter was swapped after signing', () => {
    const token = mint()
    const [body, sig] = token.split('.')
    const json = JSON.parse(Buffer.from(body!, 'base64url').toString()) as Record<string, string>
    json.inviter = 'did:plc:thief0000000000000000'
    const tampered = `${Buffer.from(JSON.stringify(json)).toString('base64url')}.${sig}`
    expect(checkInvite(tampered, GUEST, { now: NOW }).reason).toBe('bad-signature')
  })

  it('refuses your own invite', () => {
    expect(checkInvite(mint(), HOST, { now: NOW }).reason).toBe('self-referral')
  })

  it('refuses a throwaway browser key — a referral means a real account', () => {
    const r = checkInvite(mint(), 'did:key:z6MkThrowaway000000000000000', { now: NOW })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('not-an-account')
    // ...and says how to fix it
    expect(INVITE_REASONS['not-an-account']).toMatch(/sign in with your Bluesky handle/)
  })

  it('accepts did:web as a real identity too', () => {
    expect(checkInvite(mint(), 'did:web:example.com', { now: NOW }).ok).toBe(true)
  })

  it('refuses somebody who already speaks here', () => {
    const r = checkInvite(mint(), GUEST, { now: NOW, knownIdentity: (d) => d === GUEST })
    expect(r.reason).toBe('already-known')
  })

  it('expires', () => {
    expect(checkInvite(mint(), GUEST, { now: NOW + INVITE_TTL_SECONDS + 1 }).reason).toBe('expired')
    expect(checkInvite(mint({ exp: 0 }), GUEST, { now: NOW }).reason).toBe('expired')
  })

  it('refuses garbage without throwing', () => {
    for (const bad of ['', 'nope', 'a.b', '...', 'eyJrIjoiaW52aXRlIn0.zzz']) {
      expect(checkInvite(bad, GUEST, { now: NOW }).ok).toBe(false)
    }
    expect(decodeInvite('nonsense')).toBeNull()
  })

  it('explains every refusal in words a player can act on', () => {
    for (const [reason, text] of Object.entries(INVITE_REASONS)) {
      expect(text.length, reason).toBeGreaterThan(20)
      expect(text, reason).not.toMatch(/error|invalid|failed/i)
    }
  })
})

describe('the agent mints what the browser verifies', () => {
  it('is byte-identical across the TS and plain-ESM implementations', async () => {
    const { inviteCanonical: mjsCanonical, invitePayload, encodeInvite: mjsEncode } =
      await import('../../scripts/quest.mjs')
    const payload = invitePayload({ inviter: HOST, witness: WITNESS, id: 'inv-x', now: NOW })
    expect(mjsCanonical(payload)).toBe(inviteCanonical(payload as never))

    // a token the AGENT produced must verify in the BROWSER's implementation
    const sig = nacl.sign.detached(new TextEncoder().encode(mjsCanonical(payload)), kp.secretKey)
    const token = mjsEncode(payload, sig)
    const check = checkInvite(token, GUEST, { now: NOW })
    expect(check.ok).toBe(true)
    expect(check.payload?.inviter).toBe(HOST)
  })
})

describe('crediting a referral (the path a live test cannot reach)', () => {
  // Completing a referral needs a genuinely new AT Protocol account, so the
  // decision is extracted and tested here instead of hoped about.
  const DAY = '2026-07-26'
  const pend = () => new Map([[GUEST, { inviter: HOST, id: 'inv-1', at: 0 }]])

  it('credits the host on the newcomer\u2019s first real sentence', async () => {
    const { referralCredit } = await import('../../scripts/quest.mjs')
    const r = referralCredit({
      pending: pend(), credited: new Set(), speaker: GUEST,
      text: 'hello everyone, glad to be here', day: DAY,
    })
    expect(r.credit).toBe(true)
    expect(r.inviter).toBe(HOST)
    expect(r.key).toBe(`${HOST}|${GUEST}|${DAY}`)
  })

  it('ignores a stray keystroke', async () => {
    const { referralCredit } = await import('../../scripts/quest.mjs')
    expect(referralCredit({ pending: pend(), credited: new Set(), speaker: GUEST, text: 'hi', day: DAY }))
      .toMatchObject({ credit: false, reason: 'too-short' })
  })

  it('pays exactly once', async () => {
    const { referralCredit } = await import('../../scripts/quest.mjs')
    const credited = new Set([`${HOST}|${GUEST}|${DAY}`])
    expect(referralCredit({ pending: pend(), credited, speaker: GUEST, text: 'a real sentence here', day: DAY }))
      .toMatchObject({ credit: false, reason: 'already-credited' })
  })

  it('ignores speech from anyone with no invite pending', async () => {
    const { referralCredit } = await import('../../scripts/quest.mjs')
    expect(referralCredit({
      pending: pend(), credited: new Set(), speaker: 'did:plc:stranger00000000000000',
      text: 'just passing through here', day: DAY,
    })).toMatchObject({ credit: false, reason: 'no-pending-invite' })
    expect(referralCredit({ pending: pend(), credited: new Set(), speaker: '', text: 'x'.repeat(20), day: DAY }))
      .toMatchObject({ credit: false, reason: 'unknown-speaker' })
  })
})
