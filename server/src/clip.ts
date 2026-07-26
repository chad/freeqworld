// A 12-second MP4 of the character moving to their own theme, with sound.
//
// Bluesky's unfurl is a still image and nothing else, but Discord, Telegram,
// Mastodon and iMessage all play an `og:video` mp4 inline — so a shared link can
// actually be heard on those. Same identity, same derivation, same art: the
// frames are drawn with the card's primitives (server/src/{png,font,card}.ts)
// and the audio is the same synth the browser runs, so the video IS the app.
//
// Encoding is the one place we shell out: H.264 + AAC by hand is not a
// reasonable thing to hand-roll, so `ffmpeg-static` provides the binary. The
// dependency is OPTIONAL and server-side only — if the binary is missing the
// clip routes 404 and the share page simply omits og:video, which is exactly
// how it behaved before this existed.

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deriveAvatar, type Facing } from '../../shared/src/avatar'
import { compose } from '../../music/src/compose.ts'
import { mintChiptune } from '../../music/src/mint.ts'
import { renderScore } from '../../music/src/synth.ts'
import { encodeWav } from '../../music/src/wav.ts'
import { ticksPerBar, ticksToSeconds } from '../../music/src/score.ts'
import { backdrop, drawRoll, drawSprite, hslToRgb } from './card.ts'
import { drawText, drawSparkle, textWidth } from './font.ts'
import {
  createBitmap, fillEllipse, fillRect, hexToRgb, strokeEllipse, type Bitmap, type RGB,
} from './png.ts'

export const CLIP_W = 800
export const CLIP_H = 450
const FPS = 20
const TARGET_SECONDS = 12

const INK: RGB = [13, 13, 20]
const PAPER: RGB = [216, 214, 200]
const DIM: RGB = [138, 136, 150]
const PANEL: RGB = [27, 27, 43]
const FACINGS: Facing[] = ['south', 'east', 'south', 'west']
const CADENCE: Record<string, number> = { steady: 2, bouncy: 2, brisk: 4, ambling: 1 }

let ffmpegPath: string | null | undefined

/** Resolved once. `null` means "no encoder here" — callers degrade gracefully. */
export async function ffmpeg(): Promise<string | null> {
  if (ffmpegPath !== undefined) return ffmpegPath
  try {
    const mod = (await import('ffmpeg-static')) as unknown as { default: string | null }
    ffmpegPath = mod.default ?? null
  } catch {
    ffmpegPath = null
  }
  return ffmpegPath
}

export function clipsAvailable(): boolean {
  return ffmpegPath !== null && ffmpegPath !== undefined
}

function copyInto(dst: Bitmap, src: Bitmap): void {
  dst.data.set(src.data)
}

export interface ClipResult {
  mp4: Buffer
  seconds: number
}

