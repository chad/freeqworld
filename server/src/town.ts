// Town: one Freeq server instance (spec §7.1, §22).
// Transport-agnostic core — the WS/HTTP shell in main.ts feeds frames in.
// Durable events (messages, reactions, actions) land in per-channel logs;
// WorldPosition presence is ephemeral, LWW, expiring, and never logged.

import { computeMusicState } from '../../shared/src/music'
import type {
  ChatMessage,
  ClientFrame,
  DurableEvent,
  MemberInfo,
  Reaction,
  RoomManifest,
  ServerFrame,
  StructuredAction,
  TownProfile,
  WorldPosition,
} from '../../shared/src/protocol'
import { didFromPublicKey, keypairFromSeed, signEvent, verifyEvent, type Keypair } from '../../shared/src/signing'
import { LAUNCH_ROOMS } from '../../shared/src/world'
import { agentSeed, createAgents, type AgentDef } from './agents'

export interface Connection {
  send(frame: ServerFrame): void
  close(): void
}

export interface TownConfig {
  server: string
  name: string
  theme: string
  palette: string
  peers: { server: string; url: string }[]
}

interface ConnState {
  did: string
  handle: string
  display_name: string
  channel: string
  client_instance: string
  verification_status: 'verified' | 'unverified'
  avatar_did?: string
  spectator: boolean
}

interface ChannelState {
  log: DurableEvent[]
  seenIds: Set<string>
  presence: Map<string, WorldPosition>
  conns: Set<Connection>
}

const FEDERATED_CHANNELS = new Set(['#federation'])
const RATE_CAPACITY = 20
const RATE_REFILL_PER_SEC = 1

export class Town {
  readonly config: TownConfig
  private readonly now: () => number
  private readonly agentDelayMs: number
  private readonly channels = new Map<string, ChannelState>()
  private readonly connState = new Map<Connection, ConnState>()
  private readonly agents: AgentDef[]
  private readonly operator: Keypair
  private readonly operatorDid: string
  private readonly buckets = new Map<string, { tokens: number; last: number }>()
  private readonly peerSends = new Map<string, (e: DurableEvent) => void>()

  constructor(config: TownConfig, opts?: { now?: () => number; agentDelayMs?: number }) {
    this.config = config
    this.now = opts?.now ?? (() => Date.now())
    this.agentDelayMs = opts?.agentDelayMs ?? 900
    for (const room of LAUNCH_ROOMS) {
      this.channels.set(room.channel, { log: [], seenIds: new Set(), presence: new Map(), conns: new Set() })
    }
    this.operator = keypairFromSeed(agentSeed(`${this.config.server}/operator`))
    this.operatorDid = didFromPublicKey(this.operator.publicKey)
    this.agents = createAgents(this.config.server, this.operatorDid)
    this.seedHistory()
  }

  /** Real signed events from the town's own agents so the plaza is alive on first load (spec §25.1). */
  private seedHistory(): void {
    const say = (handle: string, channel: string, content: string, tsOffset: number) => {
      const agent = this.agents.find((a) => a.member.handle === handle)
      if (!agent) return
      const base = {
        id: `seed-${handle}-${tsOffset}`,
        channel,
        sender: agent.member.did,
        content,
        type: 'text' as const,
        ts: this.now() - tsOffset,
        provenance: { spawned_by: this.operatorDid, agent_chain: agent.member.agent_chain! },
      }
      const event: ChatMessage = {
        ...base,
        sender_name: agent.member.display_name,
        origin_server: this.config.server,
        edit_state: 'none',
        signature: signEvent(base, agent.keypair.secretKey),
      }
      this.appendDurable(channel, { kind: 'message', event })
    }
    say('cartographer', '#lobby', `Welcome to ${this.config.name}. Every room here is a real Freeq channel — this plaza is #lobby. Walk east for the Workshop, north for Federation Station.`, 540_000)
    say('packet', '#lobby', '*beep* Signed envelopes only. Your DID is your passport and it works in every town.', 360_000)
    say('archivist', '#lobby', 'I remember everything said in these halls — every message is a signed, durable event. Mention @archivist and ask.', 180_000)
    say('archivist', '#archive', 'The stacks are open. Ask me to search anything ever said here.', 300_000)
    say('composer', '#music', 'The room is listening. The soundtrack follows the conversation — energy, tension, density, brightness.', 240_000)
    say('packet', '#federation', 'Portals north lead to the peer town. Your identity travels with you; your avatar is derived from your DID, not from this server.', 200_000)
  }

