import { describe, expect, it } from 'vitest'
import nacl from 'tweetnacl'
import {
  completionsFromEvents, creditedXp, LADDERS, ladderBoard, levelFor, LEVELS, QUEST_EVENT,
  questCanonical, standings, verifyQuestEvent, type Completion,
} from './xp'
import { didFromPublicKey } from './signing'
import { actKid } from './act'
// the agents run under bare node, so the witness side is plain ESM
import { completionPayload, questCanonical as mjsCanonical } from '../../scripts/quest.mjs'

const DAY = 86400
const T0 = 1_785_000_000
const seed = new Uint8Array(32).fill(7)
const witnessKp = nacl.sign.keyPair.fromSeed(seed)
const WITNESS = didFromPublicKey(witnessKp.publicKey)
const ALICE = 'did:plc:alice000000000000000000'
const BOB = 'did:plc:bob00000000000000000000'

const b64url = (b: Uint8Array) =>
  Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** Sign like the agent does, so the tests exercise the real path. */
async function witnessedEvent(
  player: string, kind: string, channel: string, opts: { bonus?: boolean; ts?: number } = {},
) {
  const payload = completionPayload({ player, kind, channel, bonus: opts.bonus, ts: opts.ts ?? T0, witness: WITNESS })
  const sig = `ed25519:${await actKid(witnessKp.publicKey)}:${b64url(
    nacl.sign.detached(new TextEncoder().encode(mjsCanonical(payload)), witnessKp.secretKey),
  )}`
  return { actor_did: WITNESS, event_type: QUEST_EVENT, payload, signature: sig, timestamp: opts.ts ?? T0 }
}

const done = (over: Partial<Completion> = {}): Completion => ({
  player: ALICE, kind: 'courier', channel: '#lobby', bonus: false, ts: T0, witness: WITNESS, verified: true, ...over,
})

describe('the canonical the witness signs', () => {
  it('is byte-identical in the TS and the plain-ESM implementation', () => {
    const cases: Record<string, string>[] = [
      { player: ALICE, kind: 'courier', channel: '#lobby', bonus: '0', ts: '1785000000', witness: WITNESS },
      { z: 'last', a: 'first', m: 'middle' },
      { 'quote"key': 'back\\slash', unicode: 'café ☕' },
      {},
    ]
    for (const p of cases) {
      expect(mjsCanonical(p)).toBe(questCanonical(p))
    }
  })

  it('sorts keys and holds no insignificant whitespace', () => {
    expect(questCanonical({ b: '2', a: '1' })).toBe('{"a":"1","b":"2"}')
  })
})

describe('only a witness can write a completion', () => {
  it('verifies a real signature against the key inside the witness DID', async () => {
    const e = await witnessedEvent(ALICE, 'courier', '#lobby')
    expect(await verifyQuestEvent(e.payload, e.signature, WITNESS)).toBe(true)
  })

  it('refuses a payload that has been edited after signing', async () => {
    const e = await witnessedEvent(ALICE, 'courier', '#lobby')
    // the obvious attack: award the XP to somebody else
    expect(await verifyQuestEvent({ ...e.payload, player: BOB }, e.signature, WITNESS)).toBe(false)
    // or upgrade the run to the one that pays most
    expect(await verifyQuestEvent({ ...e.payload, kind: 'escort' }, e.signature, WITNESS)).toBe(false)
    // or claim the double-pay bonus
    expect(await verifyQuestEvent({ ...e.payload, bonus: '1' }, e.signature, WITNESS)).toBe(false)
  })

  it('refuses a signature from a different key claiming to be the witness', async () => {
    const impostor = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9))
    const payload = completionPayload({ player: ALICE, kind: 'escort', channel: '#lobby', witness: WITNESS, ts: T0 })
    const sig = `ed25519:${await actKid(impostor.publicKey)}:${b64url(
      nacl.sign.detached(new TextEncoder().encode(questCanonical(payload)), impostor.secretKey),
    )}`
    expect(await verifyQuestEvent(payload, sig, WITNESS)).toBe(false)
  })

  it('refuses missing and malformed signatures', async () => {
    const e = await witnessedEvent(ALICE, 'courier', '#lobby')
    expect(await verifyQuestEvent(e.payload, undefined, WITNESS)).toBe(false)
    expect(await verifyQuestEvent(e.payload, 'nonsense', WITNESS)).toBe(false)
    expect(await verifyQuestEvent(e.payload, e.signature, 'did:plc:notakey')).toBe(false)
  })

  it('scores nothing for an unverified completion', () => {
    expect(creditedXp([done({ verified: false })])).toBe(0)
  })

  it('drops an event whose transport disagrees with the signed witness', async () => {
    const e = await witnessedEvent(ALICE, 'courier', '#lobby')
    const forged = { ...e, actor_did: BOB } // relayed by someone else
    const [c] = await completionsFromEvents([forged])
    expect(c!.verified).toBe(false)
  })
})