/** Frames are drawn as: one static background, then per-frame overlays. */
export async function renderClip(did: string, label: string): Promise<ClipResult> {
  const bin = await ffmpeg()
  if (!bin) throw new Error('no encoder available')

  const avatar = await deriveAvatar(did)
  const minted = await mintChiptune(did, 8)
  const theme = minted.theme
  const barSeconds = (theme.meter[0] * 60) / theme.bpm
  // choose a whole number of bars closest to the target, so the clip loops
  const bars = Math.max(4, Math.min(16, Math.round(TARGET_SECONDS / barSeconds)))
  const looped = { ...theme, bars }
  const score = compose(looped)
  const seconds = ticksToSeconds(score.length, score.bpm)
  const frames = Math.round(seconds * FPS)

  const bd = backdrop(avatar)
  const accent = hexToRgb(String(avatar.traits.accent_palette))
  const stageW = 430
  const floorY = CLIP_H * 0.78

  // ---- static background ---------------------------------------------------
  const bg = createBitmap(CLIP_W, CLIP_H)
  fillRect(bg, 0, 0, CLIP_W, CLIP_H, INK)
  const gx = stageW / 2
  const gy = CLIP_H * 0.46
  for (let y = 0; y < CLIP_H; y++) {
    for (let x = 0; x < CLIP_W; x++) {
      const d = Math.hypot((x - gx) / (CLIP_W * 0.4), (y - gy) / (CLIP_H * 0.8))
      if (d >= 1) continue
      const k = (1 - d) ** 1.6
      fillRect(bg, x, y, 1, 1, hslToRgb(bd.h, bd.s, 0.15 + k * 0.19), k)
    }
  }
  fillRect(bg, 0, floorY, stageW, CLIP_H - floorY, hslToRgb(bd.h, bd.s * 0.5, 0.12))
  for (let ry = 0; ry < 3; ry++) {
    for (let rx = 0; rx < 12; rx++) {
      if ((rx + ry) % 2 === 0) fillRect(bg, rx * 36, floorY + ry * 34, 36, 34, [255, 255, 255], 0.03)
    }
  }

  // right-hand panel: who and what you're hearing
  const rx = stageW + 40
  drawText(bg, 'FREEQWORLD ID', rx, 40, DIM, { scale: 2, tracking: 2 })
  drawSparkle(bg, rx + textWidth('FREEQWORLD ID', 2, 2) + 16, 47, 8, accent, 0.9)
  const head = label.length > 18 ? `${label.slice(0, 17)}.` : label
  const headScale = Math.max(2, Math.min(4, Math.floor(290 / (head.length * 6))))
  drawText(bg, head, rx, 66, PAPER, { scale: headScale, tracking: 1, shadow: INK })
  const card = Object.fromEntries(minted.card)
  const short = (v: string): string =>
    v.toUpperCase()
      .replace(' PENTATONIC', ' PENT')
      .replace('NATURAL MINOR', 'MINOR')
      .replace('HARMONIC MINOR', 'HARM MINOR')
      .replace('MIXOLYDIAN', 'MIXO')
  let cy = 122
  for (const [k, v] of [['KEY', card.key ?? ''], ['TEMPO', card.tempo ?? ''], ['MOTIF', card.motif ?? '']]) {
    fillRect(bg, rx, cy - 7, 300, 30, PANEL, 0.85)
    fillRect(bg, rx, cy - 7, 3, 30, accent, 0.8)
    drawText(bg, k!, rx + 11, cy, DIM, { scale: 2, tracking: 1 })
    const value = short(v!)
    drawText(bg, value, rx + 82, cy, PAPER, { scale: 2, tracking: 1 })
    cy += 38
  }
  const rollY = cy + 18
  const rollH = 118
  drawText(bg, 'THEIR MELODY', rx, rollY - 14, DIM, { scale: 1, tracking: 1 })
  drawText(bg, 'PFP.FREEQ.AT', rx, CLIP_H - 26, DIM, { scale: 2, tracking: 2 })

  // ---- encoder -------------------------------------------------------------
  const dir = await mkdtemp(join(tmpdir(), 'fq-clip-'))
  const wavPath = join(dir, 'a.wav')
  const outPath = join(dir, 'o.mp4')
  await writeFile(wavPath, encodeWav(renderScore(score, { loop: true, sampleRate: 44100 })))

  const proc = spawn(bin, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${CLIP_W}x${CLIP_H}`, '-r', String(FPS), '-i', 'pipe:0',
    '-i', wavPath,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p',
    // yuv420p + even dimensions + baseline-ish profile = plays everywhere,
    // including iMessage and old Android Telegram
    '-profile:v', 'main', '-level', '3.1',
    '-c:a', 'aac', '-b:a', '96k', '-ar', '44100',
    '-movflags', '+faststart', // moov atom first, or players won't start streaming
    '-shortest', outPath,
  ])
  const stderr: Buffer[] = []
  proc.stderr.on('data', (d: Buffer) => stderr.push(d))
  const done = new Promise<void>((resolve, reject) => {
    proc.on('error', reject)
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(stderr)}`)),
    )
  })

  // ---- frames --------------------------------------------------------------
  const frame = createBitmap(CLIP_W, CLIP_H)
  const notes: { x: number; y: number; at: number; glyph: string; drift: number }[] = []
  const barTicks = ticksPerBar(theme.meter)
  const spriteScale = 11

  for (let f = 0; f < frames; f++) {
    const t = f / FPS
    const beats = (t * theme.bpm) / 60
    const bar = Math.floor(beats / theme.meter[0])
    const beatPhase = beats - Math.floor(beats)
    const pulse = (1 - beatPhase) ** 3
    copyInto(frame, bg)

    // beat-lit floor tiles
    const cell = stageW / 12
    const lit = Math.floor(beats) % 12
    for (let i = 0; i < 12; i++) {
      const d = (i - lit + 12) % 12
      if (d > 1) continue
      fillRect(frame, i * cell + 4, floorY - 3, cell - 8, 13, accent, (1 - d / 2) * 0.7)
    }

    // the character: walk cycle, bob, and a new facing each bar
    const cadence = CADENCE[String(avatar.traits.walk_cadence)] ?? 2
    const step = Math.floor(beats * cadence) % 4
    const spriteFrame = step === 0 ? 1 : step === 2 ? 2 : 0
    const facing = FACINGS[bar % FACINGS.length]!
    const bob = -Math.abs(Math.sin(beats * Math.PI * cadence)) * 5
    const sway = Math.sin(beats * Math.PI) * 3
    const sx = gx - (16 * spriteScale) / 2 + sway
    const sy = floorY - 24 * spriteScale + 4 + bob
    fillEllipse(frame, gx + sway, floorY + 3, 62, 8, [0, 0, 0], 0.4)
    // arrival effect on entry, so the clip opens with them appearing
    const arrival = String(avatar.traits.arrival_effect)
    const born = Math.min(1, t / 1.0)
    if (born >= 1 || arrival !== 'dissolve') {
      drawSprite(frame, avatar, sx, arrival === 'drop' ? sy - (1 - born) ** 2 * 190 : sy, spriteScale, facing, spriteFrame)
    }
    if (born < 1 && arrival === 'sparkle') {
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2 + born * 2
        const r = 40 + born * 130
        const s = Math.max(1, Math.round(5 * (1 - born)))
        fillRect(frame, gx + Math.cos(a) * r, gy + Math.sin(a) * r * 0.8, s, s, i % 3 ? accent : [255, 255, 255], 1 - born)
      }
    }
    if (born < 1 && arrival === 'teleport-rings') {
      for (let i = 0; i < 3; i++) {
        const k = Math.min(1, Math.max(0, born * 1.4 - i * 0.22))
        if (k <= 0 || k >= 1) continue
        strokeEllipse(frame, gx, floorY, 30 + k * 150, 8 + k * 26, 3, accent, (1 - k) * 0.7)
      }
    }
    if (born < 1 && arrival === 'dissolve') {
      drawSprite(frame, avatar, sx, sy, spriteScale, facing, spriteFrame)
      for (let i = 0; i < 24; i++) {
        if ((i * 7 + 3) % 11 < born * 11) continue
        fillRect(frame, sx - 6, sy + (i / 24) * 24 * spriteScale, 16 * spriteScale + 12, 6, INK, 0.8)
      }
    }

    // ring breathing on the downbeat
    const downbeat = (1 - (beats / 4 - Math.floor(beats / 4))) ** 4
    strokeEllipse(frame, gx, CLIP_H * 0.48, 196, 196, 3 + downbeat * 2, accent, 0.14 + downbeat * 0.3 + pulse * 0.05)

    // ♪ leaving the character each bar
    if (notes.length === 0 || notes[notes.length - 1]!.at !== bar) {
      notes.push({ x: gx + 60, y: gy - 20, at: bar, glyph: bar % 2 === 0 ? '\u266a' : '\u266b', drift: (bar % 3) * 6 - 6 })
      if (notes.length > 5) notes.shift()
    }
    for (const n of notes) {
      const life = (beats - n.at * theme.meter[0]) / 3
      if (life < 0 || life >= 1) continue
      drawText(frame, n.glyph, n.x + n.drift * life, n.y - life * 90, accent, { scale: 3, alpha: (1 - life) * 0.8 })
    }

    // the melody being read, in time
    drawRoll(frame, minted, rx, rollY, 300, rollH, accent, bd, {
      bars,
      playhead: (score.length ? (f / frames) : 0),
    })

    if (!proc.stdin.write(Buffer.from(frame.data))) {
      await new Promise<void>((r) => proc.stdin.once('drain', () => r()))
    }
  }
  proc.stdin.end()
  await done

  const mp4 = await readFile(outPath)
  await rm(dir, { recursive: true, force: true })
  return { mp4, seconds }
}

// --- cache + single flight ---------------------------------------------------
// Encoding costs real CPU on a box that is also running the world, so: one
// encode at a time, one in-flight promise per identity, and remember results.

const cache = new Map<string, { mp4: Buffer; seconds: number; at: number }>()
const inFlight = new Map<string, Promise<ClipResult>>()
let queue: Promise<unknown> = Promise.resolve()
const TTL = 6 * 60 * 60 * 1000

export async function clipFor(did: string, label: string): Promise<ClipResult> {
  const hit = cache.get(did)
  if (hit && Date.now() - hit.at < TTL) return { mp4: hit.mp4, seconds: hit.seconds }
  const pending = inFlight.get(did)
  if (pending) return pending

  const task = queue.then(() => renderClip(did, label)).then((res) => {
    cache.set(did, { ...res, at: Date.now() })
    if (cache.size > 60) cache.delete(cache.keys().next().value!)
    inFlight.delete(did)
    return res
  }, (err) => {
    inFlight.delete(did)
    throw err
  })
  inFlight.set(did, task)
  queue = task.catch(() => undefined)
  return task
}