  // ---------- introspection ----------

  getLog(channel: string): DurableEvent[] {
    return this.channels.get(channel)?.log ?? []
  }

  getPresence(channel: string): WorldPosition[] {
    const ch = this.channels.get(channel)
    if (!ch) return []
    const now = this.now()
    for (const [did, p] of ch.presence) if (p.expires_at <= now) ch.presence.delete(did)
    return [...ch.presence.values()]
  }

  getAgents(): AgentDef[] {
    return this.agents
  }

  townProfile(): TownProfile {
    return {
      schema: 'freeq.at/world/server-profile/v1',
      server: this.config.server,
      name: this.config.name,
      theme: this.config.theme,
      spawn_room: '#lobby',
      palette: this.config.palette,
      music_pack: `${this.config.server}-01`,
      peers: this.config.peers,
    }
  }

  rooms(): RoomManifest[] {
    // resolve the 'peer' placeholder on federation exits to the first configured peer
    const peer = this.config.peers[0]
    return LAUNCH_ROOMS.map((r) => ({
      ...r,
      exits: r.exits.map((e) =>
        e.remote_server === 'peer' && peer ? { ...e, remote_server: peer.server, remote_url: peer.url, label: `Portal to ${peer.server}` } : e,
      ).filter((e) => !(e.remote_server === 'peer' && !peer)),
    }))
  }

  private membersOf(channel: string): MemberInfo[] {
    const online: MemberInfo[] = []
    for (const [conn, st] of this.connState) {
      void conn
      if (st.channel === channel && !st.spectator) {
        online.push({
          did: st.did,
          handle: st.handle,
          display_name: st.display_name,
          verification_status: st.verification_status,
          is_agent: false,
          avatar_did: st.avatar_did,
        })
      }
    }
    for (const agent of this.agents) {
      if (agent.channels.includes(channel)) online.push(agent.member)
    }
    return online
  }

  // ---------- frame handling ----------

  handleFrame(conn: Connection, frame: ClientFrame): void {
    switch (frame.t) {
      case 'hello': return this.onHello(conn, frame)
      case 'join': return this.onJoin(conn, frame.channel)
      case 'msg': return this.onDurable(conn, { kind: 'message', event: this.completeMessage(frame.event) })
      case 'react': return this.onDurable(conn, { kind: 'reaction', event: { ...frame.event, origin_server: this.config.server } })
      case 'act': return this.onDurable(conn, { kind: 'action', event: { ...frame.event, origin_server: this.config.server } })
      case 'pos': return this.onPos(conn, frame.pos)
    }
  }

  disconnect(conn: Connection): void {
    const st = this.connState.get(conn)
    if (!st) return
    const ch = this.channels.get(st.channel)
    ch?.conns.delete(conn)
    ch?.presence.delete(st.did)
    this.connState.delete(conn)
    if (ch) {
      this.broadcast(st.channel, {
        t: 'member',
        channel: st.channel,
        member: { did: st.did, handle: st.handle, display_name: st.display_name, verification_status: st.verification_status, is_agent: false },
        online: false,
      })
    }
  }

  private onHello(conn: Connection, frame: Extract<ClientFrame, { t: 'hello' }>): void {
    const channel = this.channels.has(frame.channel) ? frame.channel : '#lobby'
    const st: ConnState = {
      did: frame.did,
      handle: frame.handle,
      display_name: frame.display_name || frame.handle,
      channel,
      client_instance: frame.client_instance,
      verification_status: frame.did.startsWith('did:key:') ? 'verified' : 'unverified',
      avatar_did: frame.avatar_did,
      spectator: frame.spectator ?? false,
    }
    this.connState.set(conn, st)
    const ch = this.channels.get(channel)!
    ch.conns.add(conn)
    conn.send({
      t: 'welcome',
      town: this.townProfile(),
      rooms: this.rooms(),
      history: ch.log.slice(-100),
      members: this.membersOf(channel),
      channel,
    })
    if (st.spectator) return
    this.broadcast(channel, {
      t: 'member',
      channel,
      member: { did: st.did, handle: st.handle, display_name: st.display_name, verification_status: st.verification_status, is_agent: false, avatar_did: st.avatar_did },
      online: true,
    }, conn)
  }

