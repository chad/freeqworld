// Sprite cache: DID -> offscreen canvases for each facing/frame, rendered
// from the deterministic avatar generator. Agents get form-specific tints.

import { deriveAvatar, renderSpritePixels, type Avatar, type Facing } from '../../shared/src/avatar'

export interface SpriteSet {
  avatar: Avatar
  frames: Map<string, HTMLCanvasElement>
}

const cache = new Map<string, Promise<SpriteSet>>()

export function spriteFor(did: string): Promise<SpriteSet> {
  let existing = cache.get(did)
  if (!existing) {
    existing = build(did)
    cache.set(did, existing)
  }
  return existing
}

async function build(did: string): Promise<SpriteSet> {
  const avatar = await deriveAvatar(did)
  const frames = new Map<string, HTMLCanvasElement>()
  for (const facing of ['south', 'north', 'east', 'west'] as Facing[]) {
    for (const frame of [0, 1, 2]) {
      const px = renderSpritePixels(avatar, facing, frame)
      const canvas = document.createElement('canvas')
      canvas.width = px.width
      canvas.height = px.height
      const ctx = canvas.getContext('2d')!
      const img = ctx.createImageData(px.width, px.height)
      for (let i = 0; i < px.pixels.length; i++) {
        const color = px.palette[px.pixels[i]!]!
        if (color === 'transparent') continue
        const r = parseInt(color.slice(1, 3), 16)
        const g = parseInt(color.slice(3, 5), 16)
        const b = parseInt(color.slice(5, 7), 16)
        img.data[i * 4] = r
        img.data[i * 4 + 1] = g
        img.data[i * 4 + 2] = b
        img.data[i * 4 + 3] = 255
      }
      ctx.putImageData(img, 0, 0)
      frames.set(`${facing}:${frame}`, canvas)
    }
  }
  return { avatar, frames }
}

/** Draw an avatar preview (idle south) scaled into a target canvas. */
export async function drawPreview(did: string, target: HTMLCanvasElement): Promise<void> {
  const set = await spriteFor(did)
  const src = set.frames.get('south:0')!
  const ctx = target.getContext('2d')!
  ctx.imageSmoothingEnabled = false
  ctx.clearRect(0, 0, target.width, target.height)
  ctx.drawImage(src, 0, 0, target.width, target.height)
}
