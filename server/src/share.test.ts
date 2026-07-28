import { describe, expect, it } from 'vitest'
import { appPageWithOg, scoreCardPng, scorePage, type Identity } from './share.ts'
import { renderScoreCard } from './scorecard.ts'
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

describe('score page', () => {
  const ID: Identity = { did: 'did:plc:z72i7hdynmk6r22z27h6tvur', handle: 'bsky.app', label: '@bsky.app' }

  it('carries the downloads and the engraver', async () => {
    const html = await scorePage(ID, 'https://pfp.freeq.at')
    expect(html).toContain('/theme/bsky.app.musicxml')
    expect(html).toContain('/theme/bsky.app.mid')
    expect(html).toContain('/theme/bsky.app.wav')
    expect(html).toContain('/osmd.js')
    expect(html).toContain('id="paper"')
  })

  it('unfurls as a piece of music, not a generic page', async () => {
    const html = await scorePage(ID, 'https://pfp.freeq.at')
    // deliberately NOT music.song — see the twitter:player note below
    expect(html).toContain('<meta property="og:type" content="article" />')
    expect(html).toMatch(/og:title" content="[^"]*@bsky\.app's theme/)
    expect(html).toContain('og:image')
    // the key and tempo are facts about the derivation, so they belong in the unfurl
    expect(html).toMatch(/og:description" content="[^"]*BPM/)
  })

  it('does not use `status` as a global, which window.status silently breaks', async () => {
    // window.status is a legacy DOMString: `var status = <element>` coerces the
    // element to a string, so .remove() throws and .textContent = msg no-ops —
    // the page hangs on "engraving…" with nothing in the console.
    const html = await scorePage(ID, 'https://pfp.freeq.at')
    // strip comments first: the explanation of this bug contains the bug
    const code = html.replace(/^\s*\/\/.*$/gm, '')
    expect(code, 'window.status collision is back').not.toMatch(/var status\s*=/)
    expect(code).toContain('statusEl')
  })

  it('states the failure in the page when the engraver cannot run', async () => {
    const html = await scorePage(ID, 'https://pfp.freeq.at')
    expect(html).toContain('the engraver did not load')
    expect(html).toContain('could not engrave this score')
    expect(html).toContain("console.error('[score]'")
  })

  it('names the DID the score is derived from', async () => {
    const html = await scorePage(ID, 'https://pfp.freeq.at')
    expect(html).toContain('did:plc:z72i7hdynmk6r22z27h6tvur')
  })
})

describe('score card (the unfurl image)', () => {
  const ID: Identity = { did: 'did:plc:z72i7hdynmk6r22z27h6tvur', handle: 'bsky.app', label: '@bsky.app' }

  it('the score page unfurls with its own music, not the character card', async () => {
    const html = await scorePage(ID, 'https://pfp.freeq.at')
    expect(html).toContain('og:image" content="https://pfp.freeq.at/score/bsky.app.png"')
    expect(html).not.toContain('og:image" content="https://pfp.freeq.at/card/')
  })

  it('renders a 1200x630 PNG', async () => {
    const png = await scoreCardPng(ID)
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    // IHDR width/height, big-endian at bytes 16..24
    expect(png.readUInt32BE(16)).toBe(1200)
    expect(png.readUInt32BE(20)).toBe(630)
  })

  it('is deterministic — the same DID always produces the same bytes', async () => {
    const a = await renderScoreCard(ID.did, ID.label)
    const b = await renderScoreCard(ID.did, ID.label)
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true)
  })

  it('differs between identities', async () => {
    const a = await renderScoreCard('did:plc:aaaaaaaaaaaaaaaaaaaaaaaa', '@a.example')
    const b = await renderScoreCard('did:plc:bbbbbbbbbbbbbbbbbbbbbbbb', '@b.example')
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false)
  })
})

describe('score page unfurl tags', () => {
  const ID: Identity = { did: 'did:plc:z72i7hdynmk6r22z27h6tvur', handle: 'bsky.app', label: '@bsky.app' }

  it('names the twitter tags explicitly rather than trusting og fallback', async () => {
    const html = await scorePage(ID, 'https://pfp.freeq.at')
    expect(html).toContain('name="twitter:card" content="summary_large_image"')
    expect(html).toContain('name="twitter:image" content="https://pfp.freeq.at/score/bsky.app.png"')
    expect(html).toMatch(/name="twitter:title"/)
    expect(html).toMatch(/name="twitter:description"/)
  })

  it('does not advertise audio without a player, which costs the card on X', async () => {
    // strip comments: the note explaining this contains the very strings it forbids
    const html = (await scorePage(ID, 'https://pfp.freeq.at')).replace(/<!--[\s\S]*?-->/g, '')
    // og:audio + no twitter:player => X attempts a player card and renders none
    expect(html).not.toContain('og:audio')
    expect(html).not.toContain('music.song')
  })

  it('declares the image dimensions and a canonical url', async () => {
    const html = await scorePage(ID, 'https://pfp.freeq.at')
    expect(html).toContain('og:image:width" content="1200"')
    expect(html).toContain('og:image:height" content="630"')
    expect(html).toContain('og:url" content="https://pfp.freeq.at/score/bsky.app"')
    expect(html).toContain('rel="canonical"')
  })

  it('describes the image for anyone who cannot see it', async () => {
    const html = await scorePage(ID, 'https://pfp.freeq.at')
    expect(html).toMatch(/og:image:alt" content="The opening bars of [^"]+, engraved"/)
  })
})
