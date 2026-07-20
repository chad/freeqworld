// FreeqWorld client application: world state, canvas renderer, input, UI.
// The world is a projection — every social fact on screen came from a
// Freeq frame; the renderer holds no social state of its own (spec §4.2).

import type { DurableEvent, MemberInfo, RoomManifest, ServerFrame, TownProfile, WorldPosition } from '../../shared/src/protocol'
import { verifyEvent } from '../../shared/src/signing'
import { generateTilemap, isWalkable, TILE, type Tilemap } from '../../shared/src/world'
import type { MusicState } from '../../shared/src/music'
import { ChiptuneEngine } from './audio'
import { avatarDid, createIdentity, loadIdentity, resolveBlueskyHandle, type Identity } from './identity'
import { TownConnection } from './net'
import { drawPreview, spriteFor, type SpriteSet } from './sprites'
import { wrapBubble } from './textwrap'
import { decryptMessage, deriveRoomKey, encryptMessage, type CipherEnvelope } from './vaultCrypto'

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
  private conn: TownConnection | null = null
  private town: TownProfile | null = null
  private rooms = new Map<string, RoomManifest>()
  private channel = '#lobby'
  private map: Tilemap | null = null
  private members = new Map<string, MemberInfo>()
  private remotes = new Map<string, RemotePlayer>()
  private bubbles: Bubble[] = []
  private emotes: Emote[] = []
  private log: DurableEvent[] = []
  private lastMessageId: string | null = null
  private me = { x: 10, y: 10, facing: 'south' as WorldPosition['facing'], moving: false }
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
  private canvas = el<HTMLCanvasElement>('world')
  private ctx = this.canvas.getContext('2d')!
  private spriteSets = new Map<string, SpriteSet>()

  start(): void {
    this.canvas.width = VIEW_W
    this.canvas.height = VIEW_H
    this.fitCanvas()
    window.addEventListener('resize', () => this.fitCanvas())
    this.bindUi()
    this.identity = loadIdentity()
    if (this.identity) {
      el('landing').classList.add('hidden')
      this.connect(location.origin)
    } else {
      // read-only spectator behind the landing card (spec §6.1)
      this.connectSpectator(location.origin)
    }
    requestAnimationFrame(() => this.frame())
  }

  // ---------- connection ----------

  private serverUrlOverride(): string {
    return new URLSearchParams(location.search).get('server') ?? location.origin
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

  private connect(url: string, channel = this.channel): void {
    this.conn?.close()
    this.remotes.clear()
    this.conn = new TownConnection({
      serverUrl: url,
      channel,
      identity: this.identity,
      avatarDid: this.identity ? avatarDid(this.identity) : undefined,
      onFrame: (f) => this.onFrame(f),
      onRawIn: (f) => this.inspect('in', f),
      onOpen: (rtt) => {
        this.rtt = rtt
        this.updateInspectorMeta()
      },
      onClose: () => this.toast('connection lost — reconnecting…'),
    })
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
        this.onMember(frame.member, frame.online)
        break
      case 'music':
        this.audio.setState(frame.state as MusicState)
        break
      case 'error':
        this.toast(frame.message)
        break
    }
  }

  private enterRoom(channel: string, history: DurableEvent[], members: MemberInfo[]): void {
    this.channel = channel
    const room = this.rooms.get(channel)
    if (!room) return
    this.map = generateTilemap(room)
    this.me.x = this.map.spawn[0] + 0.5
    this.me.y = this.map.spawn[1] + 0.5
    this.moveTarget = null
    this.remotes.clear()
    this.bubbles = []
    this.members = new Map(members.map((m) => [m.did, m]))
    this.log = [...history]
    this.vaultPlain.clear()
    this.audio.setRoom(room.music.bpm, channel)
    document.querySelector('[data-testid="header-loc"]')!.textContent = `${this.town?.name ?? '—'} · ${room.name} · ${channel}`
    document.querySelector('[data-testid="header-topic"]')!.textContent = room.topic
    this.renderTranscript()
    this.renderMembers()
    this.updateVaultUi()
    if (room.encrypted && !this.vaultKey) this.promptVaultKey()
    if (room.encrypted) void this.decryptVisible()
    this.updateInspectorMeta()
  }

  private onDurable(durable: DurableEvent, live: boolean): void {
    this.log.push(durable)
    if (this.log.length > 500) this.log.shift()
    if (durable.kind === 'message') {
      const msg = durable.event
      this.lastMessageId = msg.id
      if (msg.enc) {
        void this.tryDecrypt(msg.id, msg.enc).then(() => {
          this.renderTranscript()
          if (live) this.addBubbleFor(msg.sender, this.vaultPlain.get(msg.id) ?? null)
        })
      } else if (live) {
        this.addBubbleFor(msg.sender, msg.content, msg.type === 'code' ? 'code' : 'text')
        this.audio.speechBlip(msg.sender)
        if (this.identity && this.mentionsMe(msg.content)) this.audio.stinger('mention')
      }
    }
    if (durable.kind === 'reaction' && live) {
      this.emotes.push({ did: durable.event.actor, emoji: durable.event.reaction, until: performance.now() + 1800 })
    }
    this.renderTranscript()
  }

  private onPresence(positions: WorldPosition[]): void {
    const seen = new Set<string>()
    for (const p of positions) {
      if (p.did === this.identity?.did) continue
      seen.add(p.did)
      const existing = this.remotes.get(p.did)
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

  private onMember(member: MemberInfo, online: boolean): void {
    if (online) {
      const isNew = !this.members.has(member.did)
      this.members.set(member.did, member)
      if (isNew) {
        this.transcriptSystem(`${member.display_name} arrived`)
        void this.audio.playLeitmotif(member.avatar_did ?? member.did)
      }
    } else {
      this.members.delete(member.did)
      this.remotes.delete(member.did)
      this.transcriptSystem(`${member.display_name} left`)
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
    if (this.vaultKey) {
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
    if (room?.encrypted) {
      if (!this.vaultKey) {
        this.toast('vault key still sealed')
        return
      }
      const env = await encryptMessage(this.vaultKey, content)
      this.conn.sendMessage(this.channel, '', env)
    } else {
      this.conn.sendMessage(this.channel, content)
    }
    input.value = ''
  }

  // ---------- transcript / members ----------

  private renderTranscript(): void {
    const t = el('transcript')
    const rows: string[] = []
    for (const e of this.log.slice(-200)) {
      if (e.kind === 'message') {
        const m = e.event
        const member = this.members.get(m.sender)
        const isAgent = Boolean(m.provenance) || member?.is_agent
        const who = `<span class="who${isAgent ? ' agent' : ''}" data-did="${m.sender}">${escapeHtml(m.sender_name)}${isAgent ? ' ⚙' : ''}</span>`
        const origin = m.origin_server !== this.town?.server ? ` <span class="origin">[via ${escapeHtml(m.origin_server)}]</span>` : ''
        if (m.enc) {
          const plain = this.vaultPlain.get(m.id)
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
      ok = verifyEvent(base, signature as string, signer)
      summary = `${durable.kind} ${String(ev.id).slice(0, 8)} from ${shortDid(signer)} origin=${ev.origin_server} sig=${ok ? 'VERIFIED' : 'INVALID'}`
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
    el('insp-meta').innerHTML = [
      `server: ${this.conn?.serverUrl ?? '—'} (${this.town?.server ?? '?'})`,
      `transport: WebSocket/TLS-capable · rtt≈${this.rtt.toFixed(0)}ms`,
      `channel: ${this.channel} · durable log + ephemeral presence split`,
      `raw storage: <a href="${this.conn?.serverUrl}/api/debug/log/${encodeURIComponent(this.channel)}" target="_blank">/api/debug/log/${this.channel}</a>`,
    ].join('<br>')
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
    el('send-btn').addEventListener('click', () => void this.sendCurrentMessage())
    el<HTMLInputElement>('msg-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void this.sendCurrentMessage()
      if (e.key === 'Escape') (e.target as HTMLInputElement).blur()
      e.stopPropagation()
    })
    for (const mode of ['world', 'split', 'chat', 'dev']) {
      el(`mode-${mode}`).addEventListener('click', () => this.setMode(mode))
    }
    el('sound-btn').addEventListener('click', () => {
      const muted = this.audio.toggle()
      el('sound-btn').textContent = muted ? '♪ off' : '♪ on'
    })
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
    } else if (k === ' ') {
      this.interact()
      e.preventDefault()
    } else if (e.key === 'Escape') {
      for (const id of ['idcard', 'objcard', 'travel']) el(id).classList.add('hidden')
    }
  }

  private doGuestLogin(): void {
    const name = el<HTMLInputElement>('name-input').value.trim() || `wanderer-${Math.floor(Math.random() * 900 + 100)}`
    this.identity = createIdentity(name)
    el('landing').classList.add('hidden')
    this.connect(this.serverUrlOverride())
    this.toast(`your DID: ${shortDid(this.identity.did)} — your avatar is derived from it`)
  }

  private async doBskyLogin(): Promise<void> {
    const handle = el<HTMLInputElement>('bsky-input').value.trim()
    if (!handle) return
    try {
      const did = await resolveBlueskyHandle(handle)
      this.identity = createIdentity(handle.split('.')[0] ?? handle, { did, handle })
      el('landing').classList.add('hidden')
      this.connect(this.serverUrlOverride())
      this.toast(`linked ${handle} → ${shortDid(did)} · avatar derived from your AT Protocol DID`)
    } catch {
      this.toast('could not resolve that handle — try guest entry')
    }
  }

  private interact(): void {
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
    const bodies: Record<string, string> = {
      'how-terminal':
        'This "game" is a Freeq client. Rooms are channels; every message is an ed25519-signed durable event; movement is ephemeral presence that expires and is never logged. Open Dev mode to watch the raw protocol, or fetch /api/debug/log/%23lobby to read the store itself.',
      'peer-board': `Peered towns: ${this.town?.peers.map((p) => `${p.server} @ ${p.url}`).join(' · ') || 'none'}. Messages in #federation cross with signatures intact.`,
      'key-panel': 'Vault key status is client-side only. The server relays AES-GCM envelopes it cannot open — check the raw log and see for yourself.',
      kiosk: 'Rooms: ' + [...this.rooms.values()].map((r) => `${r.name} (${r.channel})`).join(' · '),
    }
    el('obj-body').textContent = bodies[o.id] ?? `A ${o.type}. Interactions: ${o.capabilities.join(', ')}.`
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
    // click on a player?
    for (const r of this.remotes.values()) {
      if (Math.abs(r.x - wx) < 1.2 && Math.abs(r.y - 1.2 - wy) < 1.6) {
        this.showIdentityCard(r.did)
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
    this.connect(url, '#federation')
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
    for (const r of this.remotes.values()) {
      r.x += (r.tx - r.x) * Math.min(1, dt * 12)
      r.y += (r.ty - r.y) * Math.min(1, dt * 12)
    }
    this.bubbles = this.bubbles.filter((b) => b.until > now)
    this.emotes = this.emotes.filter((e) => e.until > now)
    this.draw()
    requestAnimationFrame(() => this.frame())
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
        ctx.fillText(`${o.label} [space]`, sx - 10, sy - 8)
      }
    }

    // door labels
    ctx.fillStyle = '#8a8896'
    for (const d of this.map.doors) {
      const sx = d.x * TILE_PX - cam.x
      const sy = d.y * TILE_PX - cam.y
      if (sx < 0 || sy < 0 || sx > VIEW_W || sy > VIEW_H) continue
      const label = d.remote_server ? `⇗ ${d.label}` : d.label
      ctx.fillText(label, sx - label.length * 1.6, sy + (d.direction === 'north' ? 14 : d.direction === 'south' ? -6 : 10))
    }

    // remote players then me (draw order by y)
    const drawables: { x: number; y: number; did: string; facing: WorldPosition['facing']; moving: boolean; me: boolean }[] = []
    for (const r of this.remotes.values()) {
      drawables.push({ x: r.x, y: r.y, did: r.did, facing: r.facing, moving: r.animation === 'walk', me: false })
    }
    if (this.identity) {
      drawables.push({ x: this.me.x, y: this.me.y, did: avatarDid(this.identity), facing: this.me.facing, moving: this.me.moving, me: true })
    }
    drawables.sort((a, b) => a.y - b.y)
    for (const d of drawables) this.drawPlayer(d, cam)

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
  }

  private findPlayer(did: string): { x: number; y: number } | null {
    if (this.identity && (did === this.identity.did || did === avatarDid(this.identity))) return { x: this.me.x, y: this.me.y }
    const r = this.remotes.get(did)
    return r ? { x: r.x, y: r.y } : null
  }

  private drawPlayer(d: { x: number; y: number; did: string; facing: WorldPosition['facing']; moving: boolean; me: boolean }, cam: { x: number; y: number }): void {
    const ctx = this.ctx
    const member = this.members.get(d.did)
    const spriteDid = d.me ? d.did : (member?.avatar_did ?? d.did)
    let set = this.spriteSets.get(spriteDid)
    if (!set) {
      void spriteFor(spriteDid).then((s) => this.spriteSets.set(spriteDid, s))
    }
    const sx = d.x * TILE_PX - cam.x
    const sy = d.y * TILE_PX - cam.y
    const frame = d.moving ? (Math.floor(this.walkPhase) % 2 === 0 ? 1 : 2) : 0
    if (set) {
      const img = set.frames.get(`${d.facing}:${frame}`)!
      ctx.drawImage(img, Math.round(sx - 8), Math.round(sy - 20))
    } else {
      ctx.fillStyle = '#888'
      ctx.fillRect(sx - 4, sy - 12, 8, 12)
    }
    // name tag + badges
    const name = d.me ? this.identity?.display_name ?? 'me' : member?.display_name ?? shortDid(d.did)
    ctx.font = '7px monospace'
    ctx.fillStyle = member?.is_agent ? '#ffb454' : d.me ? '#67c26b' : '#d8d6c8'
    const label = member?.is_agent ? `⚙ ${name}` : member?.verification_status === 'verified' ? `◈ ${name}` : name
    ctx.fillText(label, Math.round(sx - label.length * 2), Math.round(sy - 22))
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
      }),
      teleport: (x: number, y: number) => {
        this.me.x = x
        this.me.y = y
        this.checkDoor()
      },
      join: (channel: string) => this.conn?.join(channel),
      doors: () => this.map?.doors ?? [],
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
