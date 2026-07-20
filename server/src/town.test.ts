import { describe, expect, it, vi } from 'vitest'
import { Town, type Connection } from './town'
import { didFromPublicKey, generateKeypair, signEvent } from '../../shared/src/signing'
import type { ChatMessage, ServerFrame, WorldPosition } from '../../shared/src/protocol'

function makeTown(now = () => 1_800_000_000_000) {
  return new Town({ server: 'testville', name: 'Testville', theme: 'network-noir', palette: 'amber-cyan', peers: [] }, { now, agentDelayMs: 0 })
}

function makeConn(): Connection & { frames: ServerFrame[] } {
  const frames: ServerFrame[] = []
  return { frames, send: (f: ServerFrame) => frames.push(f), close: () => {} }
}

function login(town: Town, conn: Connection, name: string, channel = '#lobby') {
  const kp = generateKeypair()
  const did = didFromPublicKey(kp.publicKey)
  town.handleFrame(conn, { t: 'hello', did, handle: `${name}.test`, display_name: name, channel, client_instance: `dev-${name}` })
  return { kp, did }
}

function signedMsg(kp: ReturnType<typeof generateKeypair>, did: string, channel: string, content: string, id = crypto.randomUUID()): Omit<ChatMessage, 'origin_server' | 'edit_state' | 'sender_name'> {
  const base = { id, channel, sender: did, content, type: 'text' as const, ts: 1_800_000_000_000 }
  return { ...base, signature: signEvent(base, kp.secretKey) }
}

describe('membership and welcome (spec 6.2/6.3)', () => {
  it('welcomes a joining participant with town profile, rooms, history and members', () => {
    const town = makeTown()
    const conn = makeConn()
    login(town, conn, 'ada')
    const welcome = conn.frames.find((f) => f.t === 'welcome')
    expect(welcome).toBeDefined()
    if (welcome?.t !== 'welcome') throw new Error('no welcome')
    expect(welcome.town.schema).toBe('freeq.at/world/server-profile/v1')
    expect(welcome.town.server).toBe('testville')
    expect(welcome.rooms.length).toBeGreaterThanOrEqual(7)
    expect(welcome.channel).toBe('#lobby')
    // agents are pre-seeded members somewhere in town
    const agents = welcome.members.filter((m) => m.is_agent)
    expect(agents.length).toBeGreaterThanOrEqual(1)
  })

  it('announces the new member to already-present members', () => {
    const town = makeTown()
    const a = makeConn()
    const b = makeConn()
    login(town, a, 'ada')
    login(town, b, 'grace')
    const memberFrame = a.frames.find((f) => f.t === 'member' && f.member.display_name === 'grace')
    expect(memberFrame).toBeDefined()
  })
})

describe('durable signed messages (spec 4.1, 22.4)', () => {
  it('accepts a correctly signed message, appends to durable log, broadcasts', () => {
    const town = makeTown()
    const a = makeConn()
    const b = makeConn()
    const ada = login(town, a, 'ada')
    login(town, b, 'grace')
    town.handleFrame(a, { t: 'msg', event: signedMsg(ada.kp, ada.did, '#lobby', 'hello world') })
    const got = b.frames.find((f) => f.t === 'event' && f.durable.kind === 'message')
    expect(got).toBeDefined()
    if (got?.t !== 'event' || got.durable.kind !== 'message') throw new Error('bad frame')
    expect(got.durable.event.content).toBe('hello world')
    expect(got.durable.event.origin_server).toBe('testville')
    expect(town.getLog('#lobby').some((e) => e.kind === 'message' && e.event.content === 'hello world')).toBe(true)
  })

  it('rejects a message whose signature does not verify against the sender DID', () => {
    const town = makeTown()
    const a = makeConn()
    const ada = login(town, a, 'ada')
    const forged = { ...signedMsg(ada.kp, ada.did, '#lobby', 'real'), content: 'forged' }
    town.handleFrame(a, { t: 'msg', event: forged })
    expect(town.getLog('#lobby').some((e) => e.kind === 'message' && e.event.content === 'forged')).toBe(false)
    expect(a.frames.some((f) => f.t === 'error')).toBe(true)
  })

  it('rejects messages impersonating another DID', () => {
    const town = makeTown()
    const a = makeConn()
    const ada = login(town, a, 'ada')
    const victim = generateKeypair()
    const victimDid = didFromPublicKey(victim.publicKey)
    const base = { id: crypto.randomUUID(), channel: '#lobby', sender: victimDid, content: 'i am not ada', type: 'text' as const, ts: 1 }
    const evil = { ...base, signature: signEvent(base, ada.kp.secretKey) }
    town.handleFrame(a, { t: 'msg', event: evil })
    expect(town.getLog('#lobby').some((e) => e.kind === 'message' && e.event.sender === victimDid)).toBe(false)
  })

  it('enforces a per-DID rate limit (spec 16.5)', () => {
    const town = makeTown()
    const a = makeConn()
    const ada = login(town, a, 'ada')
    for (let i = 0; i < 30; i++) {
      town.handleFrame(a, { t: 'msg', event: signedMsg(ada.kp, ada.did, '#lobby', `msg ${i}`) })
    }
    const stored = town.getLog('#lobby').filter((e) => e.kind === 'message' && e.event.sender === ada.did)
    expect(stored.length).toBeLessThan(30)
    expect(a.frames.some((f) => f.t === 'error' && /rate/i.test(f.message))).toBe(true)
  })
})

