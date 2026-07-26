// Invite tokens: how "I brought this person here" becomes checkable.
//
// A referral needs ATTRIBUTION, and the naive version ("X invited me") is tier-3
// — unverifiable, so it must never pay. Instead the witness mints a token bound
// to the inviter's DID and signs it. The token is self-contained: an agent
// restart cannot invalidate it, and anybody can verify it with the witness's
// public key, which its did:key carries in its own name.
//
//   world.freeq.at/?invite=<base64url payload>.<ed25519 sig>
//
// The newcomer's client redeems it as a `+freeq.at/event=invite_redeem` TAGMSG,
// so the redemption itself lands in the same public log as everything else and
// can be audited later. Credit is only attested once the newcomer actually
// speaks, and only for a did:plc — a real AT Protocol identity, which is the
// thing that makes minting yourself a friend expensive.

import nacl from 'tweetnacl'
import { publicKeyFromDid } from './signing'

export interface InvitePayload {
  /** always 'invite' — room for other token kinds later */
  k: string
  /** who gets the credit */
  inviter: string
  /** unique, so a token can be spent once */
  id: string
  /** unix seconds */
  iat: number
  /** unix seconds */
  exp: number
  /** the witness that signed it */
  witness: string
}

export const INVITE_TTL_SECONDS = 7 * 24 * 3600

/** JCS over the flat payload — the same rule quest events use. */
export function inviteCanonical(p: InvitePayload): string {
  const flat: Record<string, string> = {
    exp: String(p.exp), iat: String(p.iat), id: p.id, inviter: p.inviter, k: p.k, witness: p.witness,
  }
  const keys = Object.keys(flat).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(flat[k])}`).join(',')}}`
}

const b64urlEncode = (bytes: Uint8Array): string => {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  const raw = typeof btoa === 'function' ? btoa(bin) : Buffer.from(bin, 'binary').toString('base64')
  return raw.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const b64urlDecode = (s: string): Uint8Array => {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = typeof atob === 'function' ? atob(padded) : Buffer.from(padded, 'base64').toString('binary')
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

export function encodeInvite(payload: InvitePayload, sig: Uint8Array): string {
  const json = new TextEncoder().encode(inviteCanonical(payload))
  return `${b64urlEncode(json)}.${b64urlEncode(sig)}`
}

/** Parse without trusting: returns null on anything malformed. */
export function decodeInvite(token: string): { payload: InvitePayload; sig: Uint8Array } | null {
  const parts = token.split('.')
  if (parts.length !== 2) return null
  try {
    const json = new TextDecoder().decode(b64urlDecode(parts[0]!))
    const raw = JSON.parse(json) as Record<string, string>
    if (raw.k !== 'invite' || !raw.inviter || !raw.id || !raw.witness) return null
    return {
      payload: {
        k: raw.k, inviter: raw.inviter, id: raw.id, witness: raw.witness,
        iat: Number(raw.iat), exp: Number(raw.exp),
      },
      sig: b64urlDecode(parts[1]!),
    }
  } catch {
    return null
  }
}

export type InviteRejection =
  | 'malformed' | 'bad-signature' | 'expired' | 'self-referral' | 'not-an-account' | 'already-known'

export interface InviteCheck {
  ok: boolean
  reason?: InviteRejection
  payload?: InvitePayload
}

/**
 * Everything that has to be true before a referral can be credited.
 *
 * `redeemer` is the DID of whoever opened the link, as authenticated by the
 * server — not something they typed. The did:plc requirement is the anti-farm
 * lever: a throwaway did:key costs nothing to mint, so inviting yourself
 * forever would be free. A real AT Protocol account is not free.
 */
export function checkInvite(
  token: string,
  redeemer: string,
  opts: { now?: number; witnessDid?: string; knownIdentity?: (did: string) => boolean } = {},
): InviteCheck {
  const parsed = decodeInvite(token)
  if (!parsed) return { ok: false, reason: 'malformed' }
  const { payload, sig } = parsed
  const now = opts.now ?? Math.floor(Date.now() / 1000)

  const witness = opts.witnessDid ?? payload.witness
  if (witness !== payload.witness) return { ok: false, reason: 'bad-signature' }
  let pub: Uint8Array
  try {
    pub = publicKeyFromDid(witness)
  } catch {
    return { ok: false, reason: 'bad-signature' }
  }
  const bytes = new TextEncoder().encode(inviteCanonical(payload))
  if (!nacl.sign.detached.verify(bytes, sig, pub)) return { ok: false, reason: 'bad-signature' }

  if (!payload.exp || payload.exp < now) return { ok: false, reason: 'expired', payload }
  if (!redeemer) return { ok: false, reason: 'not-an-account', payload }
  if (redeemer === payload.inviter) return { ok: false, reason: 'self-referral', payload }
  // a real account, not a fresh browser key
  if (!redeemer.startsWith('did:plc:') && !redeemer.startsWith('did:web:')) {
    return { ok: false, reason: 'not-an-account', payload }
  }
  if (opts.knownIdentity?.(redeemer)) return { ok: false, reason: 'already-known', payload }
  return { ok: true, payload }
}

/** Why a redemption was refused, in words a player can act on. */
export const INVITE_REASONS: Record<InviteRejection, string> = {
  malformed: "that invite link isn't readable — ask for a fresh one",
  'bad-signature': "that invite wasn't signed by me, so I can't honour it",
  expired: 'that invite has expired — ask your host for a new one',
  'self-referral': "that's your own invite; someone else has to use it",
  'not-an-account':
    'referrals only count for a real AT Protocol identity — sign in with your Bluesky handle and the credit will land',
  'already-known': 'that identity has spoken here before, so it is not a new arrival',
}
