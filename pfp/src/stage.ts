// The live view: your character, moving, in time with your own theme tune.
//
// Same visual language as the exported still (it reuses render.ts's backdrop,
// scene and sprite painter) — this is that picture, alive. Everything moves off
// one clock: the beat position reported by the player, or a free-running
// tempo clock when the sound is off, so the default view is never static.

import {
  deriveAvatar, renderSpritePixels, type Avatar, type Facing, type SpritePixels,
} from '../../shared/src/avatar'
import { backdropTint, drawScene, hslCss, shade, spriteCanvas } from './render'

/** Where we are in the music. `playing` is false before the visitor hits play,
 *  in which case `beats` still advances (idle breathing at the tune's tempo). */
export interface Clock {
  (): { beats: number; playing: boolean }
}

const FACINGS: Facing[] = ['south', 'east', 'south', 'west']

/** Steps per beat — how busy the walk cycle is. */
const CADENCE: Record<string, number> = { steady: 2, bouncy: 2, brisk: 4, ambling: 1 }

/** Eyes closed: repaint the ink/accent eye pixels in skin. */
function blinkPixels(px: SpritePixels): SpritePixels {
  const out = new Uint8Array(px.pixels)
  for (let y = 3; y <= 9; y++) {
    for (let x = 0; x < px.width; x++) {
      const i = y * px.width + x
      const c = out[i]
      if (c === 6 || c === 7 || c === 8) {
        // only if there's skin directly under it (don't erase a visor's frame)
        const below = out[(y + 1) * px.width + x]
        if (below === 1 || below === undefined) out[i] = 1
      }
    }
  }
  return { ...px, pixels: out }
}

