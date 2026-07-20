// Backend adapter: the world client speaking to a REAL freeq server
// (irc.freeq.at by default) via @freeq/sdk. Durable social state — channels,
// messages, reactions, membership, history — lives on the freeq server.
// Spatial presence rides ephemeral IRCv3 TAGMSGs that are relayed but never
// stored (spec §4.2/§7.4). Identity is the browser-held ed25519 did:key,
// authenticated for real via SASL ATPROTO-CHALLENGE method=crypto.

import { FreeqClient } from '@freeq/sdk'
import nacl from 'tweetnacl'
import type { ChatMessage, DurableEvent, MemberInfo, ServerFrame, WorldPosition } from '../../shared/src/protocol'
import { LAUNCH_ROOMS, roomFor } from '../../shared/src/world'
import type { Identity } from './identity'
import { decodePosTag, encodePosTag, POS_TAG } from './posTag'

export interface BackendOptions {
  serverUrl: string // wss://irc.freeq.at/irc
  channel: string
  identity: Identity | null
  avatarDid?: string
  onFrame: (frame: ServerFrame) => void
  onRawIn?: (frame: ServerFrame) => void
  onOpen?: (rttMs: number) => void
  onClose?: () => void
  onAuth?: (did: string) => void
}

interface TrackedMember {
  nick: string
  info: MemberInfo
}

