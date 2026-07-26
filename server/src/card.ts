// The share card: a 1200×630 PNG generated from a DID, server-side.
//
// Bluesky's link cards are exactly one static image (their card service
// re-encodes whatever you give it through its own proxy — no video, no player,
// not even for YouTube). So the image has to carry the whole idea: this is a
// specific person's character, they have their own music, and there is
// something to press. It shows the sprite, the tune's traits, and the FIRST
// EIGHT BARS OF THEIR ACTUAL SCORE as a piano roll — the shape of the melody is
// per-person, so no two cards look alike.

import { deriveAvatar, renderSpritePixels, type Avatar, type Facing } from '../../shared/src/avatar'
import { compose } from '../../music/src/compose.ts'
import { mintChiptune, type Minted } from '../../music/src/mint.ts'
import { ticksPerBar } from '../../music/src/score.ts'
import { drawPlayTriangle, drawSparkle, drawText, drawTextCentered, textWidth } from './font.ts'
import {
  createBitmap, encodePng, fillEllipse, fillRect, hexToRgb, strokeEllipse, type Bitmap, type RGB,
} from './png.ts'

const W = 1200
const H = 630
const INK: RGB = [13, 13, 20]
const PAPER: RGB = [216, 214, 200]
const DIM: RGB = [138, 136, 150]
const PANEL: RGB = [27, 27, 43]

export function hslToRgb(h: number, s: number, l: number): RGB {
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(Math.min(k(n) - 3, 9 - k(n)), 1))
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)]
}

function rgbToHsl(rgb: RGB): { h: number; s: number; l: number } {
  const [r, g, b] = rgb.map((v) => v / 255) as RGB
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  let h = 0
  let s = 0
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0)
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
  }
  return { h, s, l }
}

function hueDist(a: number, b: number): number {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}

/** Same rule as the app: a backdrop hue that never blends into the skin. */
export function backdrop(av: Avatar): { h: number; s: number } {
  const skin = rgbToHsl(hexToRgb(String(av.traits.skin_palette)))
  const acc = rgbToHsl(hexToRgb(String(av.traits.accent_palette)))
  let h = acc.h
  if (acc.s < 0.2 || hueDist(acc.h, skin.h) < 70) h = (skin.h + 165) % 360
  return { h, s: Math.min(0.6, Math.max(0.42, acc.s || 0.5)) }
}

export function drawSprite(
  bmp: Bitmap, av: Avatar, x: number, y: number, scale: number,
  facing: Facing = 'south', frame = 0,
): void {
  const px = renderSpritePixels(av, facing, frame)
  for (let py = 0; py < px.height; py++) {
    for (let pxx = 0; pxx < px.width; pxx++) {
      const color = px.palette[px.pixels[py * px.width + pxx]!]!
      if (color === 'transparent') continue
      fillRect(bmp, x + pxx * scale, y + py * scale, scale, scale, hexToRgb(color))
    }
  }
}

/** The first bars of the real score, as a piano roll. This is the fingerprint:
 *  a different melody makes a visibly different card. */
export function drawRoll(
  bmp: Bitmap, minted: Minted, x: number, y: number, w: number, h: number, accent: RGB,
  bd: { h: number; s: number }, opts: { bars?: number; playhead?: number } = {},
): void {
  const score = compose(minted.theme)
  const bar = ticksPerBar(minted.theme.meter)
  const bars = opts.bars ?? 8
  const span = bar * bars
  // Only the pitched voices: drums sit at fixed pitches and turn the roll into
  // dotted noise, which hides the one thing worth showing — the melody's shape.
  const lanes: Record<string, RGB> = {
    pulse1: accent,
    pulse2: hslToRgb((bd.h + 40) % 360, 0.5, 0.62),
    triangle: hslToRgb((bd.h + 195) % 360, 0.5, 0.58),
  }
  fillRect(bmp, x, y, w, h, [10, 10, 17], 0.85)
  // bar lines
  for (let b = 0; b <= bars; b++) {
    fillRect(bmp, x + (b / bars) * w, y, 2, h, [35, 35, 58])
  }
  // fit the vertical range to the notes actually present, so the contour fills
  // the box instead of hugging the middle
  const pitched = score.notes.filter((n) => n.t < span && lanes[n.ch])
  const lo = Math.min(...pitched.map((n) => n.midi)) - 2
  const hi = Math.max(...pitched.map((n) => n.midi)) + 2
  for (const ch of ['triangle', 'pulse2', 'pulse1']) {
    for (const n of pitched) {
      if (n.ch !== ch) continue
      const nx = x + (n.t / span) * w
      const nw = Math.max(4, (n.dur / span) * w - 1)
      const ny = y + h - ((n.midi - lo) / (hi - lo)) * h
      const lead = ch === 'pulse1'
      const thick = lead ? 8 : 5
      fillRect(bmp, nx, ny - thick / 2, nw, thick, lanes[ch]!, lead ? 1 : 0.6)
    }
  }
  // a sweeping playhead turns the roll into a score being read (video only)
  if (opts.playhead !== undefined) {
    const px = x + Math.max(0, Math.min(1, opts.playhead)) * w
    fillRect(bmp, px - 1, y, 3, h, [255, 255, 255], 0.9)
    fillRect(bmp, px - 7, y, 6, h, accent, 0.16)
  }
}

export interface Card {
  png: Buffer
  minted: Minted
  avatar: Avatar
}

export interface CardStanding {
  level: number
  title: string
  xp: number
  runs: number
}

