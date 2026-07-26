// A 5×7 pixel font, written out because the share card is rendered server-side
// with no canvas and no font files. Uppercase only — which is the right look for
// a 1992-arcade card anyway.
//
// Each glyph is 7 rows of 5 bits, most significant bit leftmost, written as
// binary literals so the letterforms are legible in the source.
//
// NOTE 5 × 7 = 35 bits, which is WIDER THAN AN INT32. `bits >> shift` coerces to
// int32 and silently mangles every glyph whose top-left pixel is set (L renders
// as C, etc). Read bits with floating-point division instead — exact to 2^53.

import { blend, fillRect, type Bitmap, type RGB } from './png.ts'

export const GLYPH_W = 5
export const GLYPH_H = 7

// prettier-ignore
const FONT: Record<string, number> = {
  A: 0b01110_10001_10001_11111_10001_10001_10001,
  B: 0b11110_10001_10001_11110_10001_10001_11110,
  C: 0b01110_10001_10000_10000_10000_10001_01110,
  D: 0b11110_10001_10001_10001_10001_10001_11110,
  E: 0b11111_10000_10000_11110_10000_10000_11111,
  F: 0b11111_10000_10000_11110_10000_10000_10000,
  G: 0b01110_10001_10000_10111_10001_10001_01110,
  H: 0b10001_10001_10001_11111_10001_10001_10001,
  I: 0b11111_00100_00100_00100_00100_00100_11111,
  J: 0b00111_00010_00010_00010_00010_10010_01100,
  K: 0b10001_10010_10100_11000_10100_10010_10001,
  L: 0b10000_10000_10000_10000_10000_10000_11111,
  M: 0b10001_11011_10101_10101_10001_10001_10001,
  N: 0b10001_11001_11001_10101_10011_10011_10001,
  O: 0b01110_10001_10001_10001_10001_10001_01110,
  P: 0b11110_10001_10001_11110_10000_10000_10000,
  Q: 0b01110_10001_10001_10001_10101_10011_01111,
  R: 0b11110_10001_10001_11110_10100_10010_10001,
  S: 0b01111_10000_10000_01110_00001_00001_11110,
  T: 0b11111_00100_00100_00100_00100_00100_00100,
  U: 0b10001_10001_10001_10001_10001_10001_01110,
  V: 0b10001_10001_10001_10001_10001_01010_00100,
  W: 0b10001_10001_10001_10101_10101_11011_10001,
  X: 0b10001_10001_01010_00100_01010_10001_10001,
  Y: 0b10001_10001_01010_00100_00100_00100_00100,
  Z: 0b11111_00001_00010_00100_01000_10000_11111,
  '0': 0b01110_10001_10011_10101_11001_10001_01110,
  '1': 0b00100_01100_00100_00100_00100_00100_01110,
  '2': 0b01110_10001_00001_00010_00100_01000_11111,
  '3': 0b11110_00001_00001_01110_00001_00001_11110,
  '4': 0b00010_00110_01010_10010_11111_00010_00010,
  '5': 0b11111_10000_10000_11110_00001_00001_11110,
  '6': 0b00110_01000_10000_11110_10001_10001_01110,
  '7': 0b11111_00001_00010_00100_01000_01000_01000,
  '8': 0b01110_10001_10001_01110_10001_10001_01110,
  '9': 0b01110_10001_10001_01111_00001_00010_01100,
  ' ': 0,
  '.': 0b00000_00000_00000_00000_00000_01100_01100,
  ',': 0b00000_00000_00000_00000_01100_01100_00100,
  ':': 0b00000_01100_01100_00000_01100_01100_00000,
  '-': 0b00000_00000_00000_11111_00000_00000_00000,
  '+': 0b00000_00100_00100_11111_00100_00100_00000,
  '#': 0b01010_01010_11111_01010_11111_01010_01010,
  '@': 0b01110_10001_10111_10101_10111_10000_01110,
  '/': 0b00001_00010_00010_00100_01000_01000_10000,
  '!': 0b00100_00100_00100_00100_00100_00000_00100,
  '?': 0b01110_10001_00001_00010_00100_00000_00100,
  "'": 0b00100_00100_00000_00000_00000_00000_00000,
  '(': 0b00010_00100_01000_01000_01000_00100_00010,
  ')': 0b01000_00100_00010_00010_00010_00100_01000,
  '%': 0b11001_11010_00010_00100_01000_01011_10011,
  '=': 0b00000_00000_11111_00000_11111_00000_00000,
  '*': 0b00000_01010_00100_11111_00100_01010_00000,
  '~': 0b00000_00000_01001_10101_10010_00000_00000,
  '"': 0b01010_01010_00000_00000_00000_00000_00000,
  '_': 0b00000_00000_00000_00000_00000_00000_11111,
}