  private onJoin(conn: Connection, channel: string): void {
    const st = this.connState.get(conn)
    if (!st || !this.channels.has(channel)) return
    const oldCh = this.channels.get(st.channel)!
    oldCh.conns.delete(conn)
    oldCh.presence.delete(st.did)
    this.broadcast(st.channel, {
      t: 'member',
      channel: st.channel,
      member: { did: st.did, handle: st.handle, display_name: st.display_name, verification_status: st.verification_status, is_agent: false },
      online: false,
    })
    st.channel = channel
    const ch = this.channels.get(channel)!
    ch.conns.add(conn)
    conn.send({ t: 'joined', channel, history: ch.log.slice(-100), members: this.membersOf(channel) })
    this.broadcast(channel, {
      t: 'member',
      channel,
      member: { did: st.did, handle: st.handle, display_name: st.display_name, verification_status: st.verification_status, is_agent: false },
      online: true,
    }, conn)
  }

  private completeMessage(event: Extract<ClientFrame, { t: 'msg' }>['event']): ChatMessage {
    const st = [...this.connState.values()].find((s) => s.did === event.sender)
    return {
      ...event,
      sender_name: event.sender_name ?? st?.display_name ?? event.sender.slice(0, 16),
      origin_server: this.config.server,
      edit_state: 'none',
    }
  }

  private signedBase(durable: DurableEvent): object {
    const { kind, event } = durable
    if (kind === 'message') {
      const { signature, origin_server, edit_state, sender_name, ...base } = event
      void signature; void origin_server; void edit_state; void sender_name
      return base
    }
    const { signature, origin_server, ...base } = event as Reaction | StructuredAction
    void signature; void origin_server
    return base
  }

  private signerOf(durable: DurableEvent): string {
    return durable.kind === 'reaction' ? durable.event.actor : durable.kind === 'action' ? durable.event.actor : durable.event.sender
  }

  private allowRate(did: string): boolean {
    const now = this.now()
    const bucket = this.buckets.get(did) ?? { tokens: RATE_CAPACITY, last: now }
    bucket.tokens = Math.min(RATE_CAPACITY, bucket.tokens + ((now - bucket.last) / 1000) * RATE_REFILL_PER_SEC)
    bucket.last = now
    if (bucket.tokens < 1) {
      this.buckets.set(did, bucket)
      return false
    }
    bucket.tokens -= 1
    this.buckets.set(did, bucket)
    return true
  }

  private onDurable(conn: Connection, durable: DurableEvent): void {
    const channel = durable.event.channel
    const ch = this.channels.get(channel)
    if (!ch) return conn.send({ t: 'error', message: `no such channel ${channel}` })
    if (this.connState.get(conn)?.spectator) {
      return conn.send({ t: 'error', message: 'read-only guest mode: log in to speak' })
    }
    const signer = this.signerOf(durable)

    if (!this.allowRate(signer)) {
      return conn.send({ t: 'error', message: 'rate limit exceeded — slow down' })
    }
    if (!verifyEvent(this.signedBase(durable), durable.event.signature, signer)) {
      return conn.send({ t: 'error', message: 'signature verification failed' })
    }
    if (durable.kind === 'message') {
      const room = LAUNCH_ROOMS.find((r) => r.channel === channel)
      if (room?.encrypted && (!durable.event.enc || durable.event.content !== '')) {
        return conn.send({ t: 'error', message: 'this channel is encrypted: plaintext refused' })
      }
    }
    this.appendDurable(channel, durable)
    if (FEDERATED_CHANNELS.has(channel) && durable.event.origin_server === this.config.server) {
      for (const send of this.peerSends.values()) send(durable)
    }
    if (durable.kind === 'message') this.maybeAgentReply(channel, durable.event)
    this.broadcastMusic(channel)
  }

  private appendDurable(channel: string, durable: DurableEvent): void {
    const ch = this.channels.get(channel)
    if (!ch || ch.seenIds.has(durable.event.id)) return
    ch.seenIds.add(durable.event.id)
    ch.log.push(durable)
    this.broadcast(channel, { t: 'event', channel, durable })
  }

