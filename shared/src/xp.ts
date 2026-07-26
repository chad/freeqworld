// Levels and standings, as a pure function over the signed completion log.
//
// THE PROPERTY THIS FILE EXISTS TO PROTECT: nobody grants you a level. Your XP
// is a computation over work that a witness signed, and anyone can recompute it
// from the same public log:
//
//   curl 'https://irc.freeq.at/api/v1/channels/%23general/events?type=quest_complete'
//
// freeq-server durably stores any TAGMSG carrying `+freeq.at/event=<type>` from
// an authenticated DID (connection/messaging.rs → coordination_events), indexed
// by actor and channel and queryable over HTTP. So the ledger already exists;
// this module is only arithmetic over it.
//
// Two consequences worth stating plainly:
//   * The witness signs, the player is named in the payload. Only the
//     Cartographer can write a completion, and its signature is checked here
//     against the public key carried inside its own did:key — so a middlebox
//     (including our own /api/xp proxy, which exists because the events API
//     sends no CORS header) can omit events but can never invent one.
//   * Nothing is awarded for talking. XP comes only from witnessed work. The
//     moment chatter earns points, real channels become grind farms.

import { publicKeyFromDid } from './signing'
import { actKid } from './act'
import nacl from 'tweetnacl'

export const QUEST_EVENT = 'quest_complete'

/** The five ladders. Separate boards so more than one person can be first at
 *  something — a single ranking makes one winner and everybody else a loser. */
export type Ladder = 'courier' | 'cartographer' | 'kindler' | 'welcomer' | 'herald' | 'witness'

export const LADDERS: { id: Ladder; label: string; blurb: string }[] = [
  { id: 'courier', label: 'Courier', blurb: 'sealed phrases carried' },
  { id: 'cartographer', label: 'Cartographer', blurb: 'rooms charted' },
  { id: 'kindler', label: 'Kindler', blurb: 'quiet rooms woken' },
  { id: 'welcomer', label: 'Welcomer', blurb: 'newcomers who answered' },
  { id: 'herald', label: 'Herald', blurb: 'identities brought into the network' },
  { id: 'witness', label: 'Witness', blurb: 'work countersigned' },
]

const LADDER_FOR_KIND: Record<string, Ladder> = {
  referral: 'herald',
  courier: 'courier',
  survey: 'cartographer',
  rekindle: 'kindler',
  escort: 'welcomer',
  countersign: 'witness',
}

/** Weighted by how hard the work is to fake, not by how long it takes.
 *  An escort needs a stranger to voluntarily answer, so it pays most. */
const XP_BY_KIND: Record<string, number> = {
  // landing a commit: the ONLY tier-2 action here — an oracle (GitHub) attests
  // that the commit exists, so the witness records which oracle it believed.
  commit: 30,
  // posting your standing: read out of the player's OWN repo (their PDS, not an
  // aggregator). Paid once ever — paying for repeat posts would make us spam.
  post: 25,
  // an external action, verified with no oracle at all: your Bluesky avatar is
  // the exact bytes your DID derives (server/src/face.ts + shared/src/cid.ts).
  // A one-off achievement, so it scores but has no ladder.
  face: 35,
  // bringing a real new identity into the network is the most valuable single
  // act available, so it pays most — and it is the hardest to fake, because the
  // arrival is witnessed and a throwaway key is refused
  referral: 50,
  courier: 10,
  survey: 15,
  rekindle: 25,
  escort: 40,
  countersign: 5,
}

/** Cumulative XP for each level, with what it unlocks. Levels grant VERBS, not
 *  stat bumps: in this world the reward is being trusted with more of the
 *  protocol. Capability grants, spawned agents and channel budgets all already
 *  exist server-side, which is why these are reachable rather than aspirational. */
export interface LevelDef {
  level: number
  title: string
  at: number
  unlock?: string
}

export const LEVELS: LevelDef[] = [
  { level: 1, title: 'Wanderer', at: 0, unlock: 'courier runs' },
  { level: 2, title: 'Wanderer', at: 30 },
  { level: 3, title: 'Runner', at: 75, unlock: 'survey — read the register' },
  { level: 4, title: 'Runner', at: 140 },
  { level: 5, title: 'Kindler', at: 230, unlock: 'rekindle rooms gone quiet' },
  { level: 6, title: 'Kindler', at: 350 },
  { level: 7, title: 'Kindler', at: 500 },
  { level: 8, title: 'Welcomer', at: 700, unlock: 'escort, and vouch for a newcomer' },
  { level: 9, title: 'Welcomer', at: 950 },
  { level: 10, title: 'Welcomer', at: 1250, unlock: 'an aura' },
  { level: 11, title: 'Handler', at: 1600 },
  { level: 12, title: 'Handler', at: 2050, unlock: 'dispatch a familiar — a real spawned agent' },
  { level: 13, title: 'Handler', at: 2600 },
  { level: 14, title: 'Keeper', at: 3250 },
  { level: 15, title: 'Keeper', at: 4000, unlock: 'adopt a channel; be summoned when it falls quiet' },
  { level: 16, title: 'Keeper', at: 4900 },
  { level: 17, title: 'Founder', at: 5950 },
  { level: 18, title: 'Founder', at: 7150, unlock: 'found a guild — a channel with a real budget' },
  { level: 19, title: 'Witness', at: 8500 },
  { level: 20, title: 'Witness', at: 10000, unlock: 'countersign the work of others' },
]