/** em-dash and a few typographic characters map onto drawable equivalents. */
const ALIAS: Record<string, string> = { '—': '-', '–': '-', '’': "'", '“': '"', '”': '"', '·': '.' }

function glyph(ch: string): number {
  const c = ch.toUpperCase()
  return FONT[c] ?? FONT[ALIAS[c] ?? ''] ?? FONT['?']!
}

export function textWidth(text: string, scale: number, tracking = 1): number {
  return text.length * (GLYPH_W + tracking) * scale - tracking * scale
}

export interface TextOpts {
  scale?: number
  tracking?: number
  alpha?: number
  /** draw a 1px (scaled) drop shadow — keeps text legible over the backdrop */
  shadow?: RGB
}

export function drawText(
  bmp: Bitmap, text: string, x: number, y: number, color: RGB, opts: TextOpts = {},
): number {
  const scale = opts.scale ?? 1
  const tracking = opts.tracking ?? 1
  let cx = x
  for (const ch of text) {
    const bits = glyph(ch)
    for (let row = 0; row < GLYPH_H; row++) {
      for (let col = 0; col < GLYPH_W; col++) {
        const shift = (GLYPH_H - 1 - row) * GLYPH_W + (GLYPH_W - 1 - col)
        const bit = Math.floor(bits / 2 ** shift) % 2
        if (!bit) continue
        const px = cx + col * scale
        const py = y + row * scale
        if (opts.shadow) fillRect(bmp, px + scale, py + scale, scale, scale, opts.shadow, 0.85)
        fillRect(bmp, px, py, scale, scale, color, opts.alpha ?? 1)
      }
    }
    cx += (GLYPH_W + tracking) * scale
  }
  return cx
}

export function drawTextCentered(
  bmp: Bitmap, text: string, cx: number, y: number, color: RGB, opts: TextOpts = {},
): void {
  const w = textWidth(text, opts.scale ?? 1, opts.tracking ?? 1)
  drawText(bmp, text, Math.round(cx - w / 2), y, color, opts)
}

/** The ✦ mark, drawn rather than typeset. */
export function drawSparkle(bmp: Bitmap, cx: number, cy: number, r: number, color: RGB, a = 1): void {
  for (let i = -r; i <= r; i++) {
    const t = 1 - Math.abs(i) / r
    const thick = Math.max(1, Math.round(r * 0.28 * t))
    fillRect(bmp, cx + i, cy - thick / 2, 1, thick, color, a)
    fillRect(bmp, cx - thick / 2, cy + i, thick, 1, color, a)
  }
}

/** A filled play triangle — the affordance that makes a card look playable. */
export function drawPlayTriangle(bmp: Bitmap, cx: number, cy: number, r: number, color: RGB, a = 1): void {
  for (let dy = -r; dy <= r; dy++) {
    const w = Math.round((1 - Math.abs(dy) / r) * r * 1.15)
    fillRect(bmp, cx - r * 0.45, cy + dy, w, 1, color, a)
  }
}