/** `label` is the handle (or a short DID) shown as the headline. */
export async function renderCard(did: string, label: string, standing?: CardStanding | null): Promise<Card> {
  const avatar = await deriveAvatar(did)
  const minted = await mintChiptune(did, 32)
  const bd = backdrop(avatar)
  const accent = hexToRgb(String(avatar.traits.accent_palette))
  const bmp = createBitmap(W, H)

  // --- backdrop: same radial glow as the app, in the same skin-safe hue -----
  fillRect(bmp, 0, 0, W, H, INK)
  const gx = 300
  const gy = H * 0.46
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = Math.hypot((x - gx) / (W * 0.42), (y - gy) / (H * 0.72))
      if (d >= 1) continue
      const k = (1 - d) ** 1.6
      blendPixel(bmp, x, y, hslToRgb(bd.h, bd.s, 0.16 + k * 0.2), k)
    }
  }

  // floor slab under the character
  const floorY = H * 0.74
  fillRect(bmp, 0, floorY, 620, H - floorY, hslToRgb(bd.h, bd.s * 0.5, 0.13))
  for (let i = 0; i < 12; i++) {
    if (i % 3 === 0) fillRect(bmp, i * 52, floorY, 40, 12, hslToRgb(bd.h, bd.s, 0.3))
  }
  for (let ry = 0; ry < 4; ry++) {
    for (let rx = 0; rx < 12; rx++) {
      if ((rx + ry) % 2 === 0) fillRect(bmp, rx * 52, floorY + ry * 32, 52, 32, [255, 255, 255], 0.03)
    }
  }

  // --- the character -------------------------------------------------------
  const scale = 16 // 16×24 sprite -> 256×384
  const sx = gx - (16 * scale) / 2
  const sy = floorY - 24 * scale + 8
  fillEllipse(bmp, gx, floorY + 6, 96, 12, [0, 0, 0], 0.4)
  drawSprite(bmp, avatar, sx, sy, scale)
  strokeEllipse(bmp, gx, H * 0.5, 292, 292, 5, accent, 0.16)

  // --- right column: who, what they sound like ------------------------------
  const rx = 640
  drawText(bmp, 'FREEQWORLD ID', rx, 74, DIM, { scale: 3, tracking: 2 })
  drawSparkle(bmp, rx + textWidth('FREEQWORLD ID', 3, 2) + 26, 84, 12, accent, 0.9)

  // headline scales down rather than running into the play button
  const handle = label.length > 24 ? `${label.slice(0, 23)}.` : label
  const headScale = Math.max(3, Math.min(6, Math.floor(400 / (handle.length * 6))))
  drawText(bmp, handle, rx, 116 + (6 - headScale) * 4, PAPER, { scale: headScale, tracking: 1, shadow: INK })

  const card = Object.fromEntries(minted.card)
  const rows: [string, string][] = [
    ['KEY', card.key ?? ''],
    ['TEMPO', card.tempo ?? ''],
    ['MOTIF', card.motif ?? ''],
    ['DRUMS', card.percussion ?? ''],
  ]
  const PANEL_W = 500
  const VALUE_X = rx + 150
  let cy = 206
  for (const [k, v] of rows) {
    const value = v.toUpperCase()
    fillRect(bmp, rx, cy - 10, PANEL_W, 44, PANEL, 0.85)
    fillRect(bmp, rx, cy - 10, 4, 44, accent, 0.8)
    drawText(bmp, k, rx + 18, cy, DIM, { scale: 3, tracking: 1 })
    // long values ("A MAJOR PENTATONIC") step down a size rather than overflow
    const scale = textWidth(value, 3, 1) <= PANEL_W - 172 ? 3 : 2
    drawText(bmp, value, VALUE_X, cy + (scale === 3 ? 0 : 4), PAPER, { scale, tracking: 1 })
    cy += 54
  }

  // the melody itself
  // standing, when they have any: the shared card carries the flex
  if (standing && standing.runs > 0) {
    const badge = `L${standing.level} ${standing.title.toUpperCase()}`
    const w = textWidth(badge, 3, 2) + 26
    fillRect(bmp, rx, cy - 4, w, 40, accent, 0.9)
    drawText(bmp, badge, rx + 13, cy + 6, INK, { scale: 3, tracking: 2 })
    const runs = `${standing.runs} WITNESSED RUN${standing.runs === 1 ? '' : 'S'}`
    drawText(bmp, `${standing.xp} XP - ${runs}`, rx + w + 16, cy + 6, DIM, { scale: 2, tracking: 1 })
    cy += 46
  }
  drawText(bmp, 'THEIR MELODY, FIRST EIGHT BARS', rx, cy + 6, DIM, { scale: 2, tracking: 1 })
  drawRoll(bmp, minted, rx, cy + 28, PANEL_W, 120, accent, bd)
  drawText(bmp, 'PRESS PLAY TO HEAR IT', rx, cy + 166, accent, { scale: 3, tracking: 2 })

  // --- the affordance: this card is a thing you press -----------------------
  const px = 1108
  const py = 96
  fillEllipse(bmp, px, py, 46, 46, INK, 0.72)
  strokeEllipse(bmp, px, py, 44, 44, 5, accent, 0.95)
  drawPlayTriangle(bmp, px + 4, py, 22, accent)

  // wordmark on its own plate, so the accent ring doesn't run through it
  fillRect(bmp, 26, H - 58, textWidth('PFP.FREEQ.AT', 3, 2) + 28, 40, INK, 0.72)
  drawText(bmp, 'PFP.FREEQ.AT', 40, H - 46, DIM, { scale: 3, tracking: 2 })

  return { png: encodePng(bmp), minted, avatar }
}

function blendPixel(bmp: Bitmap, x: number, y: number, c: RGB, a: number): void {
  fillRect(bmp, x, y, 1, 1, c, Math.max(0, Math.min(1, a)))
}
