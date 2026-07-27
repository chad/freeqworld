// The canonical character portrait, rendered deterministically.
//
// This is the image an external quest can VERIFY: an AT Proto avatar is
// addressed by the hash of its bytes, so if these bytes are reproducible by
// anyone running this code, then "are you wearing your derived face?" needs no
// oracle at all — recompute, hash, compare (shared/src/cid.ts).
//
// DETERMINISM IS THE WHOLE POINT, so two rules hold here:
//
//  1. No canvas. `canvas.toBlob()` output depends on the browser's PNG encoder,
//     so the app must upload THESE bytes, not its own render.
//  2. No LOOSELY-SPECIFIED maths in the pixel loop. Math.pow / hypot / sin / cos
//     are not guaranteed bit-identical across engine versions, and one ULP of
//     difference rounds to a different byte and a different CID. Math.sqrt IS
//     safe — IEEE-754 requires it to be correctly rounded, like + - * / — so the
//     glow uses sqrt over integer squared distances for even, smooth banding.
//
// ⚠ ONCE PEOPLE WEAR THIS, THE RENDERER IS A CONSENSUS ARTIFACT. Changing any
//   pixel changes every CID, and everyone who verified stops verifying. Treat a
//   change here like a change to shared/src/avatar.ts: don't, unless you also
//   plan to re-verify the world.

import { deriveAvatar, type Avatar } from '../../shared/src/avatar'
import { rawCid } from '../../shared/src/cid'
import { backdrop, drawSprite, hslToRgb } from './card.ts'
import { drawSparkle } from './font.ts'
import { createBitmap, encodePng, fillRect, hexToRgb, type Bitmap, type RGB } from './png.ts'

export type FaceVariant = 'explorer' | 'portrait'

const INK: RGB = [13, 13, 20]

/** Concentric quantised bands instead of a smooth gradient: integer-exact, and
 *  it reads as a pixel-art glow rather than a photographic one. */
function drawGlow(bmp: Bitmap, size: number, hue: number, sat: number, bands = 48): void {
  const cx = size >> 1
  const cy = Math.round(size * 0.44)
  // radius² of the outermost band, in integer pixels
  const rMax = Math.round(size * 0.62)
  const rMax2 = rMax * rMax
  // one colour per band, computed once
  const palette: RGB[] = []
  for (let b = 0; b < bands; b++) {
    const t = b / (bands - 1) // 0 at the centre
    const light = 0.3 - t * 0.17
    palette.push(hslToRgb(hue, sat * (1 - t * 0.35), Math.max(0.05, light)))
  }
  for (let y = 0; y < size; y++) {
    const dy = y - cy
    const dy2 = dy * dy
    for (let x = 0; x < size; x++) {
      const dx = x - cx
      const d2 = dx * dx + dy2
      if (d2 >= rMax2) continue
      // sqrt gives even band spacing (squared distance crowds them at the rim);
      // correctly rounded, so still bit-identical everywhere
      const band = Math.min(bands - 1, Math.floor((Math.sqrt(d2) * bands) / rMax))
      const c = palette[band]!
      const i = (y * size + x) * 4
      bmp.data[i] = c[0]
      bmp.data[i + 1] = c[1]
      bmp.data[i + 2] = c[2]
      bmp.data[i + 3] = 255
    }
  }
}

/** A ring drawn by testing squared radii — no trigonometry. */
function drawRing(bmp: Bitmap, size: number, r: number, thickness: number, c: RGB, alpha: number): void {
  const cx = size >> 1
  const cy = size >> 1
  const inner = (r - thickness) * (r - thickness)
  const outer = r * r
  for (let y = 0; y < size; y++) {
    const dy = y - cy
    const dy2 = dy * dy
    for (let x = 0; x < size; x++) {
      const dx = x - cx
      const d2 = dx * dx + dy2
      if (d2 <= outer && d2 >= inner) fillRect(bmp, x, y, 1, 1, c, alpha)
    }
  }
}

export interface Face {
  png: Buffer
  cid: string
  avatar: Avatar
  variant: FaceVariant
  size: number
}

/**
 * Render the portrait. `size` must be a multiple of 24 so the 16×24 sprite lands
 * on an integer scale — a fractional scale would need interpolation, and
 * interpolation is where determinism goes to die.
 */
export async function renderFace(
  did: string, variant: FaceVariant = 'explorer', size = 480,
): Promise<Face> {
  const avatar = await deriveAvatar(did)
  const bd = backdrop(avatar)
  const accent = hexToRgb(String(avatar.traits.accent_palette))
  const bmp = createBitmap(size, size)

  fillRect(bmp, 0, 0, size, size, INK)
  drawGlow(bmp, size, bd.h, bd.s)

  const floorY = Math.round(size * 0.7)
  if (variant === 'explorer') {
    fillRect(bmp, 0, floorY, size, size - floorY, hslToRgb(bd.h, bd.s * 0.5, 0.12))
    // lit floor tiles, on an integer grid
    const cell = Math.round(size / 12)
    for (let i = 0; i < 12; i++) {
      if (i % 3 === 0) fillRect(bmp, i * cell, floorY, cell - 2, Math.round(cell * 0.34), hslToRgb(bd.h, bd.s, 0.3))
    }
    for (let ry = 0; ry * cell + floorY < size; ry++) {
      for (let rx = 0; rx < 12; rx++) {
        if ((rx + ry) % 2 === 0) fillRect(bmp, rx * cell, floorY + ry * cell, cell, cell, [255, 255, 255], 0.03)
      }
    }
  }

  // the sprite, at an INTEGER scale (a fractional one would need interpolation,
  // and interpolation is where determinism goes to die). Explorer shows the whole
  // 16x24 body at ~56% of the frame; portrait crops to the top 15 rows.
  const scale = variant === 'portrait'
    ? Math.floor((size * 0.62) / 15)
    : Math.floor((size * 0.56) / 24)
  const spriteW = 16 * scale
  const x = Math.round((size - spriteW) / 2)
  if (variant === 'portrait') {
    // head and shoulders: draw the whole sprite low and let the frame crop it
    const top = Math.round(size * 0.16)
    drawSprite(bmp, avatar, x, top, scale)
    // mask everything below the torso so the crop is exact and integer
    fillRect(bmp, 0, top + 15 * scale, size, size, INK, 1)
    drawGlowFooter(bmp, size, bd.h, bd.s)
  } else {
    const feet = Math.round(size * 0.84)
    drawSprite(bmp, avatar, x, feet - 24 * scale, scale)
    fillRect(bmp, x + scale * 3, feet - 2, spriteW - scale * 6, Math.max(2, Math.round(scale * 0.5)), [0, 0, 0], 0.4)
  }

  drawRing(bmp, size, Math.round(size * 0.47), Math.max(2, Math.round(size * 0.016)), accent, 0.22)
  drawSparkle(bmp, Math.round(size * 0.86), Math.round(size * 0.88), Math.round(size * 0.028), accent, 0.85)

  const png = encodePng(bmp)
  return { png, cid: await rawCid(png), avatar, variant, size }
}

/** The portrait variant's lower band, so the crop doesn't end in flat ink. */
function drawGlowFooter(bmp: Bitmap, size: number, hue: number, sat: number): void {
  const top = Math.round(size * 0.86)
  fillRect(bmp, 0, top, size, size - top, hslToRgb(hue, sat * 0.5, 0.1))
}