describe('ephemeral presence (spec 7.4, 22.4)', () => {
  function pos(did: string, seq: number, x = 5, expires = 1_800_000_010_000): WorldPosition {
    return { type: 'freeq.at/presence/world-position/v1', channel: '#lobby', did, x, y: 5, facing: 'south', animation: 'idle', client_instance: 'dev-1', sequence: seq, expires_at: expires }
  }

  it('movement never lands in the durable log (spec 3.3)', () => {
    const town = makeTown()
    const a = makeConn()
    const ada = login(town, a, 'ada')
    const before = town.getLog('#lobby').length
    town.handleFrame(a, { t: 'pos', pos: pos(ada.did, 1) })
    expect(town.getLog('#lobby').length).toBe(before)
    expect(town.getPresence('#lobby').some((p) => p.did === ada.did)).toBe(true)
  })

  it('resolves conflicts last-write-wins by sequence (spec 7.4)', () => {
    const town = makeTown()
    const a = makeConn()
    const ada = login(town, a, 'ada')
    town.handleFrame(a, { t: 'pos', pos: pos(ada.did, 5, 10) })
    town.handleFrame(a, { t: 'pos', pos: pos(ada.did, 3, 99) }) // stale
    const p = town.getPresence('#lobby').find((p) => p.did === ada.did)
    expect(p?.x).toBe(10)
  })

  it('expires positions at expires_at', () => {
    let t = 1_800_000_000_000
    const town = new Town({ server: 'testville', name: 'T', theme: '', palette: '', peers: [] }, { now: () => t, agentDelayMs: 0 })
    const a = makeConn()
    const ada = login(town, a, 'ada')
    town.handleFrame(a, { t: 'pos', pos: pos(ada.did, 1, 5, t + 5000) })
    expect(town.getPresence('#lobby').some((p) => p.did === ada.did)).toBe(true)
    t += 6000
    expect(town.getPresence('#lobby').some((p) => p.did === ada.did)).toBe(false)
  })
})