/** The runs a witness can actually confirm, described once so the help page and
 *  the scoring table can never disagree. `xp` is READ FROM the same weights that
 *  award it — the previous drift (a doc claiming rekindle needed a day of
 *  silence when nothing checked) is exactly what this prevents. */
export interface QuestKind {
  id: string
  label: string
  ask: string
  doThis: string
  witnessedBy: string
  xp: number
  alwaysDouble?: boolean
}

export const QUEST_KINDS: QuestKind[] = [
  {
    id: 'courier',
    label: 'Courier run',
    ask: 'cartographer, quest',
    doThis: 'it DMs you a sealed phrase and a room — go there and say the phrase aloud',
    witnessedBy: 'the Cartographer is a member of that channel and sees you say it',
    xp: XP_BY_KIND.courier!,
  },
  {
    id: 'survey',
    label: 'Survey',
    ask: 'cartographer, quest survey',
    doThis: "read the named room's topic, then DM the Cartographer what it says",
    witnessedBy: "checked against the channel's real topic in the LIST register",
    xp: XP_BY_KIND.survey!,
  },
  {
    id: 'rekindle',
    label: 'Rekindle',
    ask: 'cartographer, quest rekindle',
    doThis: 'go to the room it names — one that has genuinely been silent for over a day — and say something worth answering',
    witnessedBy: 'the silence is measured from real message timestamps; only a dead room can be offered',
    xp: XP_BY_KIND.rekindle!,
    alwaysDouble: true,
  },
  {
    id: 'commit',
    label: 'Land a commit',
    ask: 'cartographer, quest commit owner/repo',
    doThis: 'put the phrase it gives you in a commit message and push it',
    witnessedBy: 'an ORACLE run: GitHub is asked whether the commit exists, and the attestation records that it was GitHub who said so — the only run here that trusts a third party',
    xp: XP_BY_KIND.commit!,
  },
  {
    id: 'post',
    label: 'Post your standing',
    ask: 'cartographer, quest post',
    doThis: 'put the link it gives you in a Bluesky post, then say "posted"',
    witnessedBy: "read out of your own repo on the PDS you chose — not out of anyone's feed — and it pays once, ever",
    xp: XP_BY_KIND.post!,
  },
  {
    id: 'face',
    label: 'Wear your face',
    ask: 'cartographer, quest face',
    doThis: 'set your Bluesky avatar to the character your DID derives — the ID app does it in one tap',
    witnessedBy: 'no oracle at all: your avatar is addressed by the hash of its bytes inside a record signed by your own repo, and the portrait is recomputed from your DID',
    xp: XP_BY_KIND.face!,
  },
  {
    id: 'referral',
    label: 'Referral',
    ask: 'cartographer, quest referral',
    doThis: 'it DMs you an invite link — give it to someone who has never been here, and the run completes when they arrive and speak',
    witnessedBy: 'the invite is signed and names you; the arrival is witnessed, and only a real AT Protocol identity counts',
    xp: XP_BY_KIND.referral!,
    alwaysDouble: true,
  },
  {
    id: 'escort',
    label: 'Escort',
    ask: 'cartographer, quest escort',
    doThis: 'greet the newcomer it names BY NAME in their room, and draw a reply out of them',
    witnessedBy: 'both halves are witnessed — the greeting and their answer',
    xp: XP_BY_KIND.escort!,
    alwaysDouble: true,
  },
]

export interface Completion {
  /** the DID the XP belongs to */
  player: string
  /** courier | survey | rekindle | escort | countersign */
  kind: string
  channel: string
  /** the run paid double (a quiet room) */
  bonus: boolean
  /** unix seconds */
  ts: number
  /** the DID that witnessed and signed it */
  witness: string
  /** for oracle-attested work: who the witness believed (e.g. 'github') */
  via?: string
  /** did the witness signature check out? unverified never scores */
  verified: boolean
}

/** JCS over a flat string map: JSON, keys sorted, no insignificant whitespace.
 *  Mirrored byte-for-byte in scripts/quest.mjs (the agents run under bare node
 *  and can't import TS); shared/src/xp.test.ts holds the two together. */
export function questCanonical(payload: Record<string, string>): string {
  const keys = Object.keys(payload).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(String(payload[k]))}`).join(',')}}`
}

/** Check a witness signature (`ed25519:<kid>:<b64url sig>`) over the payload.
 *  The witness's public key is carried inside its own did:key, so this needs no
 *  lookup and no trust in whoever delivered the event. */