  private onPos(conn: Connection, pos: WorldPosition): void {
    const st = this.connState.get(conn)
    if (!st || pos.did !== st.did || st.spectator) return
    const ch = this.channels.get(pos.channel)
    if (!ch) return
    const existing = ch.presence.get(pos.did)
    // last-write-wins ordered by (client_instance, sequence) — spec §7.4
    if (existing && existing.client_instance === pos.client_instance && existing.sequence >= pos.sequence) return
    if (pos.expires_at <= this.now()) return
    ch.presence.set(pos.did, pos)
  }

  /** Called by the shell on a timer: coalesced presence delivery (spec §7.4). */
  flushPresence(): void {
    for (const [name, ch] of this.channels) {
      if (ch.conns.size === 0) continue
      const positions = this.getPresence(name)
      const frame: ServerFrame = { t: 'presence', channel: name, positions }
      for (const conn of ch.conns) conn.send(frame)
    }
  }

  private broadcast(channel: string, frame: ServerFrame, except?: Connection): void {
    const ch = this.channels.get(channel)
    if (!ch) return
    for (const conn of ch.conns) if (conn !== except) conn.send(frame)
  }

  private broadcastMusic(channel: string): void {
    const room = LAUNCH_ROOMS.find((r) => r.channel === channel)
    const ch = this.channels.get(channel)
    if (!room || !ch) return
    const recentMessages = ch.log
      .filter((e): e is Extract<DurableEvent, { kind: 'message' }> => e.kind === 'message')
      .slice(-30)
      .map((e) => ({ ts: e.event.ts, content: e.event.enc ? '' : e.event.content }))
    const state = computeMusicState({
      recentMessages,
      participantCount: this.membersOf(channel).length,
      now: this.now(),
      activityOnly: !room.music.topic_adaptation,
    })
    this.broadcast(channel, { t: 'music', channel, state })
  }

  // ---------- agents ----------

  private maybeAgentReply(channel: string, msg: ChatMessage): void {
    if (msg.provenance) return // agents do not reply to agents
    for (const agent of this.agents) {
      if (!agent.channels.includes(channel)) continue // membership boundary, spec §10.5
      const reply = agent.brain({
        channel,
        content: msg.enc ? '' : msg.content,
        senderName: msg.sender_name,
        searchHistory: (term) => this.searchHistory(channel, term, msg.id),
        roomNames: () => LAUNCH_ROOMS.map((r) => ({ channel: r.channel, name: r.name, topic: r.topic })),
        peerNames: () => this.config.peers.map((p) => p.server),
        townName: this.config.name,
      })
      if (!reply) continue
      setTimeout(() => {
        const base = {
          id: crypto.randomUUID(),
          channel,
          sender: agent.member.did,
          content: reply,
          type: 'text' as const,
          ts: this.now(),
          provenance: { spawned_by: this.operatorDid, agent_chain: agent.member.agent_chain! },
        }
        const event: ChatMessage = {
          ...base,
          sender_name: agent.member.display_name,
          origin_server: this.config.server,
          edit_state: 'none',
          signature: signEvent(base, agent.keypair.secretKey),
        }
        this.appendDurable(channel, { kind: 'message', event })
        this.broadcastMusic(channel)
      }, this.agentDelayMs)
    }
  }

  private searchHistory(channel: string, term: string, excludeId: string): { sender_name: string; content: string; ts: number }[] {
    const lower = term.toLowerCase()
    const out: { sender_name: string; content: string; ts: number }[] = []
    for (const e of this.channels.get(channel)?.log ?? []) {
      if (e.kind !== 'message' || e.event.id === excludeId || e.event.enc) continue
      if (e.event.content.toLowerCase().includes(lower)) {
        out.push({ sender_name: e.event.sender_name, content: e.event.content, ts: e.event.ts })
      }
    }
    return out.reverse()
  }

  // ---------- federation ----------

  attachPeer(server: string, send: (e: DurableEvent) => void): void {
    this.peerSends.set(server, send)
  }

  receiveFederated(fromServer: string, durable: DurableEvent): void {
    const channel = durable.event.channel
    if (!FEDERATED_CHANNELS.has(channel)) return
    if (!verifyEvent(this.signedBase(durable), durable.event.signature, this.signerOf(durable))) return
    // keep the original origin; never re-forward (loop prevention)
    void fromServer
    this.appendDurable(channel, durable)
  }
}