describe('agents (spec 10)', () => {
  it('agents are first-class members with did:key identities and agent_chain provenance', () => {
    const town = makeTown()
    const archivist = town.getAgents().find((a) => a.member.display_name === 'The Archivist')
    expect(archivist).toBeDefined()
    expect(archivist!.member.did.startsWith('did:key:z6Mk')).toBe(true)
    expect(archivist!.member.agent_chain?.length).toBeGreaterThanOrEqual(2)
    expect(archivist!.member.is_agent).toBe(true)
  })

  it('an agent replies to a mention with a signed message carrying provenance', async () => {
    vi.useFakeTimers()
    try {
      const town = makeTown()
      const a = makeConn()
      const ada = login(town, a, 'ada', '#archive')
      town.handleFrame(a, { t: 'msg', event: signedMsg(ada.kp, ada.did, '#archive', '@archivist what do you keep here?') })
      await vi.runAllTimersAsync()
      const reply = town.getLog('#archive').find((e) => e.kind === 'message' && e.event.provenance)
      expect(reply).toBeDefined()
      if (reply?.kind !== 'message') throw new Error('no agent reply')
      expect(reply.event.provenance!.agent_chain.length).toBeGreaterThanOrEqual(2)
      expect(reply.event.signature.length).toBeGreaterThan(10)
    } finally {
      vi.useRealTimers()
    }
  })

  it('agents obey channel membership: archivist never speaks in the vault (spec 10.5)', async () => {
    vi.useFakeTimers()
    try {
      const town = makeTown()
      const a = makeConn()
      const ada = login(town, a, 'ada', '#private-demo')
      town.handleFrame(a, { t: 'msg', event: signedMsg(ada.kp, ada.did, '#private-demo', '@archivist hello?') })
      await vi.runAllTimersAsync()
      const agentMsgs = town.getLog('#private-demo').filter((e) => e.kind === 'message' && e.event.provenance)
      expect(agentMsgs.length).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('encrypted channel opacity (spec 15, 24.4)', () => {
  it('stores only the ciphertext envelope for #private-demo — plaintext never touches the log', () => {
    const town = makeTown()
    const a = makeConn()
    const ada = login(town, a, 'ada', '#private-demo')
    const base = {
      id: crypto.randomUUID(),
      channel: '#private-demo',
      sender: ada.did,
      content: '',
      enc: { alg: 'aes-gcm' as const, iv: 'AAAA', ct: 'BBBBCCCC' },
      type: 'text' as const,
      ts: 1_800_000_000_000,
    }
    const event = { ...base, signature: signEvent(base, ada.kp.secretKey) }
    town.handleFrame(a, { t: 'msg', event })
    const stored = town.getLog('#private-demo').find((e) => e.kind === 'message')
    expect(stored).toBeDefined()
    if (stored?.kind !== 'message') throw new Error('missing')
    expect(stored.event.enc?.ct).toBe('BBBBCCCC')
    expect(stored.event.content).toBe('')
    expect(JSON.stringify(town.getLog('#private-demo'))).not.toContain('secret plans')
  })

  it('rejects plaintext messages to an encrypted channel', () => {
    const town = makeTown()
    const a = makeConn()
    const ada = login(town, a, 'ada', '#private-demo')
    town.handleFrame(a, { t: 'msg', event: signedMsg(ada.kp, ada.did, '#private-demo', 'accidental plaintext') })
    expect(JSON.stringify(town.getLog('#private-demo'))).not.toContain('accidental plaintext')
  })
})

describe('federation (spec 14)', () => {
  it('two towns relay #federation messages to each other preserving signature and origin', async () => {
    const townA = new Town({ server: 'town-a', name: 'A', theme: '', palette: '', peers: [{ server: 'town-b', url: '' }] }, { now: () => 1_800_000_000_000, agentDelayMs: 0 })
    const townB = new Town({ server: 'town-b', name: 'B', theme: '', palette: '', peers: [{ server: 'town-a', url: '' }] }, { now: () => 1_800_000_000_000, agentDelayMs: 0 })
    // wire them directly (transport-agnostic peering)
    townA.attachPeer('town-b', (e) => townB.receiveFederated('town-a', e))
    townB.attachPeer('town-a', (e) => townA.receiveFederated('town-b', e))

    const a = makeConn()
    const ada = login(townA, a, 'ada', '#federation')
    town: townA.handleFrame(a, { t: 'msg', event: signedMsg(ada.kp, ada.did, '#federation', 'hello from town a') })

    const onB = townB.getLog('#federation').find((e) => e.kind === 'message' && e.event.content === 'hello from town a')
    expect(onB).toBeDefined()
    if (onB?.kind !== 'message') throw new Error('missing')
    expect(onB.event.origin_server).toBe('town-a')
    expect(onB.event.sender).toBe(ada.did) // identity crosses servers intact
  })

  it('does not loop: relayed events are not re-forwarded', () => {
    const townA = new Town({ server: 'town-a', name: 'A', theme: '', palette: '', peers: [{ server: 'town-b', url: '' }] }, { now: () => 1, agentDelayMs: 0 })
    const townB = new Town({ server: 'town-b', name: 'B', theme: '', palette: '', peers: [{ server: 'town-a', url: '' }] }, { now: () => 1, agentDelayMs: 0 })
    let aToB = 0
    townA.attachPeer('town-b', (e) => { aToB++; townB.receiveFederated('town-a', e) })
    townB.attachPeer('town-a', (e) => townA.receiveFederated('town-b', e))
    const a = makeConn()
    const ada = login(townA, a, 'ada', '#federation')
    townA.handleFrame(a, { t: 'msg', event: signedMsg(ada.kp, ada.did, '#federation', 'once only') })
    expect(aToB).toBe(1)
    // B received it; B must not have sent it back to A as a new event
    expect(townA.getLog('#federation').filter((e) => e.kind === 'message' && e.event.content === 'once only').length).toBe(1)
  })

  it('drops federated events with invalid signatures', () => {
    const townB = new Town({ server: 'town-b', name: 'B', theme: '', palette: '', peers: [] }, { now: () => 1, agentDelayMs: 0 })
    const kp = generateKeypair()
    const did = didFromPublicKey(kp.publicKey)
    const base = { id: 'x1', channel: '#federation', sender: did, content: 'legit', type: 'text' as const, ts: 1 }
    const tampered: ChatMessage = { ...base, content: 'tampered', signature: signEvent(base, kp.secretKey), origin_server: 'town-a', edit_state: 'none', sender_name: 'x' }
    townB.receiveFederated('town-a', { kind: 'message', event: tampered })
    expect(townB.getLog('#federation').some((e) => e.kind === 'message' && e.event.content === 'tampered')).toBe(false)
  })
})
