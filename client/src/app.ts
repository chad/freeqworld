// FreeqWorld client application: world state, canvas renderer, input, UI.
// The world is a projection — every social fact on screen came from a
// Freeq frame; the renderer holds no social state of its own (spec §4.2).

import type { DurableEvent, MemberInfo, RoomManifest, ServerFrame, TownProfile, WorldPosition } from '../../shared/src/protocol'
import { verifyEvent } from '../../shared/src/signing'
import { generateTilemap, isWalkable, roomFor, TILE, type Tilemap } from '../../shared/src/world'
import { seededPrng } from '../../shared/src/hkdf'
import type { MusicState } from '../../shared/src/music'
import { ChiptuneEngine } from './audio'
import { FreeqBackend } from './freeqBackend'
import { avatarDid, createIdentity, loadIdentity, type Identity } from './identity'
import { TownConnection } from './net'
import { drawPreview, spriteFor, type SpriteSet } from './sprites'
import { explorerTitle, Journal, shouldRekindle } from './journal'
import { consumeOAuthReturn, startOAuth } from './identity'
import { signTouch, SparkBook, titleFor, verifyTouch } from './sparks'
import { wrapBubble } from './textwrap'
import { decryptMessage, deriveRoomKey, encryptMessage, type CipherEnvelope } from './vaultCrypto'
import { familiarFor, imageUrlsIn, threadsOf, type ThreadPlace } from './worldExtras'

const TILE_PX = 8
const VIEW_W = 320
const VIEW_H = 180
const WALK_SPEED = 6 // tiles/sec
const POS_SEND_MS = 100 // ≤10 updates/sec (spec §7.4)

interface RemotePlayer {
  did: string
  x: number
  y: number
  tx: number
  ty: number
  facing: WorldPosition['facing']
  animation: WorldPosition['animation']
}

interface Bubble {
  did: string
  lines: string[]
  until: number
  kind: 'text' | 'code' | 'sealed'
}

interface Emote {
  did: string
  emoji: string
  until: number
}

const TEMPLATE_PALETTES: Record<string, { floor: string; wall: string; rug: string; decor: string; glow: string }> = {
  plaza: { floor: '#262635', wall: '#45455e', rug: '#33334a', decor: '#6b6b8a', glow: '#ffd166' },
  workshop: { floor: '#2b2318', wall: '#54422a', rug: '#3a2f1f', decor: '#8a6a3a', glow: '#ffb454' },
  laboratory: { floor: '#16262a', wall: '#2e4d55', rug: '#1e3439', decor: '#4a7d8a', glow: '#56c9d6' },
  club: { floor: '#1c1224', wall: '#3a2454', rug: '#2a1a3a', decor: '#5a3a80', glow: '#e055c0' },
  library: { floor: '#241c14', wall: '#4a3a24', rug: '#332a1a', decor: '#7a5c33', glow: '#e8d9a0' },
  vault: { floor: '#101622', wall: '#2a3a5e', rug: '#182238', decor: '#3a4d75', glow: '#56c9d6' },
  'train car': { floor: '#1e242a', wall: '#3e4c58', rug: '#2a323a', decor: '#5c7080', glow: '#67c26b' },
}

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T
}

export class App {
  private identity: Identity | null = null
  private conn: TownConnection | FreeqBackend | null = null
  private town: TownProfile | null = null
  private rooms = new Map<string, RoomManifest>()
  private channel = '' // '' = spawn wherever the server's world says
  private map: Tilemap | null = null
  private members = new Map<string, MemberInfo>()
  private remotes = new Map<string, RemotePlayer>()
  private bubbles: Bubble[] = []
  private emotes: Emote[] = []
  private log: DurableEvent[] = []
  private lastMessageId: string | null = null
  private me = { x: 10, y: 10, facing: 'south' as WorldPosition['facing'], moving: false }
  private jumpUntil = 0
  private remoteJumps = new Map<string, number>() // did -> jump start ms
  private moveTarget: { x: number; y: number } | null = null
  private keys = new Set<string>()
  private lastPosSent = 0
  private lastFrameTime = performance.now()
  private walkPhase = 0
  private audio = new ChiptuneEngine()
  private vaultKey: CryptoKey | null = null
  private vaultPlain = new Map<string, string>() // message id -> decrypted content
  private inspectorFrames: { dir: 'in' | 'out'; summary: string; ok: boolean | null }[] = []
  private rtt = 0
  private pendingTravel: { server: string; url: string } | null = null
  private travelUrl: string | null = null
  private dmThreads = new Map<string, { from: string; text: string; self: boolean; ts: number }[]>()
  private activeDm: string | null = null
  private sparks = new SparkBook()
  private journal = new Journal()
  private touchCooldown = new Map<string, number>()
  private lastTouchScan = 0
  private footsteps: { x: number; y: number; until: number }[] = []
  private lastFootstep = new Map<string, number>()
  private wornPaths = new Map<string, Map<number, number>>() // channel -> tileIdx -> heat
  private observedTouches = new Map<string, number>() // "a>b" -> ts
  private critter: { x: number; y: number; vx: number; vy: number; kind: number; nextTurn: number } | null = null
  private threadPlaces: (ThreadPlace & { x: number; y: number })[] = []
  private activeThread: string | null = null
  private typingNicks = new Map<string, number>() // nick -> expires
  private awayNicks = new Set<string>()
  private lastTypingSent = 0
  private galleryImages = new Map<string, HTMLImageElement>() // url -> loaded image
  private galleryWall: { url: string; x: number; y: number; from: string }[] = []
  private trails = new Map<string, { x: number; y: number }[]>() // did -> recent positions (for familiars)
  private lastEnsemble = 0
  private canvas = el<HTMLCanvasElement>('world')
  private ctx = this.canvas.getContext('2d')!
  private spriteSets = new Map<string, SpriteSet>()

  start(): void {
    this.canvas.width = VIEW_W
    this.canvas.height = VIEW_H
    this.fitCanvas()
    this.updateSparkHud()
    window.addEventListener('resize', () => this.fitCanvas())
    this.bindUi()
    // returning from the broker's OAuth redirect? consume the result first
    const oauthIdentity = consumeOAuthReturn()
    if (oauthIdentity) {
      this.identity = oauthIdentity
      el('landing').classList.add('hidden')
      this.connect('')
      this.toast(`◈ signed in as ${oauthIdentity.handle} — ${shortDid(oauthIdentity.did)}`)
      requestAnimationFrame(() => this.frame())
      return
    }
    this.identity = loadIdentity()
    if (this.identity) {
      el('landing').classList.add('hidden')
      this.connect()
    } else if (this.backendKind() === 'town') {
      // read-only spectator behind the landing card (spec §6.1)
      this.connectSpectator(this.townUrl())
    } else {
      // freeq backend: no spectator join on the public server — render a local preview
      this.previewWorld()
    }
    requestAnimationFrame(() => this.frame())
  }

  // ---------- connection ----------

  private backendKind(): 'town' | 'freeq' {
    return new URLSearchParams(location.search).get('server') ? 'town' : 'freeq'
  }

  private townUrl(): string {
    return this.travelUrl ?? new URLSearchParams(location.search).get('server') ?? location.origin
  }

  private freeqUrl(): string {
    return new URLSearchParams(location.search).get('freeq') ?? 'wss://irc.freeq.at/irc'
  }

  private previewWorld(): void {
    // pre-login placeholder — the real world is generated from the server's
    // live channel list the moment you enter
    this.town = {
      schema: 'freeq.at/world/server-profile/v1',
      server: 'irc.freeq.at',
      name: 'Freeq',
      theme: 'network-noir',
      spawn_room: '#lobby',
      palette: 'amber-cyan',
      music_pack: 'freeq-01',
      peers: [],
    }
    this.enterRoom('#lobby', [], [])
  }

  private connectSpectator(url: string): void {
    this.conn?.close()
    this.conn = new TownConnection({
      serverUrl: url,
      channel: '#lobby',
      identity: null,
      onFrame: (f) => this.onFrame(f),
      onRawIn: (f) => this.inspect('in', f),
      onOpen: (rtt) => {
        this.rtt = rtt
      },
    })
  }

  private connect(channel = this.channel): void {
    this.conn?.close()
    this.remotes.clear()
    const common = {
      channel,
      identity: this.identity,
      avatarDid: this.identity ? avatarDid(this.identity) : undefined,
      onFrame: (f: ServerFrame) => this.onFrame(f),
      onRawIn: (f: ServerFrame) => this.inspect('in', f),
      onOpen: (rtt: number) => {
        this.rtt = rtt
        this.updateInspectorMeta()
      },
      onClose: () => this.toast('connection lost — reconnecting…'),
    }
    if (this.backendKind() === 'freeq') {
      this.conn = new FreeqBackend({
        ...common,
        serverUrl: this.freeqUrl(),
        avoidGatedSpawn: !localStorage.getItem('fimp-gate-accepted'),
        onAuth: (did) => {
          this.toast(`◈ DID authenticated with the server: ${shortDid(did)}`)
          this.updateInspectorMeta()
        },
        onDm: (fromNick, text, ts) => this.onDmIn(fromNick, text, ts),
        onTouch: (fromNick, ts, sig, signerDid) => this.onTouchIn(fromNick, ts, sig, signerDid),
        onTouchObserved: (fromNick, toNick) => this.onTouchObserved(fromNick, toNick),
        onTyping: (nick, isTyping) => {
          if (isTyping) this.typingNicks.set(nick.toLowerCase(), performance.now() + 6000)
          else this.typingNicks.delete(nick.toLowerCase())
        },
        onAway: (nick, away) => {
          if (away) this.awayNicks.add(nick.toLowerCase())
          else this.awayNicks.delete(nick.toLowerCase())
        },
      })
    } else {
      this.conn = new TownConnection({ ...common, serverUrl: this.townUrl() })
    }
  }

  private onFrame(frame: ServerFrame): void {
    switch (frame.t) {
      case 'welcome': {
        this.town = frame.town
        this.rooms = new Map(frame.rooms.map((r) => [r.channel, r]))
        this.enterRoom(frame.channel, frame.history, frame.members)
        break
      }
      case 'joined':
        this.enterRoom(frame.channel, frame.history, frame.members)
        break
      case 'event':
        if (frame.channel === this.channel) this.onDurable(frame.durable, true)
        break
      case 'presence':
        if (frame.channel === this.channel) this.onPresence(frame.positions)
        break
      case 'member':
        this.onMember(frame.member, frame.online, frame.silent)
        break
      case 'music':
        this.audio.setState(frame.state as MusicState)
        break
      case 'gate': {
        el('gate-channel').textContent = frame.channel
        el('gate-rules').textContent = frame.rules.length ? frame.rules.join('\n') : 'This channel has an entry policy (no rules text published).'
        el('gate').classList.remove('hidden')
        const accept = el('gate-accept')
        const fresh = accept.cloneNode(true) as HTMLElement // drop stale listeners
        accept.replaceWith(fresh)
        fresh.addEventListener('click', () => {
          el('gate').classList.add('hidden')
          // accepted once → future visits spawn straight into the home channel
          localStorage.setItem('fimp-gate-accepted', frame.channel)
          const conn = this.conn
          if (conn && 'acceptPolicy' in conn) (conn as FreeqBackend).acceptPolicy(frame.channel)
        })
        break
      }
      case 'error':
        this.toast(frame.message)
        break
    }
  }

