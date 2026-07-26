import { describe, expect, it } from 'vitest'
import { renderCard } from './card.ts'
import { createBitmap, encodePng, fillRect } from './png.ts'
import { drawText, textWidth } from './font.ts'

const DID = 'did:plc:z72i7hdynmk6r22z27h6tvur'

describe('share card', () => {
  it('writes a valid PNG', async () => {
    const { png } = await renderCard(DID, '@BSKY.APP')
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR')
    expect(png.readUInt32BE(16)).toBe(1200) // the aspect Bluesky/OG expect
    expect(png.readUInt32BE(20)).toBe(630)
    expect(png.subarray(-8, -4).toString('ascii')).toBe('IEND')
    expect(png.length).toBeGreaterThan(10_000)
  })

  it('is a pure function of the DID (crawlers refetch; caches are safe)', async () => {
    const a = await renderCard(DID, '@BSKY.APP')
    const b = await renderCard(DID, '@BSKY.APP')
    expect(a.png.equals(b.png)).toBe(true)
  })

  it('looks different for different identities', async () => {
    const a = await renderCard(DID, '@A')
    const b = await renderCard('did:plc:ewvi7nxzyoun6zhxrhs64oiz', '@B')
    expect(a.png.equals(b.png)).toBe(false)
  })

  it('renders every glyph the font claims to have', () => {
    // 5x7 = 35 bits, wider than an int32: `>>` silently mangles glyphs whose
    // top-left pixel is set (L came out as C). Lock the bit reader down.
    const bmp = createBitmap(80, 12)
    const ink: [number, number, number] = [255, 255, 255]
    const litPixels = (ch: string): number => {
      fillRect(bmp, 0, 0, 80, 12, [0, 0, 0])
      drawText(bmp, ch, 1, 1, ink, { scale: 1 })
      let n = 0
      for (let i = 0; i < bmp.data.length; i += 4) if (bmp.data[i] === 255) n++
      return n
    }
    expect(litPixels('L')).toBe(11) // 6 stem + 5 base, and NOT a top bar
    expect(litPixels('I')).toBe(15)
    expect(litPixels(' ')).toBe(0)
    for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') {
      expect(litPixels(ch), `glyph ${ch}`).toBeGreaterThan(4)
    }
  })

  it('measures text so layouts can avoid collisions', () => {
    expect(textWidth('AB', 3, 1)).toBe(2 * 18 - 3)
    const png = encodePng(createBitmap(4, 4))
    expect(png.length).toBeGreaterThan(20)
  })
})