describe('XP is a pure function of the log', () => {
  it('weights work by how hard it is to fake', () => {
    expect(creditedXp([done({ kind: 'courier' })])).toBe(10)
    expect(creditedXp([done({ kind: 'survey' })])).toBe(15)
    expect(creditedXp([done({ kind: 'rekindle' })])).toBe(25)
    expect(creditedXp([done({ kind: 'escort' })])).toBe(40) // needs a stranger to answer
  })

  it('pays double for a quiet room', () => {
    expect(creditedXp([done({ kind: 'rekindle', bonus: true })])).toBe(50)
  })

  it('ignores kinds it does not know', () => {
    expect(creditedXp([done({ kind: 'loitering' })])).toBe(0)
  })

  it('is order-independent and repeatable', () => {
    const list = [
      done({ kind: 'courier', ts: T0 + 10 }),
      done({ kind: 'escort', channel: '#dev', ts: T0 }),
      done({ kind: 'survey', channel: '#general', ts: T0 + 5 }),
    ]
    const a = creditedXp(list)
    const b = creditedXp([...list].reverse())
    expect(a).toBe(b)
    expect(a).toBe(10 + 40 + 15)
  })
})

describe('grinding one room does not pay', () => {
  it('halves, quarters, then stops paying for repeats the same day', () => {
    const four = [0, 1, 2, 3].map((i) => done({ ts: T0 + i * 60 }))
    // 10 + 5 + 2.5→3 + 0
    expect(creditedXp(four)).toBe(10 + 5 + 3)
  })

  it('resets the next day', () => {
    expect(creditedXp([done({ ts: T0 }), done({ ts: T0 + DAY })])).toBe(20)
  })

  it('counts different rooms separately', () => {
    expect(creditedXp([done({ channel: '#lobby' }), done({ channel: '#dev' })])).toBe(20)
  })

  it('does not let one player\u2019s grinding shrink another\u2019s pay', () => {
    expect(creditedXp([done({ player: ALICE }), done({ player: BOB })])).toBe(20)
  })
})

describe('levels grant verbs', () => {
  it('starts everyone at Wanderer with the next rung in sight', () => {
    const l = levelFor(0)
    expect(l.level).toBe(1)
    expect(l.title).toBe('Wanderer')
    expect(l.need).toBe(30)
    expect(l.into).toBe(0)
  })

  it('lands exactly on the thresholds', () => {
    for (const def of LEVELS) {
      expect(levelFor(def.at).level, `at ${def.at}`).toBe(def.level)
      if (def.level > 1) expect(levelFor(def.at - 1).level).toBe(def.level - 1)
    }
  })

  it('reports progress into the current level', () => {
    const l = levelFor(100) // level 3 starts at 75, level 4 at 140
    expect(l.level).toBe(3)
    expect(l.into).toBe(25)
    expect(l.need).toBe(65)
  })

  it('tops out cleanly', () => {
    const top = LEVELS[LEVELS.length - 1]!
    const l = levelFor(top.at + 5000)
    expect(l.level).toBe(top.level)
    expect(l.next).toBeNull()
    expect(l.need).toBe(0)
  })

  it('unlocks a capability that actually exists, not a stat bump', () => {
    const unlocks = LEVELS.filter((l) => l.unlock).map((l) => l.unlock!)
    expect(unlocks.length).toBeGreaterThanOrEqual(8)
    for (const u of unlocks) expect(u).not.toMatch(/\+\d|damage|strength/i)
    expect(unlocks.join(' ')).toMatch(/familiar/)
    expect(unlocks.join(' ')).toMatch(/countersign/)
  })
})