  private enterRoom(channel: string, history: DurableEvent[], members: MemberInfo[]): void {
    const cameFrom = this.channel
    this.channel = channel
    let room = this.rooms.get(channel)
    if (!room) {
      // every channel maps to a room — synthesize one for the outskirts (spec §7.5)
      room = roomFor(channel)
      this.rooms.set(channel, room)
    }
    this.map = generateTilemap(room)
    // arrive at the door that leads back where you came from, like a real place
    const returnDoor = this.map.doors.find((d) => d.channel === cameFrom)
    if (returnDoor) {
      this.me.x = returnDoor.direction === 'west' ? 1.8 : returnDoor.direction === 'east' ? this.map.width - 2.8 : returnDoor.x + 0.5
      this.me.y = returnDoor.direction === 'north' ? 1.8 : returnDoor.direction === 'south' ? this.map.height - 2.8 : returnDoor.y + 0.5
    } else {
      this.me.x = this.map.spawn[0] + 0.5
      this.me.y = this.map.spawn[1] + 0.5
    }
    this.moveTarget = null
    this.remotes.clear()
    this.bubbles = []
    // drop secondary selves (my device did:key / linked identity) from the roster
    this.members = new Map(
      members.filter((m) => !(this.identity && m.did !== this.identity.did && this.isMe(m.did))).map((m) => [m.did, m]),
    )
    this.log = [...history]
    this.vaultPlain.clear()
    this.audio.setRoom(room.music.bpm, channel)
    document.querySelector('[data-testid="header-loc"]')!.textContent = `${this.town?.name ?? '—'} · ${room.name} · ${channel}`
    document.querySelector('[data-testid="header-topic"]')!.textContent = room.topic
    this.renderTranscript()
    this.renderMembers()
    this.updateVaultUi()
    if (room.encrypted && this.backendKind() === 'town') {
      if (!this.vaultKey) this.promptVaultKey()
      void this.decryptVisible()
    }
    this.updateInspectorMeta()
    // passport: a real visit to a real channel stamps the journal
    if (this.identity && this.journal.stamp(channel, Date.now())) {
      const n = this.journal.stampCount()
      this.toast(`📍 stamped ${channel} — ${n} ${n === 1 ? 'place' : 'places'} (${explorerTitle(n)})`)
    }
    // fresh room, fresh living layer
    this.critter = null
    this.activeThread = null
    this.typingNicks.clear()
    this.awayNicks.clear()
    this.galleryWall = []
    this.trails.clear()
    this.rebuildLivingLayer()
  }

  /** Threads become campfires; posted images hang on the walls. */
  private rebuildLivingLayer(): void {
    if (!this.map) return
    const msgs = this.log
      .filter((e): e is Extract<DurableEvent, { kind: 'message' }> => e.kind === 'message' && !e.event.enc)
      .map((e) => e.event)
    // campfires at deterministic walkable spots derived from the thread root
    this.threadPlaces = threadsOf(msgs).map((t) => {
      const seed = new Uint8Array(16)
      for (let i = 0; i < t.root.length; i++) seed[i % 16] = (seed[i % 16]! * 37 + t.root.charCodeAt(i)) & 0xff
      const rng = seededPrng(seed)
      let x = this.map!.spawn[0] + 0.5
      let y = this.map!.spawn[1] - 2
      for (let tries = 0; tries < 50; tries++) {
        const cx = 3 + rng() * (this.map!.width - 6)
        const cy = 3 + rng() * (this.map!.height - 6)
        if (isWalkable(this.map!, cx, cy)) {
          x = cx
          y = cy
          break
        }
      }
      return { ...t, x, y }
    })
    // gallery: most recent images hang along the interior of the north wall
    const urls: { url: string; from: string }[] = []
    for (const m of msgs) for (const url of imageUrlsIn(m.content)) urls.push({ url, from: m.sender_name })
    const recent = urls.slice(-6)
    this.galleryWall = recent.map((u, i) => ({
      ...u,
      x: 3 + ((i * (this.map!.width - 8)) / Math.max(1, recent.length - 1) || 0),
      y: 1.6,
    }))
    for (const g of this.galleryWall) {
      if (!this.galleryImages.has(g.url)) {
        const img = new Image()
        img.src = g.url
        this.galleryImages.set(g.url, img)
      }
    }
  }

  private onDurable(durable: DurableEvent, live: boolean): void {
    this.log.push(durable)
    if (this.log.length > 500) this.log.shift()
    if (durable.kind === 'message' && (durable.event.thread_root || imageUrlsIn(durable.event.content).length)) {
      this.rebuildLivingLayer()
    }
    if (durable.kind === 'message') {
      const msg = durable.event
      this.lastMessageId = msg.id
      if (msg.enc && msg.enc.iv === 'sdk') {
        // the SDK decrypted this E2EE channel message locally — that is the
        // evidence that this room really is encrypted (never assumed)
        this.vaultPlain.set(msg.id, msg.content)
        const room = this.rooms.get(msg.channel)
        if (room && !room.encrypted) {
          room.encrypted = true
          this.updateVaultUi()
        }
        if (live) {
          this.addBubbleFor(msg.sender, msg.content)
          this.audio.speechBlip(msg.sender)
        }
      } else if (msg.enc) {
        void this.tryDecrypt(msg.id, msg.enc).then(() => {
          this.renderTranscript()
          if (live) this.addBubbleFor(msg.sender, this.vaultPlain.get(msg.id) ?? null)
        })
      } else if (live) {
        this.addBubbleFor(msg.sender, msg.content, msg.type === 'code' ? 'code' : 'text')
        this.audio.speechBlip(msg.sender)
        if (this.identity && this.mentionsMe(msg.content)) this.audio.stinger('mention')
        // rekindling: our own message breaking >24h of silence in this room
        if (this.identity && msg.sender === this.identity.did) {
          const prior = this.log.filter((e) => e.kind === 'message' && e.event.id !== msg.id)
          const prev = prior.length ? prior[prior.length - 1]! : null
          if (prev?.kind === 'message' && shouldRekindle(msg.ts, prev.event.ts) && this.journal.rekindle(msg.channel)) {
            this.toast(`🔥 you rekindled ${msg.channel} — first words here in over a day`)
            this.audio.stinger('spark')
            this.updateSparkHud()
          }
        }
      }
    }
    if (durable.kind === 'reaction' && live) {
      this.emotes.push({ did: durable.event.actor, emoji: durable.event.reaction, until: performance.now() + 1800 })
    }
    this.renderTranscript()
  }

  /** Any identity that is *me* — primary DID, the browser device key, or a
   *  linked identity. The world must never render my own selves as separate
   *  characters (e.g. an OAuth session seeing its own did:key device ghost). */
  private isMe(did: string | undefined | null): boolean {
    const id = this.identity
    if (!did || !id) return false
    return did === id.did || did === id.device_did || did === id.linked_did || did === avatarDid(id)
  }

  private onPresence(positions: WorldPosition[]): void {
    const seen = new Set<string>()
    for (const p of positions) {
      if (this.isMe(p.did)) continue
      seen.add(p.did)
      const existing = this.remotes.get(p.did)
      if (p.animation === 'jump' && existing?.animation !== 'jump') {
        this.remoteJumps.set(p.did, performance.now())
      }
      if (existing) {
        existing.tx = p.x
        existing.ty = p.y
        existing.facing = p.facing
        existing.animation = p.animation
      } else {
        this.remotes.set(p.did, { did: p.did, x: p.x, y: p.y, tx: p.x, ty: p.y, facing: p.facing, animation: p.animation })
      }
    }
    for (const did of [...this.remotes.keys()]) if (!seen.has(did)) this.remotes.delete(did)
  }

  private onMember(member: MemberInfo, online: boolean, silent = false): void {
    // A secondary self (my device did:key or a linked identity, connected
    // alongside my primary session) is not a separate person — don't announce,
    // list, or render it as a ghost. My primary DID stays in the roster.
    if (this.identity && member.did !== this.identity.did && this.isMe(member.did)) return
    if (online) {
      const isNew = !this.members.has(member.did)
      this.members.set(member.did, member)
      if (isNew && !silent) {
        this.transcriptSystem(`${member.display_name} arrived`)
        void this.audio.playLeitmotif(member.avatar_did ?? member.did)
        // arrival puff at wherever they materialize
        this.emotes.push({ did: member.did, emoji: '✧', until: performance.now() + 1400 })
      }
    } else {
      this.members.delete(member.did)
      this.remotes.delete(member.did)
      if (!silent) this.transcriptSystem(`${member.display_name} left`)
    }
    this.renderMembers()
  }

  private mentionsMe(content: string): boolean {
    if (!this.identity) return false
    const lower = content.toLowerCase()
    return lower.includes(`@${this.identity.handle.toLowerCase()}`) || lower.includes(this.identity.display_name.toLowerCase())
  }

  // ---------- vault ----------

  private async promptVaultKey(): Promise<void> {
    // demo passphrase is public and prefilled — the point is the mechanics:
    // the server never sees it, and /api/debug/log shows ciphertext only
    const pass = 'freeq-vault-demo'
    this.vaultKey = await deriveRoomKey('#private-demo', pass)
    this.updateVaultUi()
    await this.decryptVisible()
    this.renderTranscript()
  }

  private async tryDecrypt(id: string, env: CipherEnvelope): Promise<void> {
    if (!this.vaultKey) return
    const plain = await decryptMessage(this.vaultKey, env)
    if (plain !== null) this.vaultPlain.set(id, plain)
  }

  private async decryptVisible(): Promise<void> {
    for (const e of this.log) {
      if (e.kind === 'message' && e.event.enc && !this.vaultPlain.has(e.event.id)) {
        await this.tryDecrypt(e.event.id, e.event.enc)
      }
    }
    this.renderTranscript()
  }

  private updateVaultUi(): void {
    const badge = el('vault-status')
    const room = this.rooms.get(this.channel)
    if (!room?.encrypted) {
      badge.classList.add('hidden')
      return
    }
    badge.classList.remove('hidden')
    if (this.backendKind() === 'freeq') {
      badge.textContent = '🔐 e2ee channel · decrypted locally'
      badge.className = 'vstat retrieved'
    } else if (this.vaultKey) {
      badge.textContent = '🔓 key: retrieved · e2e'
      badge.className = 'vstat retrieved'
    } else {
      badge.textContent = '🔒 key: sealed'
      badge.className = 'vstat sealed'
    }
  }

  // ---------- sending ----------

  private async sendCurrentMessage(): Promise<void> {
    const input = el<HTMLInputElement>('msg-input')
    const content = input.value.trim()
    if (!content || !this.conn) return
    if (!this.identity) {
      this.toast('read-only guest mode — pick a name to speak')
      return
    }
    const room = this.rooms.get(this.channel)
    if (room?.encrypted && this.backendKind() === 'town') {
      if (!this.vaultKey) {
        this.toast('vault key still sealed')
        return
      }
      const env = await encryptMessage(this.vaultKey, content)
      this.conn.sendMessage(this.channel, '', env)
    } else if (this.activeThread && 'sendThreadReply' in this.conn) {
      // standing at a campfire: speak into the real thread
      ;(this.conn as FreeqBackend).sendThreadReply(this.channel, this.activeThread, content)
    } else {
      // freeq backend: the SDK's channel E2EE encrypts before the wire when active
      this.conn.sendMessage(this.channel, content)
    }
    if ('setTyping' in this.conn) (this.conn as FreeqBackend).setTyping(this.channel, false)
    input.value = ''
  }

