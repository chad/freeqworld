// Types for the agents' plain-ESM courier bookkeeping, so the regression test
// (shared/src/quest.test.ts) typechecks. Same arrangement as act.d.mts.

export type QuestKindId =
  | 'courier' | 'survey' | 'rekindle' | 'escort' | 'post' | 'commit' | 'referral' | 'face'

export interface Quest {
  /** absent on entries written before kinds existed — treat as 'courier' */
  kind?: QuestKindId
  target: string
  phrase?: string
  bonus?: boolean
  newcomer?: string
  courier?: string
  /** how long the target had been silent when a rekindle was cut */
  quietHours?: number
  greeted?: number
  /** post / commit runs */
  nonce?: string
  link?: string
  repo?: string
}

export type Ledger = Map<string, Quest>

export interface Held {
  key: string
  quest: Quest
}

export type Outcome =
  | { kind: 'complete'; key: string; quest: Quest; stale?: Held; viaStale?: boolean }
  | { kind: 'wrong-room'; quest: Quest }
  | { kind: 'stale-phrase'; quest: Quest; said: string[] }
  | { kind: 'unknown-phrase'; quest: Quest | null; said: string[] }
  | { kind: 'none' }

export declare function courierRoot(nick: string): string
export declare function sameCourier(a: string, b: string): boolean
export declare function phrasesIn(text: string): string[]
export declare function deliveryOutcome(input: {
  ledger: Ledger
  from: string
  channel: string
  text: string
}): Outcome
export declare function existingEnvelope(ledger: Ledger, nick: string, target: string): Held | null

export declare function questCanonical(payload: Record<string, string>): string
export declare function completionPayload(a: {
  player: string; kind: string; channel: string; bonus?: boolean; ts?: number; witness: string
}): Record<string, string>

export declare const INVITE_TTL_SECONDS: number
export declare function inviteCanonical(p: Record<string, unknown>): string
export declare function invitePayload(a: { inviter: string; witness: string; id: string; now?: number }): {
  k: string; inviter: string; id: string; iat: number; exp: number; witness: string
}
export declare function encodeInvite(payload: Record<string, unknown>, sigBytes: Uint8Array): string

export declare function referralCredit(a: {
  pending: Map<string, { inviter: string; id: string; at: number }>
  credited: Set<string>
  speaker: string
  text: string
  day: string
}): { credit: boolean; reason?: string; inviter?: string; key?: string }

export declare const STATELESS_KINDS: string[]
export declare const SLOT_KINDS: string[]
export declare function issueDecision(a: { held?: Quest | null; requested?: string }): {
  action: 'issue' | 'resend' | 'blocked'; kind: string; holding?: string
}
