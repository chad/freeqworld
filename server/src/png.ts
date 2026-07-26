// Minimal RGBA PNG encoder + a tiny raster surface.
//
// Server-side card rendering with no canvas and no image library: the same
// approach as music/src/wav.ts (write the container by hand). Everything the
// share card draws is rectangles and palette-indexed pixels, so this is all we
// need — and it keeps the deploy dependency-free.

import { deflateSync } from 'node:zlib'

export interface Bitmap {
  width: number
  height: number
  /** RGBA, 4 bytes per pixel */
  data: Uint8Array
}

export function createBitmap(width: number, height: number): Bitmap {
  return { width, height, data: new Uint8Array(width * height * 4) }
}

export type RGB = [number, number, number]

export function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '')
  const s = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)]
}

/** Alpha-blend a single pixel. */
export function blend(bmp: Bitmap, x: number, y: number, c: RGB, a = 1): void {
  const xi = x | 0
  const yi = y | 0
  if (xi < 0 || yi < 0 || xi >= bmp.width || yi >= bmp.height || a <= 0) return
  const i = (yi * bmp.width + xi) * 4
  const d = bmp.data
  if (a >= 1) {
    d[i] = c[0]
    d[i + 1] = c[1]
    d[i + 2] = c[2]
    d[i + 3] = 255
    return
  }
  d[i] = Math.round(d[i]! + (c[0] - d[i]!) * a)
  d[i + 1] = Math.round(d[i + 1]! + (c[1] - d[i + 1]!) * a)
  d[i + 2] = Math.round(d[i + 2]! + (c[2] - d[i + 2]!) * a)
  d[i + 3] = Math.max(d[i + 3]!, Math.round(255 * a))
}

export function fillRect(
  bmp: Bitmap, x: number, y: number, w: number, h: number, c: RGB, a = 1,
): void {
  const x0 = Math.max(0, Math.round(x))
  const y0 = Math.max(0, Math.round(y))
  const x1 = Math.min(bmp.width, Math.round(x + w))
  const y1 = Math.min(bmp.height, Math.round(y + h))
  for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) blend(bmp, xx, yy, c, a)
}

/** Stroked circle/ellipse, for the accent ring. */
export function strokeEllipse(
  bmp: Bitmap, cx: number, cy: number, rx: number, ry: number, thickness: number, c: RGB, a = 1,
): void {
  const steps = Math.ceil(Math.max(rx, ry) * 8)
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2
    const px = cx + Math.cos(t) * rx
    const py = cy + Math.sin(t) * ry
    fillRect(bmp, px - thickness / 2, py - thickness / 2, thickness, thickness, c, a)
  }
}

export function fillEllipse(
  bmp: Bitmap, cx: number, cy: number, rx: number, ry: number, c: RGB, a = 1,
): void {
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const dx = (x - cx) / rx
      const dy = (y - cy) / ry
      if (dx * dx + dy * dy <= 1) blend(bmp, x, y, c, a)
    }
  }
}

// --- PNG container ---------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, body: Uint8Array): Buffer {
  const out = Buffer.alloc(body.length + 12)
  out.writeUInt32BE(body.length, 0)
  out.write(type, 4, 'ascii')
  Buffer.from(body).copy(out, 8)
  const crcInput = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(body)])
  out.writeUInt32BE(crc32(crcInput), 8 + body.length)
  return out
}

export function encodePng(bmp: Bitmap): Buffer {
  const { width, height, data } = bmp
  // one filter byte (0 = None) per scanline
  const raw = Buffer.alloc(height * (width * 4 + 1))
  for (let y = 0; y < height; y++) {
    const o = y * (width * 4 + 1)
    raw[o] = 0
    Buffer.from(data.buffer, data.byteOffset + y * width * 4, width * 4).copy(raw, o + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ])
}
