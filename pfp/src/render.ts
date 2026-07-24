// Compose the deterministic FreeqWorld sprite into a square, profile-worthy PNG.
// Reuses the SAME generator the game uses (shared/src/avatar) — the face here is
// exactly the character you walk around as. Nothing is uploaded; it's derived
// from the DID.

import {
  deriveAvatar,
  renderSpritePixels,
  type Avatar,
  type SpritePixels,
} from '../../shared/src/avatar'

export type Variant = 'portrait' | 'explorer'

function hexToRgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]
}

/** Multiply a #rrggbb toward black (f<1) or white-ish (f>1); returns rgb(). */
function shade(hex: string, f: number): string {
  if (!hex.startsWith('#')) return hex
  const [r, g, b] = hexToRgb(hex)
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * f)))
  return `rgb(${c(r)},${c(g)},${c(b)})`
}

function rgbToHsl(hex: string): { h: number; s: number; l: number } {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255) as [number, number, number]
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

function hslCss(h: number, s: number, l: number): string {
  return `hsl(${(((h % 360) + 360) % 360).toFixed(0)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`
}

function hueDist(a: number, b: number): number {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}

/** A backdrop hue that stays clear of the character's skin (the focal head), so
 *  brown-on-brown / warm-on-warm never happens. Deterministic — derived from the
 *  same traits, only *steered* for contrast; the core avatar traits are never
 *  changed. Natural tint is the accent colour; if that sits too near the skin
 *  hue (or is near-grey), we swing to the skin's complement. */
function backdropTint(t: Avatar['traits']): { h: number; s: number } {
  const skin = rgbToHsl(String(t.skin_palette))
  const acc = rgbToHsl(String(t.accent_palette))
  let h = acc.h
  if (acc.s < 0.2 || hueDist(acc.h, skin.h) < 70) h = (skin.h + 165) % 360
  return { h, s: Math.min(0.6, Math.max(0.42, acc.s || 0.5)) }
}

/** Native-resolution (16×24) canvas of one sprite frame. */
function spriteCanvas(px: SpritePixels): HTMLCanvasElement {
  const cv = document.createElement('canvas')
  cv.width = px.width
  cv.height = px.height
  const ctx = cv.getContext('2d')!
  const img = ctx.createImageData(px.width, px.height)
  for (let i = 0; i < px.pixels.length; i++) {
    const color = px.palette[px.pixels[i]!]!
    if (color === 'transparent') continue
    const [r, g, b] = hexToRgb(color)
    img.data[i * 4] = r
    img.data[i * 4 + 1] = g
    img.data[i * 4 + 2] = b
    img.data[i * 4 + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  return cv
}

function drawScene(ctx: CanvasRenderingContext2D, size: number, bd: { h: number; s: number }): void {
  const floorY = size * 0.7
  // floor slab in the (skin-contrasting) backdrop family, kept dark
  ctx.fillStyle = hslCss(bd.h, bd.s * 0.5, 0.14)
  ctx.fillRect(0, floorY, size, size - floorY)
  // glowing floor tiles
  const cell = size / 16
  for (let i = 0; i < 16; i++) {
    if (i % 3 === 0) {
      ctx.fillStyle = hslCss(bd.h, bd.s, 0.3)
      ctx.fillRect(i * cell, floorY, cell, cell * 0.35)
    }
  }
  // faint checker
  ctx.fillStyle = 'rgba(255,255,255,0.03)'
  for (let y = 0; y < 5; y++)
    for (let x = 0; x < 16; x++)
      if ((x + y) % 2 === 0) ctx.fillRect(x * cell, floorY + y * cell, cell, cell)
}

export interface Pfp {
  avatar: Avatar
  canvas: HTMLCanvasElement
}

/** Render a square PFP. `size` is the exported edge (Bluesky avatars are square,
 *  shown as a circle — content stays inside the inscribed circle). */
export async function renderPfp(did: string, variant: Variant, size = 1024): Promise<Pfp> {
  const avatar = await deriveAvatar(did)
  const t = avatar.traits
  const accent = String(t.accent_palette)
  // backdrop hue steered away from the skin so the head never blends in
  const bd = backdropTint(t)

  const cv = document.createElement('canvas')
  cv.width = size
  cv.height = size
  const ctx = cv.getContext('2d')!

  // base
  ctx.fillStyle = '#0d0d14'
  ctx.fillRect(0, 0, size, size)

  // radial glow behind the character, in a hue that contrasts the skin
  const g = ctx.createRadialGradient(size / 2, size * 0.42, size * 0.04, size / 2, size * 0.5, size * 0.62)
  g.addColorStop(0, hslCss(bd.h, bd.s, 0.3))
  g.addColorStop(0.44, hslCss(bd.h, bd.s * 0.85, 0.15))
  g.addColorStop(1, '#0d0d14')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)

  if (variant === 'explorer') drawScene(ctx, size, bd)

  // the sprite — nearest-neighbor upscale, no smoothing
  ctx.imageSmoothingEnabled = false
  const sprite = spriteCanvas(renderSpritePixels(avatar, 'south', 0))
  if (variant === 'portrait') {
    // head + torso crop, filling the circle
    const sy = 1
    const sh = 15
    const sw = 16
    const destH = size * 0.66
    const scale = destH / sh
    const destW = sw * scale
    ctx.drawImage(sprite, 0, sy, sw, sh, (size - destW) / 2, size * 0.17, destW, destH)
  } else {
    const destH = size * 0.56
    const scale = destH / 24
    const destW = 16 * scale
    ctx.drawImage(sprite, 0, 0, 16, 24, (size - destW) / 2, size * 0.28, destW, destH)
  }

  // accent ring / vignette
  ctx.strokeStyle = shade(accent, 0.95)
  ctx.globalAlpha = 0.22
  ctx.lineWidth = size * 0.02
  ctx.beginPath()
  ctx.arc(size / 2, size / 2, size * 0.47, 0, Math.PI * 2)
  ctx.stroke()
  ctx.globalAlpha = 1

  // quiet corner sparkle — the ✦ mark, on brand, not a watermark
  ctx.fillStyle = accent
  ctx.globalAlpha = 0.8
  ctx.font = `${Math.round(size * 0.055)}px monospace`
  ctx.textAlign = 'center'
  ctx.fillText('✦', size * 0.85, size * 0.88)
  ctx.globalAlpha = 1

  return { avatar, canvas: cv }
}

/** A few human-readable traits for the "how it's derived" card. */
export function traitSummary(av: Avatar): Array<[string, string]> {
  const t = av.traits
  return [
    ['silhouette', String(t.body_silhouette)],
    ['hair', String(t.hair_shape)],
    ['eyes', String(t.eye_pixels)],
    ['accessory', String(t.accessory)],
    ['walk', String(t.walk_cadence)],
    ['arrival', String(t.arrival_effect)],
  ]
}

export function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'),
  )
}

/** Standard-base64 PNG (what the broker's /api/pfp/set-avatar expects). */
export async function canvasToPngBase64(canvas: HTMLCanvasElement): Promise<string> {
  const buf = new Uint8Array(await (await canvasToPngBlob(canvas)).arrayBuffer())
  let bin = ''
  for (const b of buf) bin += String.fromCharCode(b)
  return btoa(bin)
}
