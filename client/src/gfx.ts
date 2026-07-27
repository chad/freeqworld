// Rendering polish for the world canvas: a torch-lit light map, 3/4-view wall
// depth, dithered floors, contact shadows, vignette and CRT scanlines.
//
// Everything here is *presentation only*. The deterministic avatar generator
// (shared/src/avatar.ts) is frozen — same DID, same face, forever — so nothing
// in this module touches sprite pixels or traits. It changes how the ROOM is
// lit and textured around them.
//
// Budget: 320×180 internal target, ≤ ~24 lights, all compositing done with
// canvas blend modes (GPU-side) rather than per-pixel JS loops.

export interface Rgb {
  r: number
  g: number
  b: number
}

export function hexToRgb(hex: string): Rgb {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  }
}

/** Multiply a #rrggbb toward black (f<1) or white (f>1). */
export function shadeRgb(hex: string, f: number): string {
  const { r, g, b } = hexToRgb(hex)
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * f)))
  return `rgb(${c(r)},${c(g)},${c(b)})`
}

/** Stable per-tile hash → 0..1. Same tile, same speckle, every frame. */
export function tileNoise(x: number, y: number, salt = 0): number {
  let h = (x * 374761393 + y * 668265263 + salt * 2246822519) | 0
  h = (h ^ (h >>> 13)) * 1274126177
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

// 4×4 Bayer matrix — ordered dithering, the DOS/VGA gradient look.
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]

/** True when this pixel should be "on" for a given 0..1 coverage. */
export function bayerOn(x: number, y: number, coverage: number): boolean {
  return BAYER[(y & 3) * 4 + (x & 3)]! / 16 < coverage
}

/**
 * Floor tile with flagstone grout and stable speckle. `variant` lets rugs and
 * glow plates share the same texturing so the floor reads as one surface.
 */
export function drawFloorTile(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  size: number,
  base: string,
  x: number,
  y: number,
): void {
  ctx.fillStyle = base
  ctx.fillRect(sx, sy, size, size)

  // stable speckle: three subtle shades, never animating
  const n = tileNoise(x, y)
  if (n > 0.86) {
    ctx.fillStyle = 'rgba(255,255,255,0.030)'
    ctx.fillRect(sx + ((x * 3) % size), sy + ((y * 5) % size), 1, 1)
  } else if (n < 0.10) {
    ctx.fillStyle = 'rgba(0,0,0,0.16)'
    ctx.fillRect(sx + ((y * 7) % size), sy + ((x * 2) % size), 1, 1)
  }

  // grout: darker on the south/east edges reads as bevelled flagstone
  ctx.fillStyle = 'rgba(0,0,0,0.13)'
  ctx.fillRect(sx, sy + size - 1, size, 1)
  ctx.fillRect(sx + size - 1, sy, 1, size)
  ctx.fillStyle = 'rgba(255,255,255,0.020)'
  ctx.fillRect(sx, sy, size, 1)
}

/**
 * Wall in 3/4 view. A wall whose south neighbour is open shows a lit brick
 * FACE with a cap highlight; interior wall is the darker TOP surface. This is
 * the single biggest depth cue in the scene.
 */
export function drawWallTile(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  size: number,
  wall: string,
  x: number,
  y: number,
  isFace: boolean,
): void {
  if (!isFace) {
    // top surface — dark, slightly mottled
    ctx.fillStyle = shadeRgb(wall, 0.52)
    ctx.fillRect(sx, sy, size, size)
    if (tileNoise(x, y, 7) > 0.8) {
      ctx.fillStyle = 'rgba(255,255,255,0.022)'
      ctx.fillRect(sx + ((x * 5) % size), sy + ((y * 3) % size), 1, 1)
    }
    return
  }

  // lit front face
  ctx.fillStyle = shadeRgb(wall, 1.12)
  ctx.fillRect(sx, sy, size, size)

  // brick courses: two per tile, offset every other row (running bond)
  ctx.fillStyle = 'rgba(0,0,0,0.20)'
  ctx.fillRect(sx, sy + Math.floor(size / 2) - 1, size, 1)
  const offset = y % 2 === 0 ? 0 : Math.floor(size / 2)
  ctx.fillRect(sx + offset, sy, 1, Math.floor(size / 2) - 1)
  ctx.fillRect(sx + ((offset + Math.floor(size / 2)) % size), sy + Math.floor(size / 2), 1, size - Math.floor(size / 2))

  // cap highlight along the top edge, shadow along the base
  ctx.fillStyle = shadeRgb(wall, 1.5)
  ctx.fillRect(sx, sy, size, 1)
  ctx.fillStyle = 'rgba(0,0,0,0.35)'
  ctx.fillRect(sx, sy + size - 1, size, 1)
}

