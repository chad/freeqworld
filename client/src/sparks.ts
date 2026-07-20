// Sparks ✦ — the touch currency. The first time you touch another player,
// you collect them. Between two world clients the contact is cryptographic:
// each signs {from, to, ts} with its ed25519 key and sends it over an
// ephemeral TAGMSG, so your collection is a book of verifiable autographs
// from the DIDs you have met. Members on conventional clients collect as
// unsigned "brushed past" entries.

import { canonicalJson, signEvent, verifyEvent } from '../../shared/src/signing'

export const TOUCH_TAG = '+freeq.at/world-touch'

export function signTouch(fromDid: string, toDid: string, ts: number, secretKey: Uint8Array): string {
  return signEvent({ kind: 'world-touch', from: fromDid, to: toDid, ts }, secretKey)
}

export function verifyTouch(fromDid: string, toDid: string, ts: number, sig: string): boolean {
  void canonicalJson // (same canonicalization as signEvent)
  return verifyEvent({ kind: 'world-touch', from: fromDid, to: toDid, ts }, sig, fromDid)
}

/** wire format: <toNick>,<ts>,<sig> — all base58/nick-safe, no tag escaping needed */
export function encodeTouchTag(toNick: string, ts: number, sig: string): string {
  return `${toNick},${ts},${sig}`
}

export function decodeTouchTag(value: string): { toNick: string; ts: number; sig: string } | null {
  const parts = value.split(',')
  if (parts.length !== 3) return null
  const ts = Number(parts[1])
  if (!parts[0] || !parts[2] || !Number.isFinite(ts)) return null
  return { toNick: parts[0]!, ts, sig: parts[2]! }
}

export interface SparkEntry {
  did: string
  nick: string
  name: string
  channel: string
  ts: number
  verified: boolean
  sig?: string
  selfDid?: string
}

const STORE_KEY = 'freeqworld-sparks-v1'

export class SparkBook {
  private byDid = new Map<string, SparkEntry>()

  constructor() {
    try {
      const raw = localStorage.getItem(STORE_KEY)
      if (raw) {
        for (const e of JSON.parse(raw) as SparkEntry[]) this.byDid.set(e.did, e)
      }
    } catch {
      /* fresh book */
    }
  }

  private save(): void {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify([...this.byDid.values()]))
    } catch {
      /* storage full/blocked — the session still works */
    }
  }

  /** returns true when this is a NEW unique contact (a spark earned) */
  add(entry: SparkEntry): boolean {
    if (entry.selfDid && entry.did === entry.selfDid) return false
    const existing = this.byDid.get(entry.did)
    if (existing) {
      // an unsigned brush can be upgraded to a verified autograph later
      if (entry.verified && !existing.verified) {
        this.byDid.set(entry.did, { ...existing, verified: true, sig: entry.sig })
        this.save()
      }
      return false
    }
    this.byDid.set(entry.did, entry)
    this.save()
    return true
  }

  has(did: string): boolean {
    return this.byDid.has(did)
  }

  count(): number {
    return this.byDid.size
  }

  entries(): SparkEntry[] {
    return [...this.byDid.values()].sort((a, b) => b.ts - a.ts)
  }
}

const TITLES: [number, string][] = [
  [80, 'Mayor of Freeq'],
  [40, 'Socialite'],
  [20, 'Connector'],
  [10, 'Regular'],
  [5, 'Acquainted'],
  [1, 'First Contact'],
  [0, 'Stranger'],
]

export function titleFor(count: number): string {
  for (const [min, title] of TITLES) if (count >= min) return title
  return 'Stranger'
}
