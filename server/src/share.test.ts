import { describe, expect, it } from 'vitest'
import { appPageWithOg, type Identity } from './share.ts'
import { ffmpeg, renderClip } from './clip.ts'

const INDEX = `<!doctype html><html><head><title>FreeqWorld ID</title>
<meta name="description" content="generic site description" />
<meta property="og:title" content="FreeqWorld ID" />
<meta property="og:image" content="https://world.freeq.at/og.png" />
<meta name="twitter:card" content="summary_large_image" />
</head><body><div id="app"></div></body></html>`

const sharePage = (id: Identity, origin: string) => appPageWithOg(id, origin, INDEX)

const ID: Identity = {
  did: 'did:plc:z72i7hdynmk6r22z27h6tvur',
  handle: 'bsky.app',
  label: '@bsky.app',
}

describe('share page', () => {
  it('tailors the unfurl to the linked profile', async () => {
    const html = await sharePage(ID, 'https://pfp.freeq.at')
    // the build's own generic tags must be GONE, not duplicated
    expect(html).not.toContain('world.freeq.at/og.png')
    expect(html).not.toContain('generic site description')
    expect(html.match(/property="og:title"/g)).toHaveLength(1)
    expect(html.match(/<title>/g)).toHaveLength(1)
    // and it's still the app, not an interstitial
    expect(html).toContain('<div id="app"></div>')
    // the person, not the site
    expect(html).toContain('<meta property="og:title" content="@bsky.app in FreeqWorld')
    expect(html).toMatch(/og:description" content="@bsky\.app's character and their theme tune/)
    // per-person image, and the canonical URL every share consolidates on
    expect(html).toContain('https://pfp.freeq.at/card/bsky.app.png')
    expect(html).toContain('<meta property="og:url" content="https://pfp.freeq.at/u/bsky.app" />')
    expect(html).toContain('<meta property="og:image:width" content="1200" />')
    // Bluesky and X only ever use the image, so it must always be present
    expect(html).toContain('twitter:card" content="summary_large_image"')
  })

  it('escapes user-controlled text into the meta tags', async () => {
    const html = await sharePage({ ...ID, handle: 'a"b<c', label: '@a"b<c' }, 'https://pfp.freeq.at')
    expect(html).not.toMatch(/content="[^"]*"[^">]*<c/)
    expect(html).toContain('&quot;')
    expect(html).toContain('&lt;')
  })

  it('advertises og:video only when an encoder is present', async () => {
    const html = await sharePage(ID, 'https://pfp.freeq.at')
    const hasEncoder = (await ffmpeg()) !== null
    expect(html.includes('og:video')).toBe(hasEncoder)
    // og:type follows: video.other is what makes Discord look for the player
    expect(html).toContain(`og:type" content="${hasEncoder ? 'video.other' : 'music.song'}"`)
  })
})

describe('clip', () => {
  it.runIf(process.env.CLIP_TEST)('encodes a playable, streamable mp4', async () => {
    const { mp4, seconds } = await renderClip(ID.did, '@BSKY.APP')
    expect(seconds).toBeGreaterThan(8)
    expect(seconds).toBeLessThan(20)
    // faststart: the moov atom must precede mdat or players won't begin
    // streaming until the whole file has downloaded
    expect(mp4.indexOf('moov')).toBeLessThan(mp4.indexOf('mdat'))
    expect(mp4.subarray(4, 8).toString('ascii')).toBe('ftyp')
    expect(mp4.length).toBeGreaterThan(50_000)
  }, 60_000)
})

describe('asset base', () => {
  const INDEX_ID = '<html><head><title>x</title></head><body>' +
    '<script type="module" crossorigin src="/id/assets/index-abc.js"></script>' +
    '<link rel="stylesheet" href="/id/assets/index-abc.css"></body></html>'

  it('rewrites the asset base when served at the root (pfp.freeq.at)', async () => {
    const html = await appPageWithOg(ID, 'https://pfp.freeq.at', INDEX_ID, { basePath: '/' })
    expect(html).toContain('src="/assets/index-abc.js"')
    expect(html).toContain('href="/assets/index-abc.css"')
    expect(html).not.toContain('/id/assets/')
  })

  it('leaves it alone under /id/ (world.freeq.at)', async () => {
    const html = await appPageWithOg(ID, 'https://pfp.freeq.at', INDEX_ID, { basePath: '/id/' })
    expect(html).toContain('src="/id/assets/index-abc.js"')
  })
})