/** Ambient-occlusion strip on the floor directly beneath a wall face. */
export function drawWallShadow(ctx: CanvasRenderingContext2D, sx: number, sy: number, size: number): void {
  const g = ctx.createLinearGradient(0, sy, 0, sy + size * 0.75)
  g.addColorStop(0, 'rgba(0,0,0,0.42)')
  g.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = g
  ctx.fillRect(sx, sy, size, Math.ceil(size * 0.75))
}

/** Soft contact shadow under a standing entity — grounds sprites on the floor. */
export function drawContactShadow(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  rx = 5,
  alpha = 0.34,
): void {
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.fillStyle = '#000'
  ctx.beginPath()
  ctx.ellipse(cx, cy, rx, Math.max(1.5, rx * 0.38), 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

/**
 * Torch-lit darkness. Ambient shadow is punched through by each light
 * (destination-out), then warm colour is added back on top (lighter). Two
 * offscreen buffers, composited once — cheap enough for a 60fps loop.
 */
export class LightMap {
  private dark: HTMLCanvasElement
  private dctx: CanvasRenderingContext2D
  private lit: HTMLCanvasElement
  private lctx: CanvasRenderingContext2D

  constructor(
    private w: number,
    private h: number,
  ) {
    this.dark = document.createElement('canvas')
    this.dark.width = w
    this.dark.height = h
    this.dctx = this.dark.getContext('2d')!
    this.lit = document.createElement('canvas')
    this.lit.width = w
    this.lit.height = h
    this.lctx = this.lit.getContext('2d')!
  }

  /** `ambient` 0..1 — how dark the unlit parts of the room are. */
  begin(ambient: number, tint = '6,8,20'): void {
    this.dctx.globalCompositeOperation = 'source-over'
    this.dctx.clearRect(0, 0, this.w, this.h)
    this.dctx.fillStyle = `rgba(${tint},${ambient})`
    this.dctx.fillRect(0, 0, this.w, this.h)
    this.lctx.clearRect(0, 0, this.w, this.h)
  }

  /** Add a light at screen coords. `color` is #rrggbb; `power` 0..1. */
  add(cx: number, cy: number, radius: number, color: string, power = 1): void {
    if (cx < -radius || cy < -radius || cx > this.w + radius || cy > this.h + radius) return
    const d = this.dctx.createRadialGradient(cx, cy, 0, cx, cy, radius)
    d.addColorStop(0, `rgba(0,0,0,${Math.min(1, power)})`)
    d.addColorStop(0.55, `rgba(0,0,0,${Math.min(1, power * 0.55)})`)
    d.addColorStop(1, 'rgba(0,0,0,0)')
    this.dctx.globalCompositeOperation = 'destination-out'
    this.dctx.fillStyle = d
    this.dctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2)

    const { r, g, b } = hexToRgb(color)
    const l = this.lctx.createRadialGradient(cx, cy, 0, cx, cy, radius)
    l.addColorStop(0, `rgba(${r},${g},${b},${0.30 * power})`)
    l.addColorStop(0.5, `rgba(${r},${g},${b},${0.11 * power})`)
    l.addColorStop(1, `rgba(${r},${g},${b},0)`)
    this.lctx.globalCompositeOperation = 'lighter'
    this.lctx.fillStyle = l
    this.lctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2)
  }

  composite(ctx: CanvasRenderingContext2D): void {
    ctx.globalCompositeOperation = 'source-over'
    ctx.drawImage(this.dark, 0, 0)
    ctx.globalCompositeOperation = 'lighter'
    ctx.drawImage(this.lit, 0, 0)
    ctx.globalCompositeOperation = 'source-over'
  }
}

/** Dust motes drifting in the light — slow, sparse, deterministic-ish. */
export class DustField {
  private motes: { x: number; y: number; vx: number; vy: number; a: number }[] = []
  constructor(
    private w: number,
    private h: number,
    count = 26,
  ) {
    for (let i = 0; i < count; i++) {
      this.motes.push({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: 1.5 + Math.random() * 3,
        vy: -1.5 + Math.random() * 3,
        a: 0.05 + Math.random() * 0.12,
      })
    }
  }