export class Stage {
  private ctx: CanvasRenderingContext2D
  private raf = 0
  private avatar: Avatar | null = null
  private frames = new Map<string, HTMLCanvasElement>()
  private bd = { h: 200, s: 0.5 }
  private bornAt = 0
  private clock: Clock = () => ({ beats: 0, playing: false })
  /** ♪ glyphs drifting off the character, one per bar while the theme plays */
  private notes: { x: number; y: number; born: number; glyph: string; drift: number }[] = []
  private lastBar = -1

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!
  }

  setClock(clock: Clock): void {
    this.clock = clock
  }

  /** Point the stage at an identity; replays the arrival effect. */
  async show(did: string): Promise<Avatar> {
    const avatar = await deriveAvatar(did)
    this.avatar = avatar
    this.bd = backdropTint(avatar.traits)
    this.frames.clear()
    for (const facing of ['south', 'east', 'west', 'north'] as Facing[]) {
      for (const frame of [0, 1, 2]) {
        const px = renderSpritePixels(avatar, facing, frame)
        this.frames.set(`${facing}:${frame}`, spriteCanvas(px))
        if (frame === 0) this.frames.set(`${facing}:blink`, spriteCanvas(blinkPixels(px)))
      }
    }
    this.bornAt = performance.now()
    return avatar
  }

  start(): void {
    if (this.raf) return
    const loop = () => {
      this.draw()
      this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
  }

  stop(): void {
    cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  /** Restart the arrival animation (e.g. when the visitor re-enters). */
  replayArrival(): void {
    this.bornAt = performance.now()
  }

  private frame(facing: Facing, key: number | 'blink'): HTMLCanvasElement | undefined {
    return this.frames.get(`${facing}:${key}`)
  }

  private draw(): void {
    const av = this.avatar
    if (!av) return
    const ctx = this.ctx
    const size = this.canvas.width
    const t = av.traits
    const accent = String(t.accent_palette)
    const { beats, playing } = this.clock()
    const age = (performance.now() - this.bornAt) / 1000

    // --- arrival (spec §8: every identity has an arrival effect) -----------
    const arrival = String(t.arrival_effect)
    const arrivalT = Math.min(1, age / 1.1) // 0..1

    const beatPhase = beats - Math.floor(beats) // 0..1 inside the beat
    const pulse = playing ? (1 - beatPhase) ** 3 : 0 // sharp attack, quick decay
    const bar = Math.floor(beats / 4)

    // --- backdrop ----------------------------------------------------------
    ctx.fillStyle = '#0d0d14'
    ctx.fillRect(0, 0, size, size)
    const glow = ctx.createRadialGradient(
      size / 2, size * 0.42, size * (0.04 + pulse * 0.03),
      size / 2, size * 0.5, size * (0.62 + pulse * 0.04),
    )
    glow.addColorStop(0, hslCss(this.bd.h, this.bd.s, 0.3 + pulse * 0.09))
    glow.addColorStop(0.44, hslCss(this.bd.h, this.bd.s * 0.85, 0.15 + pulse * 0.04))
    glow.addColorStop(1, '#0d0d14')
    ctx.fillStyle = glow
    ctx.fillRect(0, 0, size, size)

    drawScene(ctx, size, this.bd)

    // beat-lit floor tiles running left→right, one per beat
    if (playing) {
      const cell = size / 16
      const floorY = size * 0.7
      const lit = Math.floor(beats) % 16
      for (let i = 0; i < 16; i++) {
        const d = (i - lit + 16) % 16
        if (d > 1) continue
        ctx.globalAlpha = (1 - d / 2) * 0.75
        ctx.fillStyle = accent
        ctx.fillRect(i * cell + cell * 0.1, floorY - cell * 0.06, cell * 0.8, cell * 0.42)
      }
      ctx.globalAlpha = 1
    }

    // --- the character ------------------------------------------------------
    const idle = String(t.idle_movement)
    const cadence = CADENCE[String(t.walk_cadence)] ?? 2
    let facing: Facing = 'south'
    let key: number | 'blink' = 0
    let bob = 0
    let sway = 0
    let squash = 1

    if (playing) {
      // walk on the spot, turning to show off every side of the sprite
      facing = FACINGS[bar % FACINGS.length]!
      const step = Math.floor(beats * cadence) % 4
      key = step === 0 ? 1 : step === 2 ? 2 : 0
      bob = -Math.abs(Math.sin(beats * Math.PI * cadence)) * size * 0.012
      if (idle === 'bouncy' || String(t.walk_cadence) === 'bouncy') bob *= 1.8
      sway = Math.sin(beats * Math.PI) * size * 0.006
    } else {
      // breathing, blinking, tapping — alive but calm
      const secs = age
      if (idle === 'bob') bob = Math.sin(secs * 2.2) * size * 0.006
      else if (idle === 'sway') sway = Math.sin(secs * 1.6) * size * 0.008
      else if (idle === 'tap') key = Math.floor(secs * 2) % 6 === 0 ? 1 : 0
      if (idle === 'blink' || Math.floor(secs) % 5 === 0) {
        if (secs % 1 < 0.14) key = 'blink'
      }
      squash = 1 + Math.sin(secs * 2.2) * 0.006
    }

    const sprite = this.frame(facing, key) ?? this.frame('south', 0)
    if (sprite) {
      // framed a little higher and smaller than the still, so the character
      // stands ON the floor line and clears the play control below
      const destH = size * 0.5 * squash
      const destW = 16 * ((size * 0.5) / 24)
      const x = (size - destW) / 2 + sway
      let y = size * 0.22 + bob
      let alpha = 1

      // arrival effects
      if (arrivalT < 1) {
        if (arrival === 'drop') {
          const k = 1 - arrivalT
          y -= k * k * size * 0.5
          if (arrivalT > 0.86) y += Math.sin((arrivalT - 0.86) * 22) * size * 0.012
        } else if (arrival === 'dissolve') {
          alpha = arrivalT
        } else if (arrival === 'sparkle') {
          alpha = 0.35 + 0.65 * arrivalT
        } else if (arrival === 'teleport-rings') {
          alpha = arrivalT < 0.35 ? arrivalT / 0.35 : 1
        }
      }

      ctx.imageSmoothingEnabled = false
      ctx.globalAlpha = alpha
      ctx.drawImage(sprite, 0, 0, 16, 24, x, y, destW, destH)
      ctx.globalAlpha = 1

      // shadow keeps them planted on the floor
      ctx.fillStyle = 'rgba(0,0,0,.35)'
      ctx.beginPath()
      ctx.ellipse(size / 2 + sway, size * 0.727, destW * 0.3, size * 0.011, 0, 0, Math.PI * 2)
      ctx.fill()
    }

    if (arrivalT < 1) this.drawArrival(ctx, size, arrival, arrivalT, accent)

    // --- the music, made visible: a note leaves the character each bar ------
    if (playing && bar !== this.lastBar) {
      this.lastBar = bar
      this.notes.push({
        x: size * (0.56 + Math.random() * 0.1),
        y: size * 0.4,
        born: performance.now(),
        glyph: bar % 2 === 0 ? '♪' : '♫',
        drift: (Math.random() - 0.4) * size * 0.06,
      })
      if (this.notes.length > 6) this.notes.shift()
    }
    if (!playing) this.lastBar = -1
    ctx.font = `${Math.round(size * 0.075)}px monospace`
    ctx.textAlign = 'center'
    for (const n of this.notes) {
      const life = (performance.now() - n.born) / 1800
      if (life >= 1) continue
      ctx.globalAlpha = (1 - life) * 0.85
      ctx.fillStyle = accent
      ctx.fillText(n.glyph, n.x + n.drift * life, n.y - life * size * 0.22)
    }
    ctx.globalAlpha = 1
    this.notes = this.notes.filter((n) => performance.now() - n.born < 1800)

    // --- accent ring: breathes on the downbeat ------------------------------
    const downbeat = playing ? (1 - (beats / 4 - Math.floor(beats / 4))) ** 4 : 0
    ctx.strokeStyle = shade(accent, 0.95)
    ctx.globalAlpha = 0.22 + downbeat * 0.5
    ctx.lineWidth = size * (0.02 + downbeat * 0.012)
    ctx.beginPath()
    ctx.arc(size / 2, size / 2, size * 0.47, 0, Math.PI * 2)
    ctx.stroke()
    ctx.globalAlpha = 1

    ctx.fillStyle = accent
    ctx.globalAlpha = 0.8
    ctx.font = `${Math.round(size * 0.055)}px monospace`
    ctx.textAlign = 'center'
    ctx.fillText('✦', size * 0.85, size * 0.88)
    ctx.globalAlpha = 1
  }

  private drawArrival(
    ctx: CanvasRenderingContext2D, size: number, kind: string, p: number, accent: string,
  ): void {
    ctx.save()
    if (kind === 'teleport-rings') {
      for (let i = 0; i < 3; i++) {
        const k = Math.min(1, Math.max(0, p * 1.4 - i * 0.22))
        if (k <= 0 || k >= 1) continue
        ctx.globalAlpha = (1 - k) * 0.7
        ctx.strokeStyle = accent
        ctx.lineWidth = size * 0.008
        ctx.beginPath()
        ctx.ellipse(size / 2, size * 0.84, size * 0.05 + k * size * 0.3, size * 0.014 + k * size * 0.05, 0, 0, Math.PI * 2)
        ctx.stroke()
      }
    } else if (kind === 'sparkle') {
      const n = 14
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + p * 2
        const r = size * (0.12 + p * 0.34)
        ctx.globalAlpha = (1 - p) * 0.9
        ctx.fillStyle = i % 3 === 0 ? '#ffffff' : accent
        const s = size * 0.012 * (1 - p * 0.6)
        ctx.fillRect(size / 2 + Math.cos(a) * r - s / 2, size * 0.5 + Math.sin(a) * r * 0.8 - s / 2, s, s)
      }
    } else if (kind === 'dissolve') {
      // pixels re-assembling: scanline wipe
      ctx.globalAlpha = (1 - p) * 0.75
      ctx.fillStyle = '#0d0d14'
      const rows = 24
      for (let i = 0; i < rows; i++) {
        if ((i * 7 + 3) % 11 < p * 11) continue
        ctx.fillRect(size * 0.3, size * 0.26 + (i / rows) * size * 0.58, size * 0.4, size * 0.02)
      }
    }
    ctx.restore()
  }
}
