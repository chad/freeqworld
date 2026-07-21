// Backend adapter: the world client speaking to a REAL freeq server
// (irc.freeq.at by default) via @freeq/sdk. Durable social state — channels,
// messages, reactions, membership, history — lives on the freeq server.
// Spatial presence rides ephemeral IRCv3 TAGMSGs that are relayed but never
// stored (spec §4.2/§7.4). Identity is the browser-held ed25519 did:key,
// authenticated for real via SASL ATPROTO-CHALLENGE method=crypto.

import { FreeqClient } from '@freeq/sdk'
import nacl from 'tweetnacl'
import type { ChatMessage, DurableEvent, MemberInfo, ServerFrame, WorldPosition } from '../../shared/src/protocol'
import { worldFromChannels, type ChannelEntry, type LiveWorld } from '../../shared/src/liveWorld'
import type { Identity } from './identity'
import { decodePosTag, encodePosTag, POS_TAG } from './posTag'
import { decodeTouchTag, encodeTouchTag, TOUCH_TAG } from './sparks'

export interface BackendOptions {
  serverUrl: string // wss://irc.freeq.at/irc
  channel: string
  identity: Identity | null
  avatarDid?: string
  /** first-time visitors spawn in an open room; gated homes are a discovery, not a doorstep */
  avoidGatedSpawn?: boolean
  onFrame: (frame: ServerFrame) => void
  onRawIn?: (frame: ServerFrame) => void
  onOpen?: (rttMs: number) => void
  onClose?: () => void
  onAuth?: (did: string) => void
  /** a real IRC direct message arrived (peer nick, text, timestamp) */
  onDm?: (fromNick: string, text: string, ts: number) => void
  /** a signed world-touch addressed to us arrived (spark exchange) */
  onTouch?: (fromNick: string, ts: number, sig: string, signerDid?: string) => void
  /** any world-touch between two OTHER people we witnessed (for introductions) */
  onTouchObserved?: (fromNick: string, toNick: string) => void
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
  private world: LiveWorld | null = null
  private listEntries: ChannelEntry[] = []
  private listTimer = 0
  private personalTargets: string[] = []
  private gateRules: string[] = []
  private gateCollecting: string | null = null

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
      channels: [], // joined after the world is generated from LIST
      onNickCollision: 'random-suffix',
      // OAuth-verified sessions authenticate as the real AT Protocol DID via
      // the broker's web-token; everyone else proves their device did:key
      sasl: id?.oauth
        ? {
            method: 'web-token',
            did: id.oauth.did,
            token: id.oauth.web_token,
            pdsUrl: id.oauth.pds_url,
          }
        : id
          ? {
              method: 'crypto',
              did: id.did,
              token: '',
              pdsUrl: '',
              signer: async (challenge: Uint8Array) => b64url(nacl.sign.detached(challenge, id.keypair.secretKey)),
            }
          : undefined,
      brokerUrl: id?.oauth?.broker_url,
      brokerToken: id?.oauth?.broker_token || undefined,
      skipInitialBrokerRefresh: Boolean(id?.oauth?.web_token),
    })

    this.client.on('authenticated', (did: string) => {
      this.authedDid = did
      opts.onAuth?.(did)
    })
    this.client.on('ready', () => {
      opts.onOpen?.(performance.now() - started)
      // the world is generated from the server's real channel list plus the
      // user's own recent channels (which LIST may hide, e.g. secret ones)
      this.listEntries = []
      this.client.requestHistoryTargets(60)
      this.client.raw('LIST')
      this.listTimer = window.setTimeout(() => this.onListComplete(), 5000)
    })
    this.client.on('historyTarget', (target: string) => {
      if (target.startsWith('#')) this.personalTargets.push(target)
    })
    this.client.on('channelListEntry', (entry: ChannelEntry) => {
      this.listEntries.push(entry)
    })
    this.client.on('channelListEnd', () => this.onListComplete())
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
      // resolve real DIDs for members the roster didn't include them for —
      // avatars derive from the DID, so this makes faces identical on every
      // client instance rather than falling back to nick-derived stand-ins
      const unresolved = members.filter((m) => !m.did && !this.client.getDidForNick(m.nick)).slice(0, 15)
      unresolved.forEach((m, i) => {
        window.setTimeout(() => this.client.whois(m.nick), 300 + i * 250)
      })
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
      if (msg.isSystem || !msg.text) return
      // DM threads are keyed by peer DID/nick, never '#…' — route to the DM handler
      if (!channel.startsWith('#') && !channel.startsWith('&')) {
        if (!msg.isSelf && channel !== 'server') this.opts.onDm?.(msg.from, msg.text, msg.timestamp?.getTime?.() ?? Date.now())
        return
      }
      if (channel !== this.channel) return
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
      if (!tracked || tracked.info.did === did) return
      // retire the nick-derived stand-in identity before introducing the real one
      this.emit({ t: 'member', channel: this.channel, member: tracked.info, online: false, silent: true })
      tracked.info = { ...tracked.info, did, verification_status: 'verified' }
      this.emit({ t: 'member', channel: this.channel, member: tracked.info, online: true, silent: true })
    })
    // ephemeral spatial presence + touch exchange in
    this.client.on('raw', (_line: string, parsed: { tags: Record<string, string>; prefix: string; command: string; params: string[] }) => {
      if (parsed.command !== 'TAGMSG') return
      const nickFrom = parsed.prefix.split('!')[0] ?? ''
      const touchValue = parsed.tags[TOUCH_TAG] ?? parsed.tags[TOUCH_TAG.slice(1)]
      if (touchValue && nickFrom && nickFrom !== this.client.nick) {
        const touch = decodeTouchTag(touchValue)
        if (touch && touch.toNick.toLowerCase() === this.client.nick.toLowerCase()) {
          this.opts.onTouch?.(nickFrom, touch.ts, touch.sig, touch.signerDid)
        } else if (touch) {
          this.opts.onTouchObserved?.(nickFrom, touch.toNick)
        }
      }
      const value = parsed.tags[POS_TAG] ?? parsed.tags[POS_TAG.slice(1)]
      if (!value) return
      const target = parsed.params[0]
      if (target !== this.channel) return
      const nick = nickFrom
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
    // channel policy gates (real freeq feature): surface the rules, let the
    // user accept, fall back to the liveliest public room meanwhile
    this.client.on('joinGateRequired', (channel: string) => {
      const pending = this.joinPending
      if (!pending || pending.channel !== channel) return
      window.clearTimeout(pending.timer)
      this.joinPending = null
      this.gateCollecting = channel
      this.gateRules = []
      this.client.raw(`POLICY ${channel} RULES`)
      window.setTimeout(() => {
        this.gateCollecting = null
        this.emit({ t: 'gate', channel, rules: this.gateRules })
      }, 700)
      const fallback = this.world?.directory.find((d) => d.channel !== channel && !d.unlisted)?.channel
      if (fallback) this.beginJoin(fallback, pending.isWelcome)
    })
    this.client.on('systemMessage', (_target: string, text: string) => {
      if (!this.gateCollecting || !text) return
      // only the POLICY RULES reply lines mention the gated channel
      if (text.includes(this.gateCollecting) && !/Cannot join/.test(text)) this.gateRules.push(text)
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
      nick,
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

  private onListComplete(): void {
    if (this.world) return
    window.clearTimeout(this.listTimer)
    const hostParts = this.host().split(':')[0]!.split('.')
    const home = hostParts.length >= 2 ? hostParts[hostParts.length - 2] : undefined
    this.world = worldFromChannels(this.listEntries, { home, extraChannels: this.personalTargets })
    // honor an explicitly requested channel; otherwise spawn where the server's life is —
    // but never drop a first-time visitor onto a policy gate
    let spawn = this.world.spawn
    if (this.opts.avoidGatedSpawn) {
      const open = this.world.directory.find((d) => !d.unlisted)
      if (open) spawn = open.channel
    }
    this.channel = this.channel || spawn
    this.beginJoin(this.channel, true)
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
    this.positions.clear()
    this.members.clear()
    this.channel = channel
    this.client.join(channel)
    this.client.requestHistory(channel)
    // if the server thinks we never left (no JOIN echo → no NAMES), ask for
    // the roster explicitly so the room never comes up empty
    window.setTimeout(() => {
      if (this.joinPending?.channel === channel && this.joinPending.members === null) {
        this.client.raw(`NAMES ${channel}`)
      }
    }, 1200)
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
          spawn_room: this.world?.spawn ?? pending.channel,
          palette: 'amber-cyan',
          music_pack: 'freeq-01',
          peers: [],
          directory: this.world?.directory ?? [],
          hidden_channels: this.world?.hidden ?? 0,
        },
        rooms: this.world?.rooms ?? [],
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

  /** User accepted a channel's policy gate: send the real POLICY ACCEPT, then enter. */
  acceptPolicy(channel: string): void {
    this.client.raw(`POLICY ${channel} ACCEPT`)
    // leave the fallback room properly — staying silently joined means a later
    // return gets no JOIN echo / NAMES and the roster would come up empty
    if (this.channel && this.channel !== channel) this.client.part(this.channel)
    window.setTimeout(() => this.beginJoin(channel, false), 300)
  }

  /** Real IRC direct message (PRIVMSG to a nick) — works with any client on the server. */
  sendDm(nick: string, text: string): void {
    this.client.sendMessage(nick, text)
  }

  /** Broadcast a signed touch (spark autograph) addressed to a nick in the room. */
  sendTouch(channel: string, toNick: string, ts: number, sig: string, signerDid?: string): void {
    this.client.sendTagmsg(channel, { [TOUCH_TAG]: encodeTouchTag(toNick, ts, sig, signerDid) })
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