  draw(ctx: CanvasRenderingContext2D, dt: number): void {
    ctx.fillStyle = '#fff'
    for (const m of this.motes) {
      m.x += m.vx * dt
      m.y += m.vy * dt
      if (m.x > this.w) m.x = 0
      if (m.x < 0) m.x = this.w
      if (m.y > this.h) m.y = 0
      if (m.y < 0) m.y = this.h
      ctx.globalAlpha = m.a
      ctx.fillRect(Math.round(m.x), Math.round(m.y), 1, 1)
    }
    ctx.globalAlpha = 1
  }
}

/** Corner darkening — focuses the eye, hides the tilemap edge. */
export function drawVignette(ctx: CanvasRenderingContext2D, w: number, h: number, strength = 0.55): void {
  const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.32, w / 2, h / 2, Math.max(w, h) * 0.72)
  g.addColorStop(0, 'rgba(0,0,0,0)')
  g.addColorStop(1, `rgba(0,0,0,${strength})`)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
}

/** Every other scanline dimmed — the CRT tell, kept subtle enough to read text. */
export function drawScanlines(ctx: CanvasRenderingContext2D, w: number, h: number, alpha = 0.07): void {
  ctx.fillStyle = `rgba(0,0,0,${alpha})`
  for (let y = 0; y < h; y += 2) ctx.fillRect(0, y, w, 1)
}


/**
 * A doorway that reads as a doorway.
 *
 * Before: a dark tile with a 1px line down each side, repeated across the three
 * tiles of an opening — which looked like hatching on the wall, not somewhere
 * you can walk. Now the opening is drawn as one object: a lit lintel across the
 * top, posts only on the outer edges, a dark threshold, and warm light spilling
 * onto the floor in front of it.
 */
export function drawDoorTile(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  size: number,
  glow: string,
  edges: { left: boolean; right: boolean; floorBelow: boolean },
): void {
  // the opening itself: darker than any floor, so it reads as depth
  ctx.fillStyle = '#07070c'
  ctx.fillRect(sx, sy, size, size)

  // lintel across the top of the whole opening
  ctx.fillStyle = glow
  ctx.fillRect(sx, sy, size, 2)
  ctx.fillStyle = 'rgba(255,255,255,0.45)'
  ctx.fillRect(sx, sy, size, 1)

  // posts only where the opening actually ends
  ctx.fillStyle = glow
  if (edges.left) ctx.fillRect(sx, sy, 1, size)
  if (edges.right) ctx.fillRect(sx + size - 1, sy, 1, size)

  // a threshold strip, so the floor line reads as a step through
  ctx.fillStyle = 'rgba(0,0,0,0.55)'
  ctx.fillRect(sx, sy + size - 2, size, 2)

  // light spilling out onto the floor in front
  if (edges.floorBelow) {
    ctx.fillStyle = glow
    ctx.globalAlpha = 0.16
    ctx.fillRect(sx, sy + size, size, 3)
    ctx.globalAlpha = 0.08
    ctx.fillRect(sx - 1, sy + size + 3, size + 2, 3)
    ctx.globalAlpha = 1
  }
}

/**
 * A label that can be read: dark plate, one pixel of padding, centred.
 *
 * Every tag in the world used to be bare 7px text straight onto a textured
 * floor, and in a crowded room the names, the door labels and the topics all
 * landed on top of each other.
 */
export function drawTag(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  y: number,
  colour: string,
  taken: { x: number; y: number; w: number; h: number }[],
  opts: { plate?: boolean } = {},
): void {
  const w = text.length * 4 + 4
  const h = 9
  const x = Math.round(cx - w / 2)
  const maxY = (ctx.canvas?.height ?? 1e4) - h
  // clamp before searching, so a subject near the edge still gets a legible tag
  const y0 = Math.max(1, Math.min(maxY, Math.round(y)))
  const free = (ty: number): boolean =>
    !taken.some((r) => x < r.x + r.w && x + w > r.x && ty < r.y + r.h && ty + h > r.y)
  // Try above first, then below, widening each time. Nudging only upward meant
  // that against the top wall — exactly where the door labels are — there was
  // nowhere to go and tags stacked anyway.
  let ty = y0
  for (const dy of [0, -h, h, -h * 2, h * 2, -h * 3, h * 3]) {
    const cand = y0 + dy
    if (cand < 1 || cand > maxY) continue
    if (free(cand)) {
      ty = cand
      break
    }
  }
  ty = Math.max(1, Math.min(maxY, ty))
  taken.push({ x, y: ty, w, h })
  if (opts.plate !== false) {
    ctx.fillStyle = 'rgba(8,8,14,0.72)'
    ctx.fillRect(x, ty, w, h)
  }
  ctx.fillStyle = colour
  ctx.fillText(text, x + 2, ty + 7)
}