export async function verifyQuestEvent(
  payload: Record<string, string>, sig: string | undefined, witnessDid: string,
): Promise<boolean> {
  if (!sig) return false
  const parts = sig.split(':')
  if (parts.length !== 3 || parts[0] !== 'ed25519') return false
  const [, kid, raw] = parts as [string, string, string]
  let pub: Uint8Array
  try {
    pub = publicKeyFromDid(witnessDid)
  } catch {
    return false
  }
  if (kid !== (await actKid(pub))) return false
  try {
    const bin = atobUniversal(raw.replace(/-/g, '+').replace(/_/g, '/'))
    return nacl.sign.detached.verify(
      new TextEncoder().encode(questCanonical(payload)), bin, pub,
    )
  } catch {
    return false
  }
}

function atobUniversal(s: string): Uint8Array {
  const bin = typeof atob === 'function' ? atob(s) : Buffer.from(s, 'base64').toString('binary')
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

const DAY = 86400

/** Diminishing returns per player, per channel, per day: 100%, 50%, 25%, then
 *  nothing. Repeating the same run in the same room is grinding, and grinding a
 *  real chat channel is exactly what would make this a mess. */
export function creditedXp(completions: Completion[]): number {
  const seen = new Map<string, number>()
  let total = 0
  for (const c of [...completions].sort((a, b) => a.ts - b.ts)) {
    if (!c.verified) continue
    const base = XP_BY_KIND[c.kind]
    if (!base) continue
    const key = `${c.player}|${c.channel}|${Math.floor(c.ts / DAY)}`
    const n = seen.get(key) ?? 0
    seen.set(key, n + 1)
    const decay = n === 0 ? 1 : n === 1 ? 0.5 : n === 2 ? 0.25 : 0
    total += Math.round(base * (c.bonus ? 2 : 1) * decay)
  }
  return total
}

export interface Standing {
  player: string
  xp: number
  level: number
  title: string
  runs: number
  byLadder: Record<Ladder, number>
  lastAt: number
}

export function levelFor(xp: number): {
  level: number
  title: string
  into: number
  need: number
  next: LevelDef | null
  unlock?: string
} {
  let current = LEVELS[0]!
  for (const l of LEVELS) if (xp >= l.at) current = l
  const next = LEVELS.find((l) => l.level === current.level + 1) ?? null
  return {
    level: current.level,
    title: current.title,
    into: xp - current.at,
    need: next ? next.at - current.at : 0,
    next,
    unlock: next?.unlock,
  }
}

/** Everyone's standing, best first. This IS the leaderboard. */
export function standings(completions: Completion[]): Standing[] {
  const byPlayer = new Map<string, Completion[]>()
  for (const c of completions) {
    if (!c.verified) continue
    const list = byPlayer.get(c.player) ?? []
    list.push(c)
    byPlayer.set(c.player, list)
  }
  const out: Standing[] = []
  for (const [player, list] of byPlayer) {
    const xp = creditedXp(list)
    const { level, title } = levelFor(xp)
    const byLadder = { courier: 0, cartographer: 0, kindler: 0, welcomer: 0, herald: 0, witness: 0 } as Record<Ladder, number>
    for (const c of list) {
      const ladder = LADDER_FOR_KIND[c.kind]
      if (ladder) byLadder[ladder]++
    }
    out.push({
      player, xp, level, title,
      runs: list.length,
      byLadder,
      lastAt: Math.max(...list.map((c) => c.ts)),
    })
  }
  return out.sort((a, b) => b.xp - a.xp || b.runs - a.runs || a.player.localeCompare(b.player))
}

/** One ladder's board. */
export function ladderBoard(all: Standing[], ladder: Ladder, limit = 5): Standing[] {
  return all
    .filter((s) => s.byLadder[ladder] > 0)
    .sort((a, b) => b.byLadder[ladder] - a.byLadder[ladder] || b.xp - a.xp)
    .slice(0, limit)
}

/** Parse the wire form (what /api/v1/channels/{name}/events returns, or what the
 *  town server's /api/xp proxy forwards) into completions, verifying as it goes. */
export async function completionsFromEvents(
  events: { actor_did?: string; event_type?: string; payload?: unknown; signature?: string; timestamp?: number }[],
): Promise<Completion[]> {
  const out: Completion[] = []
  for (const e of events) {
    if (e.event_type !== QUEST_EVENT) continue
    const p = e.payload as Record<string, string> | undefined
    if (!p?.player || !p.kind) continue
    const witness = e.actor_did ?? p.witness ?? ''
    out.push({
      player: p.player,
      kind: p.kind,
      via: p.via,
      channel: p.channel ?? '',
      bonus: p.bonus === '1' || p.bonus === 'true',
      ts: Number(p.ts ?? e.timestamp ?? 0),
      witness,
      // the witness names itself in the payload; if the transport disagrees with
      // the signed content, don't score it
      verified: (p.witness ?? witness) === witness
        && (await verifyQuestEvent(p, e.signature, witness)),
    })
  }
  return out
}