  // ---------- transcript / members ----------

  private renderTranscript(): void {
    const t = el('transcript')
    const rows: string[] = []
    // campfire focus: only the thread you are standing at
    let entries = this.log.slice(-200)
    if (this.activeThread) {
      const root = this.activeThread
      entries = this.log.filter((e) => e.kind === 'message' && (e.event.id === root || e.event.thread_root === root))
      const place = this.threadPlaces.find((p) => p.root === root)
      rows.push(
        `<div class="row" style="color:var(--amber)">🔥 campfire — this thread only (${place?.count ?? entries.length} messages). Step away to hear the room again.</div>`,
      )
    }
    for (const e of entries) {
      if (e.kind === 'message') {
        const m = e.event
        const member = this.members.get(m.sender)
        const isAgent = Boolean(m.provenance) || member?.is_agent
        const who = `<span class="who${isAgent ? ' agent' : ''}" data-did="${m.sender}">${escapeHtml(m.sender_name)}${isAgent ? ' ⚙' : ''}</span>`
        const origin = m.origin_server !== this.town?.server ? ` <span class="origin">[via ${escapeHtml(m.origin_server)}]</span>` : ''
        if (m.enc) {
          const plain = m.enc.iv === 'sdk' ? m.content : this.vaultPlain.get(m.id)
          if (plain !== undefined) {
            rows.push(`<div class="row">${who} 🔐 ${escapeHtml(plain)}${origin}</div>`)
          } else {
            rows.push(`<div class="row sealed">${who} ✉ <i>sealed message — key required</i>${origin}</div>`)
          }
        } else {
          rows.push(`<div class="row">${who} ${escapeHtml(m.content)}${origin}</div>`)
        }
      } else if (e.kind === 'reaction') {
        const member = this.members.get(e.event.actor)
        rows.push(`<div class="row sys">${escapeHtml(member?.display_name ?? shortDid(e.event.actor))} reacted ${e.event.reaction}</div>`)
      }
    }
    t.innerHTML = rows.join('')
    t.scrollTop = t.scrollHeight
    for (const span of t.querySelectorAll('.who')) {
      span.addEventListener('click', () => this.showIdentityCard((span as HTMLElement).dataset.did!))
    }
  }

  private transcriptSystem(text: string): void {
    const t = el('transcript')
    const div = document.createElement('div')
    div.className = 'row sys'
    div.textContent = `· ${text}`
    t.appendChild(div)
    t.scrollTop = t.scrollHeight
  }

  private renderMembers(): void {
    // we are standing in this channel: its live roster is ground truth, better
    // than a stale (or hidden) LIST count — keep the directory honest
    const entry = this.town?.directory?.find((e) => e.channel === this.channel)
    if (entry && this.members.size > 0) {
      entry.users = this.members.size
      entry.unlisted = undefined
    }
    const box = el('members')
    const items: string[] = []
    for (const m of this.members.values()) {
      const sigil = m.verification_status === 'verified' ? '<span class="sigil">◈</span> ' : '◇ '
      const badge = m.is_agent ? '<span class="badge">agent</span>' : ''
      items.push(`<div class="m" data-did="${m.did}">${sigil}${escapeHtml(m.display_name)}${badge}</div>`)
    }
    box.innerHTML = `<b style="color:var(--dim)">${this.members.size} here</b>` + items.join('')
    for (const div of box.querySelectorAll('.m')) {
      div.addEventListener('click', () => this.showIdentityCard((div as HTMLElement).dataset.did!))
    }
  }

  private async showIdentityCard(did: string): Promise<void> {
    const m = this.members.get(did)
    el('idcard-name').textContent = m?.display_name ?? shortDid(did)
    el('idcard-display').textContent = m?.display_name ?? '—'
    el('idcard-handle').textContent = m?.handle ?? '—'
    el('idcard-did').textContent = m?.avatar_did && m.avatar_did !== did ? `${did} (signing) · ${m.avatar_did} (linked)` : did
    el('idcard-verify').textContent = m?.is_agent
      ? 'agent — signed provenance below'
      : m?.verification_status === 'verified'
        ? '◈ device key verified'
        : '◇ linked identity not yet proven'
    const agentRow = el('idcard-agent-row')
    const capsRow = el('idcard-caps-row')
    if (m?.is_agent && m.agent_chain) {
      agentRow.classList.remove('hidden')
      el('idcard-chain').textContent = m.agent_chain.map(shortDid).join(' → ')
      capsRow.classList.remove('hidden')
      el('idcard-caps').textContent = (m.capabilities ?? []).join(', ')
    } else {
      agentRow.classList.add('hidden')
      capsRow.classList.add('hidden')
    }
    // private encounter: DM button when the backend supports it (spec §6.5)
    const dmBtn = el('idcard-dm')
    const nick = m?.nick ?? m?.display_name
    const canDm = Boolean(nick && this.conn && 'sendDm' in this.conn && !this.isMe(did))
    dmBtn.classList.toggle('hidden', !canDm)
    if (canDm) {
      const fresh = dmBtn.cloneNode(true) as HTMLElement
      dmBtn.replaceWith(fresh)
      fresh.addEventListener('click', () => {
        el('idcard').classList.add('hidden')
        this.openDm(nick!)
      })
    }
    el('idcard').classList.remove('hidden')
    await drawPreview(m?.avatar_did ?? did, el<HTMLCanvasElement>('idcard-avatar'))
  }

  // ---------- inspector ----------

  private inspect(dir: 'in' | 'out', frame: ServerFrame): void {
    let summary: string = frame.t
    let ok: boolean | null = null
    if (frame.t === 'event') {
      const { durable } = frame
      const ev = durable.event as unknown as Record<string, unknown>
      const { signature, origin_server, edit_state, sender_name, ...base } = ev
      void origin_server; void edit_state; void sender_name
      const signer = durable.kind === 'message' ? (ev.sender as string) : (ev.actor as string)
      const sig = String(signature ?? '')
      if (sig.startsWith('relay:')) {
        // freeq backend: server-attributed msgid; per-event sigs live in server MSGSIG
        summary = `${durable.kind} ${sig.slice(6, 20)} from ${shortDid(signer)} via ${ev.origin_server}`
      } else if (sig === '') {
        summary = `${durable.kind} from ${shortDid(signer)} via ${ev.origin_server}`
      } else {
        ok = verifyEvent(base, sig, signer)
        summary = `${durable.kind} ${String(ev.id).slice(0, 8)} from ${shortDid(signer)} origin=${ev.origin_server} sig=${ok ? 'VERIFIED' : 'INVALID'}`
      }
    } else if (frame.t === 'presence') {
      summary = `presence ×${frame.positions.length} (ephemeral — never stored)`
    } else if (frame.t === 'welcome') {
      summary = `welcome from ${frame.town.server}: ${frame.rooms.length} rooms, ${frame.history.length} events`
    } else if (frame.t === 'music') {
      const s = frame.state
      summary = `music ${s.topic_family} e=${s.energy.toFixed(2)} t=${s.tension.toFixed(2)} d=${s.density.toFixed(2)}`
    }
    this.inspectorFrames.push({ dir, summary, ok })
    if (this.inspectorFrames.length > 120) this.inspectorFrames.shift()
    if (document.body.classList.contains('mode-dev')) this.renderInspector()
  }

  private renderInspector(): void {
    const box = el('insp-log')
    box.innerHTML = this.inspectorFrames
      .slice(-80)
      .map((f) => `<div class="f ${f.ok === null ? '' : f.ok ? 'ok' : 'bad'}">${f.dir === 'in' ? '⇦' : '⇨'} ${escapeHtml(f.summary)}</div>`)
      .join('')
    box.scrollTop = box.scrollHeight
  }

  private updateInspectorMeta(): void {
    const lines = [
      `server: ${this.conn?.serverUrl ?? '—'} (${this.town?.server ?? '?'})`,
      `transport: WebSocket/TLS · rtt≈${this.rtt.toFixed(0)}ms`,
      `channel: ${this.channel} · durable history + ephemeral TAGMSG presence split`,
    ]
    if (this.backendKind() === 'town') {
      lines.push(`raw storage: <a href="${this.conn?.serverUrl}/api/debug/log/${encodeURIComponent(this.channel)}" target="_blank">/api/debug/log/${this.channel}</a>`)
    } else {
      lines.push(`identity: ${this.identity ? `${shortDid(this.identity.did)} (SASL crypto did:key)` : 'guest'}`)
    }
    el('insp-meta').innerHTML = lines.join('<br>')
  }

  // ---------- input & UI ----------