describe('the leaderboard is the same computation, grouped', () => {
  const log = [
    done({ player: ALICE, kind: 'escort', channel: '#lobby', ts: T0 }),
    done({ player: ALICE, kind: 'courier', channel: '#dev', ts: T0 + DAY }),
    done({ player: BOB, kind: 'rekindle', channel: '#general', bonus: true, ts: T0 }),
    done({ player: BOB, kind: 'survey', channel: '#lobby', ts: T0 + DAY }),
    done({ player: BOB, kind: 'survey', channel: '#dev', ts: T0 + DAY }),
  ]

  it('ranks by XP and reports each ladder', () => {
    const board = standings(log)
    expect(board.map((s) => s.player)).toEqual([BOB, ALICE]) // 50+15+15 vs 40+10
    expect(board[0]!.xp).toBe(80)
    expect(board[0]!.byLadder.cartographer).toBe(2)
    expect(board[1]!.byLadder.welcomer).toBe(1)
    expect(board[0]!.level).toBe(levelFor(80).level)
  })

  it('gives each ladder its own winner so more than one person can lead', () => {
    expect(ladderBoard(standings(log), 'welcomer')[0]!.player).toBe(ALICE)
    expect(ladderBoard(standings(log), 'cartographer')[0]!.player).toBe(BOB)
    expect(ladderBoard(standings(log), 'witness')).toEqual([])
    expect(LADDERS.map((l) => l.id)).toEqual(['courier', 'cartographer', 'kindler', 'welcomer', 'herald', 'witness'])
  })

  it('excludes unverified work from the board entirely', () => {
    const board = standings([...log, done({ player: 'did:plc:cheat', kind: 'escort', verified: false })])
    expect(board.map((s) => s.player)).not.toContain('did:plc:cheat')
  })

  it('is stable for equal scores', () => {
    const a = standings(log).map((s) => s.player)
    expect(standings([...log].reverse()).map((s) => s.player)).toEqual(a)
  })
})

describe('end to end: wire events to a board', () => {
  it('turns witnessed events into standings, rejecting a forged one', async () => {
    const wire = [
      await witnessedEvent(ALICE, 'escort', '#lobby', { bonus: true }),
      await witnessedEvent(BOB, 'courier', '#dev'),
    ]
    // a self-awarded event with no witness signature
    const forged = { actor_did: 'did:plc:cheat', event_type: QUEST_EVENT, timestamp: T0,
      payload: { player: 'did:plc:cheat', kind: 'escort', channel: '#lobby', bonus: '1', ts: String(T0), witness: 'did:plc:cheat' } }
    const completions = await completionsFromEvents([...wire, forged])
    expect(completions.filter((c) => c.verified).length).toBe(2)
    const board = standings(completions)
    expect(board.map((s) => s.player)).toEqual([ALICE, BOB]) // 80 vs 10
    expect(board.find((s) => s.player === 'did:plc:cheat')).toBeUndefined()
  })

  it('ignores unrelated coordination events on the same log', async () => {
    const noise = [{ actor_did: WITNESS, event_type: 'read', payload: { msgid: 'x' }, timestamp: T0 }]
    expect(await completionsFromEvents(noise)).toEqual([])
  })
})
