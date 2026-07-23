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

function drawScene(ctx: CanvasRenderingContext2D, size: number, t: Avatar['traits']): void {
  const floorY = size * 0.7
  // floor slab (from the wearer's own palette so the scene is theirs)
  ctx.fillStyle = shade(String(t.pants_skirt), 0.75)
  ctx.fillRect(0, floorY, size, size - floorY)
  // glowing floor tiles
  const cell = size / 16
  const glow = String(t.accent_palette)
  for (let i = 0; i < 16; i++) {
    if (i % 3 === 0) {
      ctx.fillStyle = shade(glow, 0.5)
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
  const shirt = String(t.shirt_jacket)

  const cv = document.createElement('canvas')
  cv.width = size
  cv.height = size
  const ctx = cv.getContext('2d')!

  // base
  ctx.fillStyle = '#0d0d14'
  ctx.fillRect(0, 0, size, size)

  // radial glow behind the character, tinted by their own colors
  const g = ctx.createRadialGradient(size / 2, size * 0.42, size * 0.04, size / 2, size * 0.5, size * 0.62)
  g.addColorStop(0, shade(accent, 0.6))
  g.addColorStop(0.45, shade(shirt, 0.3))
  g.addColorStop(1, '#0d0d14')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)

  if (variant === 'explorer') drawScene(ctx, size, t)

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
