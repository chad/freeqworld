// Connection to a town server. Travel between towns is just pointing this
// at a different /ws — the identity stays in the browser (spec §14.2).

import type { ClientFrame, ServerFrame } from '../../shared/src/protocol'
import { signEvent } from '../../shared/src/signing'
import type { Identity } from './identity'

export interface ConnOptions {
  serverUrl: string
  channel: string
  identity: Identity | null // null = read-only spectator
  avatarDid?: string
  onFrame: (frame: ServerFrame) => void
  onRawIn?: (frame: ServerFrame) => void
  onOpen?: (rttMs: number) => void
  onClose?: () => void
}

export class TownConnection {
  private ws: WebSocket | null = null
  private opts: ConnOptions
  private seq = 0
  private closed = false
  private pending: ClientFrame[] = []
  readonly serverUrl: string

  constructor(opts: ConnOptions) {
    this.opts = opts
    this.serverUrl = opts.serverUrl
    this.connect()
  }

  private connect(): void {
    const wsUrl = this.opts.serverUrl.replace(/^http/, 'ws') + '/ws'
    const started = performance.now()
    const ws = new WebSocket(wsUrl)
    this.ws = ws
    ws.onopen = () => {
      const id = this.opts.identity
      this.sendRaw({
        t: 'hello',
        did: id?.did ?? `spectator:${crypto.randomUUID().slice(0, 8)}`,
        handle: id?.handle ?? 'guest.viewing',
        display_name: id?.display_name ?? 'guest',
        channel: this.opts.channel,
        client_instance: id?.client_instance ?? 'spectator',
        avatar_did: this.opts.avatarDid,
        spectator: !id,
      })
      this.opts.onOpen?.(performance.now() - started)
      for (const f of this.pending.splice(0)) this.sendRaw(f)
    }
    ws.onmessage = (e) => {
      try {
        const frame = JSON.parse(String(e.data)) as ServerFrame
        this.opts.onRawIn?.(frame)
        this.opts.onFrame(frame)
      } catch {
        /* drop malformed */
      }
    }
    ws.onclose = () => {
      if (!this.closed) {
        this.opts.onClose?.()
        setTimeout(() => !this.closed && this.connect(), 1500)
      }
    }
    ws.onerror = () => ws.close()
  }

  private sendRaw(frame: ClientFrame): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame))
    } else if (frame.t !== 'pos') {
      // queue durable-intent frames until the socket opens; drop stale positions
      this.pending.push(frame)
    }
  }

  join(channel: string): void {
    this.opts.channel = channel
    this.sendRaw({ t: 'join', channel })
  }

  sendMessage(channel: string, content: string, enc?: { alg: 'aes-gcm'; iv: string; ct: string }, type: 'text' | 'code' = 'text'): void {
    const id = this.opts.identity
    if (!id) return
    const base: Record<string, unknown> = {
      id: crypto.randomUUID(),
      channel,
      sender: id.did,
      content,
      type,
      ts: Date.now(),
    }
    if (enc) base.enc = enc
    const signature = signEvent(base, id.keypair.secretKey)
    this.sendRaw({ t: 'msg', event: { ...(base as object), signature } as never })
  }

  sendReaction(channel: string, targetMessage: string, reaction: string): void {
    const id = this.opts.identity
    if (!id) return
    const base = { id: crypto.randomUUID(), channel, actor: id.did, target_message: targetMessage, reaction, ts: Date.now() }
    const signature = signEvent(base, id.keypair.secretKey)
    this.sendRaw({ t: 'react', event: { ...base, signature } })
  }

  sendPosition(channel: string, x: number, y: number, facing: 'north' | 'south' | 'east' | 'west', animation: 'idle' | 'walk' | 'react'): void {
    const id = this.opts.identity
    if (!id) return
    this.sendRaw({
      t: 'pos',
      pos: {
        type: 'freeq.at/presence/world-position/v1',
        channel,
        did: id.did,
        x,
        y,
        facing,
        animation,
        client_instance: id.client_instance,
        sequence: ++this.seq,
        expires_at: Date.now() + 6000,
      },
    })
  }

  close(): void {
    this.closed = true
    this.ws?.close()
  }
}