function b64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function ircNick(name: string): string {
  const clean = name.replace(/[^A-Za-z0-9_\-\[\]{}^`|]/g, '').slice(0, 24)
  return /^[A-Za-z]/.test(clean) ? clean : `w${clean}`
}

/** Stable pseudo-DID for guests whose real DID is unknown: same nick, same avatar. */
function nickDid(nick: string): string {
  return `did:freeq:nick:${nick.toLowerCase()}`
}

const VAULT_PASSPHRASE = 'freeq-vault-demo'

export class FreeqBackend {
  readonly serverUrl: string
  readonly kind = 'freeq' as const
  private client: FreeqClient
  private opts: BackendOptions
  private channel: string
  private members = new Map<string, TrackedMember>() // nick -> member
  private positions = new Map<string, WorldPosition>() // nick -> pos
  private seq = 0
  private lastPosSent = 0
  private presenceTimer: number
  private joinPending: { channel: string; members: MemberInfo[] | null; history: DurableEvent[] | null; timer: number; isWelcome: boolean } | null = null
  private authedDid: string | null = null
  private closed = false

  constructor(opts: BackendOptions) {
    this.opts = opts
    this.serverUrl = opts.serverUrl
    this.channel = opts.channel
    const started = performance.now()
    const id = opts.identity
    const nick = ircNick(id?.display_name ?? `guest${Math.floor(Math.random() * 9000 + 1000)}`)

    this.client = new FreeqClient({
      url: opts.serverUrl,
      nick,
      channels: [opts.channel],
      onNickCollision: 'random-suffix',
      sasl: id
        ? {
            method: 'crypto',
            did: id.did,
            token: '',
            pdsUrl: '',
            signer: async (challenge: Uint8Array) => b64url(nacl.sign.detached(challenge, id.keypair.secretKey)),
          }
        : undefined,
    })

    this.client.on('authenticated', (did: string) => {
      this.authedDid = did
      opts.onAuth?.(did)
    })
    this.client.on('ready', () => {
      opts.onOpen?.(performance.now() - started)
      this.beginJoin(this.channel, true)
    })
    this.client.on('channelJoined', (channel: string) => {
      if (channel !== this.channel) return
      this.client.requestHistory(channel)
    })
    this.client.on('membersSync', (channel: string, members) => {
      if (channel !== this.channel) return
      const infos: MemberInfo[] = []
      this.members.clear()
      for (const m of members) {
        const info = this.memberInfo(m.nick, m)
        this.members.set(m.nick, { nick: m.nick, info })
        infos.push(info)
      }
      if (this.joinPending?.channel === channel) {
        this.joinPending.members = infos
        this.maybeFinishJoin()
      }
    })
    this.client.on('historyBatch', (channel: string, messages) => {
      if (channel !== this.channel) return
      const durables = messages.filter((m) => !m.isSystem && m.text).map((m) => ({ kind: 'message' as const, event: this.toChatMessage(channel, m) }))
      if (this.joinPending?.channel === channel) {
        this.joinPending.history = durables
        this.maybeFinishJoin()
      }
    })
    this.client.on('message', (channel: string, msg) => {
      if (channel !== this.channel || msg.isSystem || !msg.text) return
      if (this.joinPending) return // history will cover it
      this.emit({ t: 'event', channel, durable: { kind: 'message', event: this.toChatMessage(channel, msg) } })
    })
    this.client.on('reactionAdded', (channel: string, msgId: string, emoji: string, fromNick: string) => {
      if (channel !== this.channel) return
      this.emit({
        t: 'event',
        channel,
        durable: {
          kind: 'reaction',
          event: {
            id: `${msgId}:${emoji}:${fromNick}`,
            channel,
            actor: this.didFor(fromNick),
            target_message: msgId,
            reaction: emoji,
            ts: Date.now(),
            origin_server: this.host(),
            signature: '',
          },
        },
      })
    })
    this.client.on('memberJoined', (channel: string, m) => {
      if (channel !== this.channel || this.members.has(m.nick)) return
      const info = this.memberInfo(m.nick, m)
      this.members.set(m.nick, { nick: m.nick, info })
      this.emit({ t: 'member', channel, member: info, online: true })
    })
    const drop = (nick: string) => {
      const tracked = this.members.get(nick)
      if (!tracked) return
      this.members.delete(nick)
      this.positions.delete(nick)
      this.emit({ t: 'member', channel: this.channel, member: tracked.info, online: false })
    }
    this.client.on('memberLeft', (channel: string, nick: string) => {
      if (channel === this.channel) drop(nick)
    })
    this.client.on('userQuit', (nick: string) => drop(nick))
    this.client.on('memberDid', (nick: string, did: string) => {
      const tracked = this.members.get(nick)
      if (!tracked) return
      tracked.info = { ...tracked.info, did, verification_status: 'verified' }
      this.emit({ t: 'member', channel: this.channel, member: tracked.info, online: true })
    })
    // ephemeral spatial presence in
    this.client.on('raw', (_line: string, parsed: { tags: Record<string, string>; prefix: string; command: string; params: string[] }) => {
      if (parsed.command !== 'TAGMSG') return
      const value = parsed.tags[POS_TAG] ?? parsed.tags[POS_TAG.slice(1)]
      if (!value) return
      const target = parsed.params[0]
      if (target !== this.channel) return
      const nick = parsed.prefix.split('!')[0] ?? ''
      if (!nick || nick === this.client.nick) return
      const pos = decodePosTag(value)
      if (!pos) return
      this.positions.set(nick, {
        type: 'freeq.at/presence/world-position/v1',
        channel: this.channel,
        did: this.didFor(nick),
        x: pos.x,
        y: pos.y,
        facing: pos.facing,
        animation: pos.animation,
        client_instance: nick,
        sequence: pos.sequence,
        expires_at: Date.now() + 8000,
      })
    })
    this.client.on('disconnected', () => {
      if (!this.closed) this.opts.onClose?.()
    })

    this.presenceTimer = window.setInterval(() => {
      const now = Date.now()
      for (const [nick, pos] of this.positions) if (pos.expires_at <= now) this.positions.delete(nick)
      this.emit({ t: 'presence', channel: this.channel, positions: [...this.positions.values()] })
    }, 250)

    this.client.connect()
  }

  private host(): string {
    try {
      return new URL(this.serverUrl.replace(/^ws/, 'http')).host
    } catch {
      return this.serverUrl
    }
  }

  get nick(): string {
    return this.client.nick
  }

  private emit(frame: ServerFrame): void {
    this.opts.onRawIn?.(frame)
    this.opts.onFrame(frame)
  }

  private memberInfo(nick: string, m: { did?: string; handle?: string; displayName?: string; actorClass?: string }): MemberInfo {
    const isSelf = nick === this.client.nick
    const did = m.did ?? this.client.getDidForNick?.(nick) ?? (isSelf && this.authedDid ? this.authedDid : nickDid(nick))
    return {
      did,
      handle: m.handle ?? `${nick}@${this.host()}`,
      display_name: m.displayName ?? nick,
      verification_status: did.startsWith('did:key:') || did.startsWith('did:plc:') ? 'verified' : 'unverified',
      is_agent: m.actorClass === 'agent' || m.actorClass === 'external_agent',
      avatar_did: isSelf ? this.opts.avatarDid : undefined,
    }
  }

  private didFor(nick: string): string {
    if (nick === this.client.nick && this.opts.identity) return this.opts.identity.did
    return this.members.get(nick)?.info.did ?? nickDid(nick)
  }

  private toChatMessage(channel: string, m: { id: string; from: string; text: string; timestamp: Date; tags: Record<string, string>; encrypted?: boolean }): ChatMessage {
    const fromAgent = this.members.get(m.from)?.info.is_agent ?? false
    return {
      id: m.id || crypto.randomUUID(),
      channel,
      sender: this.didFor(m.from),
      sender_name: m.from,
      content: m.text,
      type: 'text',
      ts: m.timestamp?.getTime?.() ?? Date.now(),
      edit_state: 'none',
      origin_server: this.host(),
      provenance: fromAgent ? { spawned_by: 'server', agent_chain: [this.didFor(m.from)] } : undefined,
      signature: m.tags?.['msgid'] ? `relay:${m.tags['msgid']}` : '',
      enc: m.encrypted ? { alg: 'aes-gcm', iv: 'sdk', ct: 'sdk' } : undefined,
    }
  }

  private beginJoin(channel: string, isWelcome: boolean): void {
    if (this.joinPending) window.clearTimeout(this.joinPending.timer)
    this.joinPending = {
      channel,
      members: null,
      history: null,
      isWelcome,
      timer: window.setTimeout(() => this.finishJoin(), 2500),
    }
    if (!isWelcome) {
      this.positions.clear()
      this.members.clear()
      this.channel = channel
      const room = roomFor(channel)
      if (room.encrypted) void this.client.setChannelEncryption(channel, VAULT_PASSPHRASE)
      this.client.join(channel)
      this.client.requestHistory(channel)
    } else {
      const room = roomFor(channel)
      if (room.encrypted) void this.client.setChannelEncryption(channel, VAULT_PASSPHRASE)
      this.client.requestHistory(channel)
    }
  }

  private maybeFinishJoin(): void {
    if (this.joinPending?.members && this.joinPending.history) this.finishJoin()
  }

  private finishJoin(): void {
    const pending = this.joinPending
    if (!pending) return
    window.clearTimeout(pending.timer)
    this.joinPending = null
    const members = pending.members ?? [...this.members.values()].map((t) => t.info)
    const history = (pending.history ?? []).sort((a, b) => a.event.ts - b.event.ts)
    if (pending.isWelcome) {
      this.emit({
        t: 'welcome',
        town: {
          schema: 'freeq.at/world/server-profile/v1',
          server: this.host(),
          name: this.host() === 'irc.freeq.at' ? 'Freeq' : this.host(),
          theme: 'network-noir',
          spawn_room: '#lobby',
          palette: 'amber-cyan',
          music_pack: 'freeq-01',
          peers: [],
        },
        rooms: LAUNCH_ROOMS.map((r) => ({ ...r, exits: r.exits.filter((e) => !e.remote_server) })),
        history,
        members,
        channel: pending.channel,
      })
    } else {
      this.emit({ t: 'joined', channel: pending.channel, history, members })
    }
  }

  // ---- outbound (same surface as TownConnection) ----

  join(channel: string): void {
    if (channel === this.channel) return
    this.client.part(this.channel)
    this.beginJoin(channel, false)
  }

  sendMessage(channel: string, content: string): void {
    this.client.sendMessage(channel, content)
  }

  sendReaction(channel: string, targetMessage: string, reaction: string): void {
    this.client.sendReaction(channel, reaction, targetMessage)
  }

  sendPosition(channel: string, x: number, y: number, facing: WorldPosition['facing'], animation: WorldPosition['animation']): void {
    const now = Date.now()
    if (now - this.lastPosSent < 300) return // be polite to the public server
    this.lastPosSent = now
    this.client.sendTagmsg(channel, { [POS_TAG]: encodePosTag({ x, y, facing, animation, sequence: ++this.seq }) })
  }

  close(): void {
    this.closed = true
    window.clearInterval(this.presenceTimer)
    try {
      this.client.disconnect()
    } catch {
      /* already closed */
    }
  }
}