  private bindUi(): void {
    el('enter-guest').addEventListener('click', () => this.doGuestLogin())
    el<HTMLInputElement>('name-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.doGuestLogin()
    })
    el('enter-bsky').addEventListener('click', () => void this.doBskyLogin())
    el('idcard-close').addEventListener('click', () => el('idcard').classList.add('hidden'))
    el('obj-close').addEventListener('click', () => el('objcard').classList.add('hidden'))
    el('travel-cancel').addEventListener('click', () => {
      el('travel').classList.add('hidden')
      this.pendingTravel = null
      // step back so we don't immediately re-trigger the door
      this.me.y += this.me.facing === 'north' ? 1 : this.me.facing === 'south' ? -1 : 0
      this.me.x += this.me.facing === 'west' ? 1 : this.me.facing === 'east' ? -1 : 0
    })
    el('travel-go').addEventListener('click', () => this.confirmTravel())
    el('gate-later').addEventListener('click', () => el('gate').classList.add('hidden'))
    el('dm-close').addEventListener('click', () => el('dmpanel').classList.add('hidden'))
    el('spark-hud').addEventListener('click', () => this.openSparkBook())
    el('sparkbook-close').addEventListener('click', () => el('sparkbook').classList.add('hidden'))
    el('lightbox-close').addEventListener('click', () => el('lightbox').classList.add('hidden'))
    el('townmap-close').addEventListener('click', () => el('townmap').classList.add('hidden'))
    el<HTMLCanvasElement>('townmap-canvas').addEventListener('click', (e) => {
      const rect = (e.target as HTMLCanvasElement).getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      const hit = this.mapSpots.find((s) => Math.hypot(s.x - x, s.y - y) <= s.r)
      if (hit) {
        el('townmap').classList.add('hidden')
        if (hit.channel !== this.channel) this.conn?.join(hit.channel)
      }
    })
    el<HTMLInputElement>('dm-input').addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') this.sendDm()
      if (e.key === 'Escape') el('dmpanel').classList.add('hidden')
    })
    el('send-btn').addEventListener('click', () => void this.sendCurrentMessage())
    el<HTMLInputElement>('msg-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void this.sendCurrentMessage()
      if (e.key === 'Escape') (e.target as HTMLInputElement).blur()
      e.stopPropagation()
    })
    // real IRCv3 typing indicator out (throttled)
    el<HTMLInputElement>('msg-input').addEventListener('input', () => {
      const now = performance.now()
      if (now - this.lastTypingSent < 3000) return
      this.lastTypingSent = now
      const conn = this.conn
      if (conn && 'setTyping' in conn) (conn as FreeqBackend).setTyping(this.channel, true)
    })
    for (const mode of ['world', 'split', 'chat', 'dev']) {
      el(`mode-${mode}`).addEventListener('click', () => this.setMode(mode))
    }
    el('sound-btn').addEventListener('click', () => {
      const muted = this.audio.toggle()
      localStorage.setItem('fimp-sound', muted ? 'off' : 'on')
      el('sound-btn').textContent = muted ? '♪ off' : '♪ on'
    })
    // audio needs a user gesture: start on the first one unless the user muted last time
    const autoStart = () => {
      if (localStorage.getItem('fimp-sound') !== 'off' && this.audio.muted) {
        this.audio.start()
        el('sound-btn').textContent = '♪ on'
      }
    }
    window.addEventListener('pointerdown', autoStart, { once: true })
    window.addEventListener('keydown', autoStart, { once: true })
    for (const btn of document.querySelectorAll('#reactions button')) {
      btn.addEventListener('click', () => {
        if (this.lastMessageId && this.conn) this.conn.sendReaction(this.channel, this.lastMessageId, (btn as HTMLElement).dataset.r!)
      })
    }
    window.addEventListener('keydown', (e) => this.onKeyDown(e))
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()))
    this.canvas.addEventListener('click', (e) => this.onCanvasClick(e))
  }

  private setMode(mode: string): void {
    document.body.className = `mode-${mode}`
    for (const m of ['world', 'split', 'chat', 'dev']) el(`mode-${m}`).classList.toggle('active', m === mode)
    if (mode === 'dev') {
      this.renderInspector()
      this.updateInspectorMeta()
    }
  }

  private onKeyDown(e: KeyboardEvent): void {
    const target = e.target as HTMLElement
    if (target.tagName === 'INPUT') return
    const k = e.key.toLowerCase()
    if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
      this.keys.add(k)
      this.moveTarget = null
      e.preventDefault()
      return
    }
    if (e.key === 'Enter') {
      el<HTMLInputElement>('msg-input').focus()
      e.preventDefault()
    } else if (k === 'c') {
      this.setMode(document.body.classList.contains('mode-chat') ? 'split' : 'chat')
    } else if (k === 'r') {
      if (this.lastMessageId && this.conn) this.conn.sendReaction(this.channel, this.lastMessageId, '👍')
    } else if (k === 'g') {
      this.openDirectory()
    } else if (k === 'b') {
      this.openSparkBook()
    } else if (k === 'm') {
      this.toggleTownMap()
    } else if (k === 'e') {
      this.interact()
    } else if (k === ' ') {
      this.jump()
      e.preventDefault()
    } else if (e.key === 'Escape') {
      for (const id of ['idcard', 'objcard', 'travel', 'sparkbook', 'lightbox', 'townmap']) el(id).classList.add('hidden')
    }
  }

  private doGuestLogin(): void {
    const name = el<HTMLInputElement>('name-input').value.trim() || `wanderer-${Math.floor(Math.random() * 900 + 100)}`
    this.identity = createIdentity(name)
    el('landing').classList.add('hidden')
    this.connect('')
    this.toast(`your DID: ${shortDid(this.identity.did)} — your avatar is derived from it`)
  }

  private doBskyLogin(): void {
    const handle = el<HTMLInputElement>('bsky-input').value.trim()
    if (!handle) return
    // real AT Protocol OAuth via the freeq auth broker — same flow as the
    // official web client; comes back to us with #oauth=<result>
    startOAuth(handle)
  }

  /** Space: hop. Broadcast like any movement — everyone sees you bounce. */
  private jump(): void {
    const now = performance.now()
    if (now < this.jumpUntil || !this.identity) return
    this.jumpUntil = now + 550
    this.audio.stinger('jump')
    this.conn?.sendPosition(this.channel, this.me.x, this.me.y, this.me.facing, 'jump')
    window.setTimeout(() => {
      this.conn?.sendPosition(this.channel, this.me.x, this.me.y, this.me.facing, this.me.moving ? 'walk' : 'idle')
    }, 600)
  }

  private interact(): void {
    // people first: walking up to someone and pressing Space is the social gesture
    let nearest: { did: string; dist: number } | null = null
    for (const [did, r] of this.remotes) {
      const dist = Math.hypot(r.x - this.me.x, r.y - this.me.y)
      if (dist < 2.2 && (!nearest || dist < nearest.dist)) nearest = { did, dist }
    }
    if (!nearest) {
      for (const m of this.members.values()) {
        if (this.isMe(m.did) || this.remotes.has(m.did)) continue
        const spot = this.parkedSpot(m.did)
        if (!spot) continue
        const dist = Math.hypot(spot.x - this.me.x, spot.y - this.me.y)
        if (dist < 2.2 && (!nearest || dist < nearest.dist)) nearest = { did: m.did, dist }
      }
    }
    if (nearest) {
      void this.showIdentityCard(nearest.did)
      return
    }
    // a painting on the wall?
    for (const g of this.galleryWall) {
      if (Math.hypot(g.x + 0.7 - this.me.x, g.y + 1.4 - this.me.y) < 2.2) {
        el<HTMLImageElement>('lightbox-img').src = g.url
        el('lightbox-caption').textContent = `posted by ${g.from} in ${this.channel}`
        el('lightbox').classList.remove('hidden')
        return
      }
    }
    const room = this.rooms.get(this.channel)
    if (!room) return
    for (const o of room.objects) {
      const dx = o.position[0] + 0.5 - this.me.x
      const dy = o.position[1] + 0.5 - this.me.y
      if (dx * dx + dy * dy < 2.6) {
        this.showObjectCard(o.id)
        return
      }
    }
  }

  private showObjectCard(objectId: string): void {
    const room = this.rooms.get(this.channel)
    const o = room?.objects.find((x) => x.id === objectId)
    if (!o) return
    el('obj-name').textContent = o.label
    el('obj-type').textContent = o.type
    el('obj-caps').textContent = o.capabilities.join(', ')
    const body = el('obj-body')
    if (o.id === 'directory' && this.town?.directory?.length) {
      this.renderDirectory(body)
    } else {
      const bodies: Record<string, string> = {
        'how-terminal':
          'This "game" is a Freeq client. Rooms are channels; every message is an ed25519-signed durable event; movement is ephemeral presence that expires and is never logged. Open Dev mode to watch the raw protocol, or fetch /api/debug/log/%23lobby to read the store itself.',
        'peer-board': `Peered towns: ${this.town?.peers.map((p) => `${p.server} @ ${p.url}`).join(' · ') || 'none'}. Messages in #federation cross with signatures intact.`,
        'key-panel': 'Vault key status is client-side only. The server relays AES-GCM envelopes it cannot open — check the raw log and see for yourself.',
        kiosk: 'Rooms: ' + [...this.rooms.values()].map((r) => `${r.name} (${r.channel})`).join(' · '),
      }
      body.textContent = bodies[o.id] ?? `A ${o.type}. Interactions: ${o.capabilities.join(', ')}.`
    }
    el('objcard').classList.remove('hidden')
  }

  /** The real, live channel directory — click to travel (portal-directory, spec §7.5). */
  private renderDirectory(body: HTMLElement): void {
    const directory = this.town?.directory ?? []
    const hidden = this.town?.hidden_channels ?? 0
    body.innerHTML =
      `<div class="rowline" style="margin-bottom:6px"><input id="dir-join" data-testid="dir-join" placeholder="jump to any channel… (#freeq)" /></div>` +
      `<div style="max-height:280px;overflow-y:auto">` +
      directory
        .map(
          (d) =>
            `<div class="dirrow" data-ch="${escapeHtml(d.channel)}" style="cursor:pointer;padding:2px 0">` +
            `<span style="color:var(--cyan)">${escapeHtml(d.channel)}</span> ` +
            `<span style="color:var(--dim)">${d.unlisted && !d.users ? 'unlisted' : d.personal && !d.users ? 'recent' : `${d.users} ${d.users === 1 ? 'soul' : 'souls'}`}${d.topic ? ' · ' + escapeHtml(d.topic.slice(0, 60)) : ''}</span></div>`,
        )
        .join('') +
      `</div>` +
      (hidden > 0 ? `<div style="color:var(--dim);margin-top:6px">${hidden} development/test channels hidden from the town</div>` : '')
    for (const rowEl of body.querySelectorAll<HTMLElement>('.dirrow')) {
      rowEl.addEventListener('click', () => {
        el('objcard').classList.add('hidden')
        this.conn?.join(rowEl.dataset.ch!)
      })
    }
    const joinInput = body.querySelector<HTMLInputElement>('#dir-join')!
    joinInput.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') {
        const ch = joinInput.value.trim()
        if (ch.startsWith('#')) {
          el('objcard').classList.add('hidden')
          this.conn?.join(ch)
        }
      }
    })
    setTimeout(() => joinInput.focus(), 50)
  }

  /** M key (spec §6.4): the town as a metro map — real channels, live sizes. */
  private mapSpots: { channel: string; x: number; y: number; r: number }[] = []

  private toggleTownMap(): void {
    const overlay = el('townmap')
    if (!overlay.classList.contains('hidden')) {
      overlay.classList.add('hidden')
      return
    }
    const canvas = el<HTMLCanvasElement>('townmap-canvas')
    const ctx = canvas.getContext('2d')!
    const dir = this.town?.directory ?? []
    const W = canvas.width
    const H = canvas.height
    ctx.fillStyle = '#0d0d14'
    ctx.fillRect(0, 0, W, H)
    this.mapSpots = []
    const cx = W / 2
    const cy = H / 2
    const spawn = this.town?.spawn_room ?? dir[0]?.channel ?? '#lobby'
    const ring1 = dir.filter((d) => d.channel !== spawn).slice(0, 8)
    const rest = dir.filter((d) => d.channel !== spawn).slice(8, 40)
    const spot = (channel: string, users: number, x: number, y: number) => {
      const r = Math.max(5, Math.min(16, 5 + users * 1.6))
      this.mapSpots.push({ channel, x, y, r: r + 4 })
      const here = channel === this.channel
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fillStyle = here ? '#ffd166' : users > 0 ? '#3a9188' : '#2c2c40'
      ctx.fill()
      ctx.strokeStyle = here ? '#fff' : '#454560'
      ctx.stroke()
      ctx.font = '10px monospace'
      ctx.fillStyle = here ? '#ffd166' : '#d8d6c8'
      ctx.fillText(`${channel}${users ? ` ${users}` : ''}`, x - channel.length * 3, y - r - 4)
    }
    // spokes to the inner ring first (lines under circles)
    ctx.strokeStyle = '#2c2c40'
    ring1.forEach((d, i) => {
      const a = (i / ring1.length) * Math.PI * 2 - Math.PI / 2
      ctx.beginPath()
      ctx.moveTo(cx, cy)
      ctx.lineTo(cx + Math.cos(a) * 105, cy + Math.sin(a) * 105)
      ctx.stroke()
    })
    const spawnEntry = dir.find((d) => d.channel === spawn)
    spot(spawn, spawnEntry?.users ?? 0, cx, cy)
    ring1.forEach((d, i) => {
      const a = (i / ring1.length) * Math.PI * 2 - Math.PI / 2
      spot(d.channel, d.users, cx + Math.cos(a) * 105, cy + Math.sin(a) * 105)
    })
    rest.forEach((d, i) => {
      const a = (i / rest.length) * Math.PI * 2 - Math.PI / 2 + 0.1
      spot(d.channel, d.users, cx + Math.cos(a) * 175, cy + Math.sin(a) * 165)
    })
    overlay.classList.remove('hidden')
  }

  /** G key (spec §6.4): jump-to-channel via the directory from anywhere. */
  private openDirectory(): void {
    el('obj-name').textContent = 'Channel directory'
    el('obj-type').textContent = 'directory kiosk'
    el('obj-caps').textContent = 'read, join'
    this.renderDirectory(el('obj-body'))
    el('objcard').classList.remove('hidden')
  }

  private onCanvasClick(e: MouseEvent): void {
    if (!this.map) return
    const rect = this.canvas.getBoundingClientRect()
    const scaleX = this.canvas.width / rect.width
    const scaleY = this.canvas.height / rect.height
    const px = (e.clientX - rect.left) * scaleX
    const py = (e.clientY - rect.top) * scaleY
    const cam = this.camera()
    const wx = (px + cam.x) / TILE_PX
    const wy = (py + cam.y) / TILE_PX
    // click on a player (moving or parked)?
    for (const r of this.remotes.values()) {
      if (Math.abs(r.x - wx) < 1.2 && Math.abs(r.y - 1.2 - wy) < 1.6) {
        this.showIdentityCard(r.did)
        return
      }
    }
    for (const m of this.members.values()) {
      if (this.isMe(m.did) || this.remotes.has(m.did)) continue
      const spot = this.parkedSpot(m.did)
      if (spot && Math.abs(spot.x - wx) < 1.2 && Math.abs(spot.y - 1.2 - wy) < 1.6) {
        this.showIdentityCard(m.did)
        return
      }
    }
    this.moveTarget = { x: wx, y: wy }
  }

  // ---------- movement / travel ----------

  private updateMovement(dt: number): void {
    if (!this.map || !this.identity) return
    let vx = 0
    let vy = 0
    if (this.keys.has('w') || this.keys.has('arrowup')) vy -= 1
    if (this.keys.has('s') || this.keys.has('arrowdown')) vy += 1
    if (this.keys.has('a') || this.keys.has('arrowleft')) vx -= 1
    if (this.keys.has('d') || this.keys.has('arrowright')) vx += 1
    if (vx === 0 && vy === 0 && this.moveTarget) {
      const dx = this.moveTarget.x - this.me.x
      const dy = this.moveTarget.y - this.me.y
      const dist = Math.hypot(dx, dy)
      if (dist < 0.2) this.moveTarget = null
      else {
        vx = dx / dist
        vy = dy / dist
      }
    }
    const moving = vx !== 0 || vy !== 0
    this.me.moving = moving
    if (moving) {
      const len = Math.hypot(vx, vy)
      vx /= len
      vy /= len
      this.me.facing = Math.abs(vx) > Math.abs(vy) ? (vx > 0 ? 'east' : 'west') : vy > 0 ? 'south' : 'north'
      const nx = this.me.x + vx * WALK_SPEED * dt
      const ny = this.me.y + vy * WALK_SPEED * dt
      if (isWalkable(this.map, nx, this.me.y)) this.me.x = nx
      if (isWalkable(this.map, this.me.x, ny)) this.me.y = ny
      this.walkPhase += dt * 8
      this.checkDoor()
    }
    const now = performance.now()
    if (this.conn && this.identity && (moving ? now - this.lastPosSent > POS_SEND_MS : now - this.lastPosSent > 3000)) {
      this.conn.sendPosition(this.channel, this.me.x, this.me.y, this.me.facing, moving ? 'walk' : 'idle')
      this.lastPosSent = now
    }
  }

  private checkDoor(): void {
    if (!this.map) return
    const tx = Math.floor(this.me.x)
    const ty = Math.floor(this.me.y)
    if (this.map.tiles[ty * this.map.width + tx] !== TILE.DOOR) return
    const door = this.map.doors.find((d) => Math.abs(d.x - tx) <= 1 && Math.abs(d.y - ty) <= 1)
    if (!door) return
    if (door.remote_url) {
      if (!el('travel').classList.contains('hidden')) return
      this.pendingTravel = { server: door.remote_server!, url: door.remote_url }
      el('travel-dest').textContent = `${door.remote_server} (${door.remote_url})`
      el('travel').classList.remove('hidden')
      this.audio.stinger('portal')
    } else {
      this.audio.stinger('door')
      this.conn?.join(door.channel)
    }
  }

  private confirmTravel(): void {
    if (!this.pendingTravel) return
    const { server, url } = this.pendingTravel
    this.pendingTravel = null
    el('travel').classList.add('hidden')
    this.audio.stinger('portal')
    this.channel = '#federation'
    this.travelUrl = url
    this.connect('#federation')
    this.toast(`crossed into ${server} — same DID, same avatar, different server`)
  }

  // ---------- bubbles ----------

  private addBubbleFor(did: string, content: string | null, kind: 'text' | 'code' = 'text'): void {
    if (content === null) {
      this.bubbles.push({ did, lines: ['✉ sealed'], until: performance.now() + 4000, kind: 'sealed' })
      return
    }
    const { lines } = wrapBubble(content, 24)
    this.bubbles = this.bubbles.filter((b) => b.did !== did)
    this.bubbles.push({ did, lines, until: performance.now() + 4500 + content.length * 30, kind })
    if (this.bubbles.length > 8) this.bubbles.shift() // declutter (spec §30.4)
  }

  // ---------- render ----------

  private fitCanvas(): void {
    const wrap = el('worldwrap')
    // integer scaling when practical (spec §12.1), half-steps when an integer wastes >35% of the panel
    const raw = Math.min(wrap.clientWidth / VIEW_W, wrap.clientHeight / VIEW_H)
    const scale = Math.max(1, Math.floor(raw * 2) / 2)
    this.canvas.style.width = `${VIEW_W * scale}px`
    this.canvas.style.height = `${VIEW_H * scale}px`
  }

  private camera(): { x: number; y: number } {
    if (!this.map) return { x: 0, y: 0 }
    const px = this.me.x * TILE_PX
    const py = this.me.y * TILE_PX
    const maxX = Math.max(0, this.map.width * TILE_PX - VIEW_W)
    const maxY = Math.max(0, this.map.height * TILE_PX - VIEW_H)
    return {
      x: Math.min(maxX, Math.max(0, px - VIEW_W / 2)),
      y: Math.min(maxY, Math.max(0, py - VIEW_H / 2)),
    }
  }

  private frame(): void {
    const now = performance.now()
    const dt = Math.min(0.05, (now - this.lastFrameTime) / 1000)
    this.lastFrameTime = now
    this.updateMovement(dt)
    if (this.me.moving) this.dropFootstep('me', this.me.x, this.me.y, now)
    for (const [did, r] of this.remotes) {
      r.x += (r.tx - r.x) * Math.min(1, dt * 12)
      r.y += (r.ty - r.y) * Math.min(1, dt * 12)
      if (r.animation === 'walk') this.dropFootstep(did, r.x, r.y, now)
    }
    this.scanForTouches(now)
    this.updateCritter(dt)
    this.updateLivingLayer(now)
    this.bubbles = this.bubbles.filter((b) => b.until > now)
    this.emotes = this.emotes.filter((e) => e.until > now)
    this.footsteps = this.footsteps.filter((f) => f.until > now)
    this.draw()
    requestAnimationFrame(() => this.frame())
  }

  private updateLivingLayer(now: number): void {
    // campfire focus: standing near a thread place tunes the transcript to it
    let nearThread: string | null = null
    for (const t of this.threadPlaces) {
      if (Math.hypot(t.x - this.me.x, t.y - this.me.y) < 2) {
        nearThread = t.root
        break
      }
    }
    if (nearThread !== this.activeThread) {
      this.activeThread = nearThread
      el<HTMLInputElement>('msg-input').placeholder = nearThread ? 'reply in this thread… (Enter)' : 'say something… (Enter)'
      this.renderTranscript()
    }
    // expire typing indicators
    for (const [nick, until] of this.typingNicks) if (until < now) this.typingNicks.delete(nick)
    // record movement trails (familiars walk them)
    this.recordTrail(this.identity ? avatarDid(this.identity) : 'me', this.me.x, this.me.y)
    for (const [did, r] of this.remotes) this.recordTrail(this.members.get(did)?.avatar_did ?? did, r.x, r.y)
    // ensembles: three or more souls standing together harmonize (rarely)
    if (now - this.lastEnsemble > 45_000 && this.identity && !this.audio.muted) {
      const close: string[] = [avatarDid(this.identity)]
      for (const [did, r] of this.remotes) {
        if (Math.hypot(r.x - this.me.x, r.y - this.me.y) < 3) close.push(this.members.get(did)?.avatar_did ?? did)
      }
      if (close.length >= 3) {
        this.lastEnsemble = now
        void this.audio.playEnsemble(close)
        this.toast('♪ your leitmotifs interleave — an ensemble forms')
      }
    }
  }

  private recordTrail(key: string, x: number, y: number): void {
    const trail = this.trails.get(key) ?? []
    const last = trail[trail.length - 1]
    if (!last || Math.hypot(last.x - x, last.y - y) > 0.15) {
      trail.push({ x, y })
      if (trail.length > 14) trail.shift()
      this.trails.set(key, trail)
    }
  }

  private dropFootstep(key: string, x: number, y: number, now: number): void {
    if ((this.lastFootstep.get(key) ?? 0) > now - 180) return
    this.lastFootstep.set(key, now)
    this.footsteps.push({ x: x + (Math.random() - 0.5) * 0.4, y, until: now + 900 })
    if (this.footsteps.length > 220) this.footsteps.shift()
    // worn paths: this session's traffic wears the floor
    if (this.map) {
      const idx = Math.floor(y) * this.map.width + Math.floor(x)
      let heat = this.wornPaths.get(this.channel)
      if (!heat) {
        heat = new Map()
        this.wornPaths.set(this.channel, heat)
      }
      heat.set(idx, Math.min(60, (heat.get(idx) ?? 0) + 1))
    }
  }

  /** The room's small resident: deterministic per channel, scatters from players. */
  private updateCritter(dt: number): void {
    if (!this.map) return
    if (!this.critter) {
      let h = 0
      for (const c of this.channel) h = (h * 33 + c.charCodeAt(0)) | 0
      this.critter = {
        x: 3 + (Math.abs(h) % (this.map.width - 6)),
        y: 3 + (Math.abs(h >> 4) % (this.map.height - 6)),
        vx: 0,
        vy: 0,
        kind: Math.abs(h) % 4,
        nextTurn: 0,
      }
    }
    const cr = this.critter
    const now = performance.now()
    const dToMe = Math.hypot(cr.x - this.me.x, cr.y - this.me.y)
    if (dToMe < 2.5) {
      // scatter away from the approaching player
      const away = Math.atan2(cr.y - this.me.y, cr.x - this.me.x)
      cr.vx = Math.cos(away) * 5
      cr.vy = Math.sin(away) * 5
      cr.nextTurn = now + 600
    } else if (now > cr.nextTurn) {
      cr.nextTurn = now + 1500 + Math.random() * 2500
      const wander = Math.random() * Math.PI * 2
      const speed = Math.random() < 0.5 ? 0 : 0.7
      cr.vx = Math.cos(wander) * speed
      cr.vy = Math.sin(wander) * speed
    }
    const nx = cr.x + cr.vx * dt
    const ny = cr.y + cr.vy * dt
    if (isWalkable(this.map, nx, cr.y)) cr.x = nx
    else cr.vx = -cr.vx
    if (isWalkable(this.map, cr.x, ny)) cr.y = ny
    else cr.vy = -cr.vy
  }

  private draw(): void {
    const ctx = this.ctx
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, VIEW_W, VIEW_H)
    const room = this.rooms.get(this.channel)
    if (!this.map || !room) return
    const pal = TEMPLATE_PALETTES[room.template] ?? TEMPLATE_PALETTES.plaza!
    const cam = this.camera()

    const x0 = Math.floor(cam.x / TILE_PX)
    const y0 = Math.floor(cam.y / TILE_PX)
    const x1 = Math.min(this.map.width, x0 + VIEW_W / TILE_PX + 2)
    const y1 = Math.min(this.map.height, y0 + VIEW_H / TILE_PX + 2)
    const tileAt = (x: number, y: number) => (x < 0 || y < 0 || x >= this.map!.width || y >= this.map!.height ? TILE.WALL : this.map!.tiles[y * this.map!.width + x]!)
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const t = tileAt(x, y)
        const sx = x * TILE_PX - cam.x
        const sy = y * TILE_PX - cam.y
        if (t === TILE.WALL) {
          // walls get a lit south face where they meet the floor
          const faceBelow = tileAt(x, y + 1) !== TILE.WALL
          ctx.fillStyle = shade(pal.wall, faceBelow ? 1.35 : 0.75)
          ctx.fillRect(sx, sy, TILE_PX, TILE_PX)
          if (faceBelow) {
            ctx.fillStyle = shade(pal.wall, 0.5)
            ctx.fillRect(sx, sy, TILE_PX, 2)
          }
          continue
        }
        ctx.fillStyle = t === TILE.RUG ? pal.rug : t === TILE.GLOW ? shade(pal.glow, 0.35) : t === TILE.DOOR ? '#0c0c14' : t === TILE.DECOR ? pal.floor : pal.floor
        ctx.fillRect(sx, sy, TILE_PX, TILE_PX)
        if (t === TILE.FLOOR && (x + y) % 2 === 0) {
          ctx.fillStyle = 'rgba(255,255,255,0.025)'
          ctx.fillRect(sx, sy, TILE_PX, TILE_PX)
        }
        if (t === TILE.GLOW) {
          ctx.fillStyle = pal.glow
          ctx.fillRect(sx + 2, sy + 2, 4, 4)
        }
        if (t === TILE.DECOR) {
          // incidental furniture: crate/plant block with outline
          ctx.fillStyle = shade(pal.decor, 0.55)
          ctx.fillRect(sx, sy + 1, TILE_PX, TILE_PX - 1)
          ctx.fillStyle = pal.decor
          ctx.fillRect(sx + 1, sy - 1, TILE_PX - 2, 5)
        }
        if (t === TILE.DOOR) {
          ctx.fillStyle = pal.glow
          ctx.fillRect(sx + 1, sy, 1, TILE_PX)
          ctx.fillRect(sx + TILE_PX - 2, sy, 1, TILE_PX)
        }
      }
    }

    // objects: distinct furniture with accent tops and glyphs
    ctx.font = '7px monospace'
    for (const o of room.objects) {
      const sx = o.position[0] * TILE_PX - cam.x
      const sy = o.position[1] * TILE_PX - cam.y
      if (sx < -TILE_PX * 2 || sy < -TILE_PX * 2 || sx > VIEW_W || sy > VIEW_H) continue
      ctx.fillStyle = '#0e0e16'
      ctx.fillRect(sx - 1, sy - 6, TILE_PX + 2, TILE_PX + 6)
      ctx.fillStyle = shade(pal.decor, 1.15)
      ctx.fillRect(sx, sy - 5, TILE_PX, TILE_PX + 4)
      ctx.fillStyle = pal.glow
      ctx.fillRect(sx, sy - 5, TILE_PX, 2)
      ctx.fillStyle = '#0e0e16'
      const glyph = o.type.includes('terminal') || o.type.includes('console') ? '>' : o.type.includes('board') ? '≡' : o.type.includes('music') || o.type.includes('stage') ? '♪' : o.type.includes('map') ? '✦' : o.type.includes('key') ? '⚿' : '□'
      ctx.fillText(glyph, sx + 2, sy + 3)
      const near = Math.hypot(o.position[0] + 0.5 - this.me.x, o.position[1] + 0.5 - this.me.y) < 1.7
      if (near) {
        ctx.fillStyle = '#ffd166'
        ctx.fillText(`${o.label} [E]`, sx - 10, sy - 8)
      }
    }

    // door labels: staggered rows so a portal wall stays readable; the full
    // label (with live count) appears when you approach the door
    this.map.doors.forEach((d, i) => {
      const sx = d.x * TILE_PX - cam.x
      const sy = d.y * TILE_PX - cam.y
      if (sx < -40 || sy < -20 || sx > VIEW_W + 40 || sy > VIEW_H + 20) return
      const near = Math.hypot(d.x + 0.5 - this.me.x, d.y + 0.5 - this.me.y) < 3.5
      let label = d.remote_server ? `⇗ ${d.label}` : d.label
      if (!near) {
        const bare = label.replace(/\s*\(\d+\)$/, '')
        label = bare.length > 9 ? `${bare.slice(0, 8)}…` : bare
      }
      ctx.fillStyle = near ? '#ffd166' : '#8a8896'
      const stagger = d.direction === 'north' || d.direction === 'south' ? (i % 2) * 8 : 0
      const ly = d.direction === 'north' ? sy + 14 + stagger : d.direction === 'south' ? sy - 6 - stagger : sy + 10
      ctx.fillText(label, Math.round(sx - label.length * 1.6), Math.round(ly))
      if (near) {
        // door peek: what's through here, live
        const entry = this.town?.directory?.find((e) => e.channel === d.channel)
        if (entry?.topic) {
          ctx.fillStyle = '#b8b6c8'
          const topic = entry.topic.length > 34 ? `${entry.topic.slice(0, 33)}…` : entry.topic
          ctx.fillText(topic, Math.round(sx - topic.length * 1.6), Math.round(ly + 9))
        }
        ctx.fillStyle = '#ffd166'
        ctx.fillText('▲', Math.round(sx + 2), Math.round(ly + (entry?.topic ? 18 : 8)))
      }
    })

    // worn paths: traffic subtly lightens the floor it crosses
    const heat = this.wornPaths.get(this.channel)
    if (heat) {
      for (const [idx, n] of heat) {
        if (n < 3) continue
        const hx = (idx % this.map.width) * TILE_PX - cam.x
        const hy = Math.floor(idx / this.map.width) * TILE_PX - cam.y
        if (hx < -TILE_PX || hy < -TILE_PX || hx > VIEW_W || hy > VIEW_H) continue
        ctx.fillStyle = `rgba(255,250,235,${Math.min(0.07, n * 0.0015).toFixed(4)})`
        ctx.fillRect(hx, hy, TILE_PX, TILE_PX)
      }
    }

    // campfires: threads as places (spec §9.3)
    const nowT = performance.now()
    for (const t of this.threadPlaces) {
      const fx = t.x * TILE_PX - cam.x
      const fy = t.y * TILE_PX - cam.y
      if (fx < -16 || fy < -16 || fx > VIEW_W + 16 || fy > VIEW_H + 16) continue
      const active = t.root === this.activeThread
      // log ring
      ctx.fillStyle = '#4a3520'
      ctx.fillRect(Math.round(fx - 4), Math.round(fy + 2), 3, 2)
      ctx.fillRect(Math.round(fx + 2), Math.round(fy + 2), 3, 2)
      ctx.fillRect(Math.round(fx - 1), Math.round(fy + 3), 3, 2)
      // flame flicker
      const flick = Math.sin(nowT / 110 + t.x) > 0
      ctx.fillStyle = active ? '#ffd166' : '#e8853a'
      ctx.fillRect(Math.round(fx - 1), Math.round(fy - (flick ? 3 : 2)), 3, flick ? 5 : 4)
      ctx.fillStyle = '#fff3c4'
      ctx.fillRect(Math.round(fx), Math.round(fy - 1), 1, 2)
      ctx.font = '7px monospace'
      ctx.fillStyle = active ? '#ffd166' : '#8a8896'
      const label = active ? `🔥 ${t.preview.slice(0, 22)}… (${t.count})` : `thread (${t.count})`
      ctx.fillText(label, Math.round(fx - label.length * 1.6), Math.round(fy - 8))
    }

    // the gallery: real channel media hanging on the wall
    for (const g of this.galleryWall) {
      const gx = Math.round(g.x * TILE_PX - cam.x)
      const gy = Math.round(g.y * TILE_PX - cam.y)
      if (gx < -20 || gy < -20 || gx > VIEW_W + 20 || gy > VIEW_H + 20) continue
      ctx.fillStyle = '#6b5433'
      ctx.fillRect(gx - 1, gy - 1, 14, 11)
      const img = this.galleryImages.get(g.url)
      if (img?.complete && img.naturalWidth > 0) {
        try {
          ctx.drawImage(img, gx, gy, 12, 9)
        } catch {
          /* broken image */
        }
      } else {
        ctx.fillStyle = '#2a2a38'
        ctx.fillRect(gx, gy, 12, 9)
      }
      const near = Math.hypot(g.x + 0.7 - this.me.x, g.y + 1.4 - this.me.y) < 2.2
      if (near) {
        ctx.font = '7px monospace'
        ctx.fillStyle = '#ffd166'
        ctx.fillText(`by ${g.from} [E]`, gx - 12, gy + 18)
      }
    }

    // the room's critter
    if (this.critter) {
      const cx = this.critter.x * TILE_PX - cam.x
      const cy = this.critter.y * TILE_PX - cam.y
      const colors = ['#c9a227', '#9aa7b5', '#b78bd6', '#7fc98f']
      ctx.fillStyle = colors[this.critter.kind]!
      const scurry = Math.abs(this.critter.vx) + Math.abs(this.critter.vy) > 1
      ctx.fillRect(Math.round(cx), Math.round(cy - 2), 3, 2)
      ctx.fillRect(Math.round(cx + (scurry ? 3 : 2)), Math.round(cy - 3), 2, 2) // head
      if (this.critter.kind === 1 && Math.sin(performance.now() / 120) > 0) {
        ctx.fillRect(Math.round(cx + 1), Math.round(cy - 4), 1, 1) // pigeon flutter
      }
    }

    // footstep dust
    const nowMs = performance.now()
    for (const f of this.footsteps) {
      const alpha = Math.max(0, (f.until - nowMs) / 900) * 0.22
      ctx.fillStyle = `rgba(230,230,255,${alpha.toFixed(3)})`
      ctx.fillRect(Math.round(f.x * TILE_PX - cam.x), Math.round(f.y * TILE_PX - cam.y + 2), 2, 1)
    }

    // remote players, parked members, then me (draw order by y)
    const drawables: { x: number; y: number; did: string; facing: WorldPosition['facing']; moving: boolean; me: boolean; parked?: boolean }[] = []
    for (const r of this.remotes.values()) {
      drawables.push({ x: r.x, y: r.y, did: r.did, facing: r.facing, moving: r.animation === 'walk', me: false })
    }
    for (const m of this.members.values()) {
      if (this.isMe(m.did) || this.remotes.has(m.did)) continue
      const spot = this.parkedSpot(m.did)
      if (spot) drawables.push({ x: spot.x, y: spot.y, did: m.did, facing: 'south', moving: false, me: false, parked: true })
    }
    if (this.identity) {
      drawables.push({ x: this.me.x, y: this.me.y, did: avatarDid(this.identity), facing: this.me.facing, moving: this.me.moving, me: true })
    }
    drawables.sort((a, b) => a.y - b.y)
    for (const d of drawables) this.drawPlayer(d, cam)

    // familiars: a third of souls travel with a small companion walking their trail
    for (const d of drawables) {
      const fam = familiarFor(d.did)
      if (!fam) continue
      const trail = this.trails.get(d.did)
      const spot = trail && trail.length > 4 ? trail[Math.max(0, trail.length - 5)]! : { x: d.x - 1, y: d.y }
      const fx = Math.round(spot.x * TILE_PX - cam.x - 6)
      const fy = Math.round(spot.y * TILE_PX - cam.y)
      const hop = Math.sin(performance.now() / 200 + d.x) > 0.6 ? 1 : 0
      ctx.fillStyle = fam.color
      if (fam.kind === 'wisp') {
        ctx.globalAlpha = 0.8
        ctx.fillRect(fx, fy - 4 - hop, 2, 2)
        ctx.fillRect(fx + 1, fy - 6 - hop, 1, 1)
        ctx.globalAlpha = 1
      } else if (fam.kind === 'bird') {
        ctx.fillRect(fx, fy - 3 - hop, 3, 2)
        ctx.fillRect(fx + 3, fy - 4 - hop, 1, 1)
      } else if (fam.kind === 'beetle') {
        ctx.fillRect(fx, fy - 2, 3, 2)
      } else {
        ctx.fillRect(fx, fy - 2 - hop, 3, 2 + hop)
      }
    }

    // bubbles
    for (const b of this.bubbles) {
      const target = this.findPlayer(b.did)
      if (!target) continue
      this.drawBubble(target.x * TILE_PX - cam.x, (target.y - 3.2) * TILE_PX - cam.y, b)
    }

    // emotes
    ctx.font = '8px monospace'
    for (const e of this.emotes) {
      const target = this.findPlayer(e.did)
      if (!target) continue
      const age = 1 - (e.until - performance.now()) / 1800
      ctx.fillText(e.emoji, target.x * TILE_PX - cam.x - 4, (target.y - 3) * TILE_PX - cam.y - age * 8)
    }

    // time of day breathes through the palette (local clock, subtle)
    const hour = new Date().getHours() + new Date().getMinutes() / 60
    let tint: string | null = null
    if (hour >= 5 && hour < 8) tint = `rgba(255,190,120,${(0.09 * (1 - Math.abs(hour - 6.5) / 1.5)).toFixed(3)})`
    else if (hour >= 17 && hour < 21) tint = `rgba(190,110,200,${(0.10 * (1 - Math.abs(hour - 19) / 2)).toFixed(3)})`
    else if (hour >= 21 || hour < 5) tint = 'rgba(40,60,140,0.10)'
    if (tint) {
      ctx.fillStyle = tint
      ctx.fillRect(0, 0, VIEW_W, VIEW_H)
    }
  }

  private parkedLayout = new Map<string, { x: number; y: number }>()
  private parkedLayoutKey = ''

  /** Members on conventional clients broadcast no position; park each at a
   *  deterministic DID-derived spot. The layout is computed for the whole
   *  roster at once (in sorted DID order) so nobody stacks on anyone else —
   *  same room + same members always yields the same arrangement. */
  private computeParkedLayout(): void {
    if (!this.map) return
    const parked = [...this.members.keys()]
      .filter((did) => !this.isMe(did) && !this.remotes.has(did))
      .sort()
    const key = `${this.channel}|${parked.join(',')}`
    if (key === this.parkedLayoutKey) return
    this.parkedLayoutKey = key
    this.parkedLayout.clear()
    const taken: { x: number; y: number }[] = []
    const clear = (x: number, y: number) =>
      taken.every((t) => Math.hypot(t.x - x, t.y - y) >= 2.2) &&
      Math.hypot(this.map!.spawn[0] + 0.5 - x, this.map!.spawn[1] + 0.5 - y) >= 2
    for (const did of parked) {
      const seed = new Uint8Array(16)
      for (let i = 0; i < did.length; i++) seed[i % 16] = (seed[i % 16]! * 31 + did.charCodeAt(i)) & 0xff
      const rng = seededPrng(seed)
      let spot: { x: number; y: number } | null = null
      for (let tries = 0; tries < 80 && !spot; tries++) {
        const x = 2 + rng() * (this.map.width - 4)
        const y = 2 + rng() * (this.map.height - 4)
        // relax the personal-space requirement as attempts run out (crowded rooms)
        if (isWalkable(this.map, x, y) && (tries > 60 || clear(x, y))) spot = { x, y }
      }
      if (!spot) spot = { x: this.map.spawn[0] + 1.5 + taken.length, y: this.map.spawn[1] + 0.5 }
      taken.push(spot)
      this.parkedLayout.set(did, spot)
    }
  }

  private parkedSpot(did: string): { x: number; y: number } | null {
    this.computeParkedLayout()
    return this.parkedLayout.get(did) ?? null
  }

  private findPlayer(did: string): { x: number; y: number } | null {
    if (this.isMe(did)) return { x: this.me.x, y: this.me.y }
    const r = this.remotes.get(did)
    if (r) return { x: r.x, y: r.y }
    if (this.members.has(did)) return this.parkedSpot(did)
    return null
  }

  private drawPlayer(d: { x: number; y: number; did: string; facing: WorldPosition['facing']; moving: boolean; me: boolean; parked?: boolean }, cam: { x: number; y: number }): void {
    const ctx = this.ctx
    const member = this.members.get(d.did)
    const spriteDid = d.me ? d.did : (member?.avatar_did ?? d.did)
    let set = this.spriteSets.get(spriteDid)
    if (!set) {
      void spriteFor(spriteDid).then((s) => this.spriteSets.set(spriteDid, s))
    }
    const sx = d.x * TILE_PX - cam.x
    // idle life: everyone breathes on their own DID-phased rhythm
    let idleBob = 0
    if (!d.moving) {
      let h = 0
      for (const c of d.did) h = (h * 31 + c.charCodeAt(0)) | 0
      idleBob = Math.sin(performance.now() / 700 + (h % 100)) > 0.75 ? 1 : 0
    }
    // airborne? (space to jump — yours locally, everyone else's via presence)
    let jumpOff = 0
    const nowJ = performance.now()
    if (d.me && nowJ < this.jumpUntil) {
      const p = 1 - (this.jumpUntil - nowJ) / 550
      jumpOff = Math.sin(p * Math.PI) * 7
    } else if (!d.me) {
      const js = this.remoteJumps.get(d.did)
      if (js !== undefined && nowJ - js < 550) jumpOff = Math.sin(((nowJ - js) / 550) * Math.PI) * 7
    }
    if (jumpOff > 0.5) {
      // grounded shadow while airborne
      ctx.fillStyle = 'rgba(0,0,0,0.35)'
      ctx.fillRect(Math.round(sx - 4), Math.round(d.y * TILE_PX - cam.y + 2), 8, 2)
    }
    const sy = d.y * TILE_PX - cam.y + idleBob - jumpOff
    const frame = d.moving ? (Math.floor(this.walkPhase) % 2 === 0 ? 1 : 2) : 0
    if (set) {
      const img = set.frames.get(`${d.facing}:${frame}`)!
      if (d.parked) ctx.globalAlpha = 0.75
      ctx.drawImage(img, Math.round(sx - 8), Math.round(sy - 20))
      ctx.globalAlpha = 1
    } else {
      ctx.fillStyle = '#888'
      ctx.fillRect(sx - 4, sy - 12, 8, 12)
    }
    // name tag + badges
    const name = d.me ? this.identity?.display_name ?? 'me' : member?.display_name ?? shortDid(d.did)
    ctx.font = '7px monospace'
    ctx.fillStyle = member?.is_agent ? '#ffb454' : d.me ? '#67c26b' : d.parked ? '#8a8896' : '#d8d6c8'
    const label = member?.is_agent ? `⚙ ${name}` : member?.verification_status === 'verified' ? `◈ ${name}` : name
    ctx.fillText(label, Math.round(sx - label.length * 2), Math.round(sy - 22))
    // living presence: real typing + away signals
    const nickKey = (member?.nick ?? member?.display_name ?? '').toLowerCase()
    if (nickKey && this.typingNicks.has(nickKey)) {
      const phase = Math.floor(performance.now() / 250) % 3
      ctx.fillStyle = '#56c9d6'
      ctx.fillText('·'.repeat(phase + 1), Math.round(sx - 2), Math.round(sy - 28))
    } else if (nickKey && this.awayNicks.has(nickKey)) {
      ctx.fillStyle = '#8a8896'
      ctx.fillText('💤', Math.round(sx + 4), Math.round(sy - 26))
    }
  }

  private drawBubble(cx: number, cy: number, b: Bubble): void {
    const ctx = this.ctx
    ctx.font = '7px monospace'
    const w = Math.max(...b.lines.map((l) => l.length)) * 4.4 + 8
    const h = b.lines.length * 8 + 6
    const x = Math.min(VIEW_W - w - 2, Math.max(2, cx - w / 2))
    const y = Math.max(2, cy - h)
    ctx.fillStyle = b.kind === 'sealed' ? 'rgba(40,40,60,0.92)' : 'rgba(240,238,225,0.94)'
    ctx.fillRect(x, y, w, h)
    ctx.fillStyle = b.kind === 'sealed' ? '#9a98b0' : b.kind === 'code' ? '#2a6a4a' : '#1a1a24'
    b.lines.forEach((line, i) => ctx.fillText(line, x + 4, y + 8 + i * 8))
  }

  // ---------- direct messages (real IRC PRIVMSGs, spec §6.5 private encounters) ----------

  private onDmIn(fromNick: string, text: string, ts: number): void {
    // courier stars: an agent's verified quest completion carries ⭐s
    if (/quest complete/i.test(text)) {
      const stars = (text.match(/⭐/g) ?? []).length || 1
      this.journal.addStars(stars)
      this.updateSparkHud()
      this.toast(`${'⭐'.repeat(stars)} courier run complete — ${this.journal.stars()} stars`)
      this.audio.stinger('spark')
    }
    const key = fromNick.toLowerCase()
    const thread = this.dmThreads.get(key) ?? []
    thread.push({ from: fromNick, text, self: false, ts })
    this.dmThreads.set(key, thread)
    this.audio.stinger('mention')
    if (this.activeDm !== key || el('dmpanel').classList.contains('hidden')) {
      this.toast(`💬 ${fromNick}: ${text.slice(0, 60)}`)
      this.openDm(fromNick)
    } else {
      this.renderDm()
    }
  }

  private openDm(nick: string): void {
    this.activeDm = nick.toLowerCase()
    el('dm-peer').textContent = nick
    el('dmpanel').classList.remove('hidden')
    this.renderDm()
  }

  private renderDm(): void {
    if (!this.activeDm) return
    const log = el('dm-log')
    const thread = this.dmThreads.get(this.activeDm) ?? []
    log.innerHTML = thread
      .slice(-60)
      .map((m) => `<div class="${m.self ? 'self' : 'them'}"><span class="who">${m.self ? 'you' : escapeHtml(m.from)}</span>${escapeHtml(m.text)}</div>`)
      .join('')
    log.scrollTop = log.scrollHeight
  }

  private sendDm(): void {
    const input = el<HTMLInputElement>('dm-input')
    const text = input.value.trim()
    const conn = this.conn
    if (!text || !this.activeDm || !conn || !('sendDm' in conn)) return
    const peer = el('dm-peer').textContent ?? this.activeDm
    ;(conn as FreeqBackend).sendDm(peer, text)
    const thread = this.dmThreads.get(this.activeDm) ?? []
    thread.push({ from: 'you', text, self: true, ts: Date.now() })
    this.dmThreads.set(this.activeDm, thread)
    input.value = ''
    this.renderDm()
  }

  // ---------- sparks: unique players touched (signed autographs) ----------

  private updateSparkHud(): void {
    const stars = this.journal.stars()
    el('spark-hud').textContent = `✦ ${this.sparks.count()}${stars ? ` ⭐ ${stars}` : ''}`
  }

  private earnSpark(name: string): void {
    const count = this.sparks.count()
    this.updateSparkHud()
    this.toast(`✦ spark: ${name} — ${count} unique ${count === 1 ? 'soul' : 'souls'} touched (${titleFor(count)})`)
    this.audio.stinger('spark')
  }

  /** Runs a few times a second: touching someone for the first time collects them. */
  private scanForTouches(now: number): void {
    if (!this.identity || now - this.lastTouchScan < 400) return
    this.lastTouchScan = now
    const near = (x: number, y: number) => Math.hypot(x - this.me.x, y - this.me.y) < 1.35
    // live players: exchange signed autographs over TAGMSG
    for (const [did, r] of this.remotes) {
      if (!near(r.x, r.y)) continue
      const member = this.members.get(did)
      if (!member) continue
      const cooldownKey = `live:${did}`
      if ((this.touchCooldown.get(cooldownKey) ?? 0) > now) continue
      this.touchCooldown.set(cooldownKey, now + 15_000)
      const isNew = this.sparks.add({
        did,
        nick: member.nick ?? member.display_name,
        name: member.display_name,
        channel: this.channel,
        ts: Date.now(),
        verified: false,
        selfDid: this.identity.did,
      })
      if (isNew) this.earnSpark(member.display_name)
      // send our signed side regardless — it lets their book verify us,
      // and their reply upgrades our entry to a verified autograph.
      // Signatures always come from the device did:key (OAuth identities
      // declare it as signerDid in the tag).
      const conn = this.conn
      if (conn && 'sendTouch' in conn && member.nick) {
        const ts = Date.now()
        const sig = signTouch(this.identity.device_did, did, ts, this.identity.keypair.secretKey)
        const signer = this.identity.device_did !== this.identity.did ? this.identity.device_did : undefined
        ;(conn as FreeqBackend).sendTouch(this.channel, member.nick, ts, sig, signer)
      }
    }
    // parked members (conventional clients): an unsigned brush past
    for (const m of this.members.values()) {
      if (this.isMe(m.did) || this.remotes.has(m.did)) continue
      const spot = this.parkedSpot(m.did)
      if (!spot || !near(spot.x, spot.y)) continue
      const isNew = this.sparks.add({
        did: m.did,
        nick: m.nick ?? m.display_name,
        name: m.display_name,
        channel: this.channel,
        ts: Date.now(),
        verified: false,
        selfDid: this.identity.did,
      })
      if (isNew) this.earnSpark(m.display_name)
    }
  }

  /** Someone touched us: verify their signature and reciprocate once. */
  private onTouchIn(fromNick: string, ts: number, sig: string, signerDid?: string): void {
    if (!this.identity) return
    const member = [...this.members.values()].find((m) => (m.nick ?? m.display_name).toLowerCase() === fromNick.toLowerCase())
    if (!member) return
    // the signing key is the declared device did:key (OAuth users) or the
    // member's own did:key; the server's nick attribution binds the two
    const signer = signerDid ?? member.did
    const verified = verifyTouch(signer, this.identity.did, ts, sig)
    const isNew = this.sparks.add({
      did: member.did,
      nick: fromNick,
      name: member.display_name,
      channel: this.channel,
      ts,
      verified,
      sig: verified ? sig : undefined,
      selfDid: this.identity.did,
    })
    if (isNew) this.earnSpark(member.display_name)
    else this.updateSparkHud()
    // reciprocate so their side gets a verified autograph too (cooldown-guarded)
    const cooldownKey = `reply:${member.did}`
    const now = performance.now()
    if ((this.touchCooldown.get(cooldownKey) ?? 0) > now) return
    this.touchCooldown.set(cooldownKey, now + 15_000)
    const conn = this.conn
    if (conn && 'sendTouch' in conn) {
      const myTs = Date.now()
      const mySig = signTouch(this.identity.device_did, member.did, myTs, this.identity.keypair.secretKey)
      const mySigner = this.identity.device_did !== this.identity.did ? this.identity.device_did : undefined
      ;(conn as FreeqBackend).sendTouch(this.channel, fromNick, myTs, mySig, mySigner)
    }
  }

  /** Introductions: two people first-touch each other while standing with you. */
  private onTouchObserved(fromNick: string, toNick: string): void {
    if (!this.identity) return
    const now = Date.now()
    const key = `${fromNick.toLowerCase()}>${toNick.toLowerCase()}`
    const reverse = `${toNick.toLowerCase()}>${fromNick.toLowerCase()}`
    this.observedTouches.set(key, now)
    for (const [k, t] of this.observedTouches) if (now - t > 30_000) this.observedTouches.delete(k)
    if (!this.observedTouches.has(reverse)) return
    // both directions witnessed — were they both near us?
    const findByNick = (nick: string) => [...this.members.values()].find((m) => (m.nick ?? m.display_name).toLowerCase() === nick.toLowerCase())
    const a = findByNick(fromNick)
    const b = findByNick(toNick)
    if (!a || !b) return
    const posOf = (did: string) => this.findPlayer(did)
    const pa = posOf(a.did)
    const pb = posOf(b.did)
    const nearMe = (p: { x: number; y: number } | null) => p && Math.hypot(p.x - this.me.x, p.y - this.me.y) < 4.5
    if (nearMe(pa) && nearMe(pb) && this.journal.introduce(a.did, b.did)) {
      this.toast(`🤝 you introduced ${a.display_name} & ${b.display_name} — ${this.journal.introductions()} introductions`)
      this.audio.stinger('spark')
      this.updateSparkHud()
    }
  }

  private openSparkBook(): void {
    el('spark-count').textContent = String(this.sparks.count())
    el('spark-title').textContent = titleFor(this.sparks.count())
    const grid = el('spark-grid')
    grid.innerHTML = this.sparks
      .entries()
      .slice(0, 60)
      .map(
        (e, i) =>
          `<div style="text-align:center" class="spark-card" data-did="${escapeHtml(e.did)}" title="click to play their leitmotif">` +
          `<canvas id="spark-av-${i}" width="32" height="48" style="image-rendering:pixelated;border:1px solid var(--border);cursor:pointer"></canvas>` +
          `<div style="font-size:0.75rem">${e.verified ? '◈ ' : ''}${escapeHtml(e.name)} <span style="color:var(--cyan)">♪</span></div>` +
          `<div style="font-size:0.68rem;color:var(--dim)">${escapeHtml(e.channel)}</div></div>`,
      )
      .join('')
    this.sparks.entries().slice(0, 60).forEach((e, i) => {
      const canvas = document.getElementById(`spark-av-${i}`) as HTMLCanvasElement | null
      if (canvas) void drawPreview(e.did, canvas)
    })
    // the music box: every soul you've met carries a tune
    for (const card of grid.querySelectorAll<HTMLElement>('.spark-card')) {
      card.addEventListener('click', () => void this.audio.playLeitmotif(card.dataset.did!))
    }
    // journal page: stamps + deeds
    const stamps = this.journal.stamps()
    el('journal-explorer').textContent = `${explorerTitle(this.journal.stampCount())} · ${this.journal.stampCount()} places`
    el('journal-stamps').innerHTML = stamps
      .slice(0, 40)
      .map((s) => `<span style="border:1px solid var(--border);padding:1px 6px;margin:2px;display:inline-block;color:var(--cyan)">📍 ${escapeHtml(s.channel)}</span>`)
      .join('')
    el('journal-deeds').textContent = [
      this.journal.stars() ? `⭐ ${this.journal.stars()} courier stars` : null,
      this.journal.rekindled() ? `🔥 ${this.journal.rekindled()} rooms rekindled` : null,
      this.journal.introductions() ? `🤝 ${this.journal.introductions()} introductions` : null,
    ].filter(Boolean).join(' · ') || 'no deeds yet — ask the cartographer for a quest'
    el('sparkbook').classList.remove('hidden')
  }

  // ---------- test hook (used by the e2e suite; harmless in production) ----------

  testHook(): Record<string, unknown> {
    return {
      state: () => ({
        channel: this.channel,
        town: this.town?.server,
        did: this.identity?.did,
        x: this.me.x,
        y: this.me.y,
        members: [...this.members.values()].map((m) => m.display_name),
        remotes: this.remotes.size,
        backend: this.backendKind(),
        sparks: this.sparks.count(),
        jumping: performance.now() < this.jumpUntil,
      }),
      teleport: (x: number, y: number) => {
        this.me.x = x
        this.me.y = y
        this.checkDoor()
      },
      join: (channel: string) => this.conn?.join(channel),
      doors: () => this.map?.doors ?? [],
      directory: () => this.town?.directory ?? [],
      audio: () => this.audio.status(),
    }
  }

  private toast(text: string): void {
    const t = document.createElement('div')
    t.className = 'toast'
    t.textContent = text
    document.body.appendChild(t)
    setTimeout(() => t.remove(), 3200)
  }
}

function shade(hex: string, factor: number): string {
  const r = Math.min(255, Math.round(parseInt(hex.slice(1, 3), 16) * factor))
  const g = Math.min(255, Math.round(parseInt(hex.slice(3, 5), 16) * factor))
  const b = Math.min(255, Math.round(parseInt(hex.slice(5, 7), 16) * factor))
  return `rgb(${r},${g},${b})`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function shortDid(did: string): string {
  return did.length > 24 ? `${did.slice(0, 14)}…${did.slice(-6)}` : did
}
