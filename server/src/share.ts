// Shareable identity pages: /u/<handle> unfurls as that person's character.
//
// Why this needs a server at all: a static SPA cannot vary its OpenGraph tags
// per URL, because crawlers don't run JavaScript. Every share of pfp.freeq.at
// therefore unfurled with the same generic card, no matter whose character you
// were looking at. These routes fix that.
//
// What each platform can actually do with an unfurl (measured, not assumed):
//   Bluesky   — title + description + ONE STATIC IMAGE. Their card service
//               re-encodes the image through its own proxy and ignores
//               og:video entirely (even for YouTube). So the image carries it.
//   Discord   — plays og:video mp4 inline, and renders a real audio player for
//               a direct audio/* link, which is why /theme/<handle>.wav exists.
//   Telegram / Mastodon / iMessage — og:video mp4 plays inline.
//   X / Slack — static image (player cards need vendor approval).

import { renderCard } from './card.ts'
import { compose } from '../../music/src/compose.ts'
import { mintChiptune } from '../../music/src/mint.ts'
import { renderScore } from '../../music/src/synth.ts'
import { encodeWav } from '../../music/src/wav.ts'
import { deriveStinger } from '../../music/src/motif.ts'
import { CLIP_H, CLIP_W, clipFor, ffmpeg } from './clip.ts'

const APPVIEW = 'https://public.api.bsky.app/xrpc'

export interface Identity {
  did: string
  handle: string
  label: string
}

const idCache = new Map<string, { value: Identity; at: number }>()
const cardCache = new Map<string, { png: Buffer; at: number }>()
const wavCache = new Map<string, { wav: Uint8Array; at: number }>()
const TTL = 60 * 60 * 1000 // handles can move; an hour is plenty for a crawler

/** "@alice.bsky.social", "alice.bsky.social" or a raw DID -> identity. */
export async function resolveIdentity(input: string): Promise<Identity> {
  const raw = decodeURIComponent(input).trim().replace(/^@/, '').replace(/\.(png|wav|json|mp4)$/i, '')
  const hit = idCache.get(raw)
  if (hit && Date.now() - hit.at < TTL) return hit.value

  let value: Identity
  if (raw.startsWith('did:')) {
    // best-effort handle lookup, purely cosmetic
    let handle = ''
    try {
      const r = await fetch(`${APPVIEW}/app.bsky.actor.getProfile?actor=${encodeURIComponent(raw)}`)
      if (r.ok) handle = ((await r.json()) as { handle?: string }).handle ?? ''
    } catch {
      /* offline or not a Bluesky identity — the DID is enough */
    }
    value = { did: raw, handle, label: handle ? `@${handle}` : shortDid(raw) }
  } else {
    if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(raw)) throw new Error('not a handle')
    const r = await fetch(`${APPVIEW}/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(raw)}`)
    if (!r.ok) throw new Error(`couldn't resolve @${raw}`)
    const did = ((await r.json()) as { did: string }).did
    value = { did, handle: raw, label: `@${raw}` }
  }
  idCache.set(raw, { value, at: Date.now() })
  return value
}

function shortDid(did: string): string {
  return did.length > 24 ? `${did.slice(0, 16)}.${did.slice(-4)}` : did
}

export async function cardPng(id: Identity): Promise<Buffer> {
  const hit = cardCache.get(id.did)
  if (hit && Date.now() - hit.at < TTL) return hit.png
  const { png } = await renderCard(id.did, id.label.toUpperCase())
  cardCache.set(id.did, { png, at: Date.now() })
  if (cardCache.size > 500) cardCache.delete(cardCache.keys().next().value!)
  return png
}

/** The loop as a wav — a direct audio link unfurls as a player in Discord. */
/** 8 bars, mono, 22 kHz: ~1.7 MB instead of 5 MB, and it opens on the melody
 *  rather than an intro — this is a preview that has to load in a chat client. */
export async function themeWav(id: Identity, bars = 8): Promise<Uint8Array> {
  const key = `${id.did}:${bars}`
  const hit = wavCache.get(key)
  if (hit && Date.now() - hit.at < TTL) return hit.wav
  const minted = await mintChiptune(id.did, bars)
  const wav = encodeWav(renderScore(compose(minted.theme), { loop: true, sampleRate: 22050 }), { mono: true })
  wavCache.set(key, { wav, at: Date.now() })
  if (wavCache.size > 200) wavCache.delete(wavCache.keys().next().value!)
  return wav
}

export async function clipMp4(id: Identity): Promise<Buffer> {
  const { mp4 } = await clipFor(id.did, id.label.toUpperCase())
  return mp4
}

export async function stingerWav(id: Identity): Promise<Uint8Array> {
  return encodeWav(renderScore(await deriveStinger(id.did), { loop: false, sampleRate: 22050, tail: 0.6 }), { mono: true })
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Per-profile OpenGraph tags injected into the REAL app HTML.
 *
 *  No interstitial and no redirect: crawlers read the tags, humans get the app
 *  straight away. Both `/u/<handle>` and `/?u=<handle>` serve this, so every URL
 *  that names somebody unfurls as that somebody.
 *
 *  The identity stays in the QUERY STRING, never the path: pfp/src/oauth.ts
 *  builds the broker's `return_to` from `location.pathname`, and that allowlist
 *  is compiled into the Rust broker (docs/DEPLOYMENT.md). A path-based URL would
 *  silently break one-tap avatar writes.
 */
export async function appPageWithOg(
  id: Identity, origin: string, indexHtml: string, opts: { basePath?: string } = {},
): Promise<string> {
  const canEncode = (await ffmpeg()) !== null
  const minted = await mintChiptune(id.did, 16)
  const c = Object.fromEntries(minted.card)
  const who = id.label
  const slug = encodeURIComponent(id.handle || id.did)
  const title = `${who} in FreeqWorld \u2726 ${c.key}, ${c.tempo}`
  const desc =
    `${who}'s character and their theme tune, both derived from their DID \u2014 ` +
    `${c.key}, ${c.tempo}, ${c.motif} on ${c.voice}, ${c.bass} bass, ${c.percussion}. ` +
    `Nothing uploaded: the sprite and the music are computed from the identity itself.`
  const card = `${origin}/card/${slug}.png`
  const clip = `${origin}/clip/${slug}.mp4`
  const wav = `${origin}/theme/${slug}.wav`

  // Discord / Telegram / Mastodon / iMessage play og:video inline, with sound.
  // Bluesky and X ignore it entirely and use the image, so both must be here.
  const video = canEncode
    ? `<meta property="og:video" content="${esc(clip)}" />
<meta property="og:video:secure_url" content="${esc(clip)}" />
<meta property="og:video:url" content="${esc(clip)}" />
<meta property="og:video:type" content="video/mp4" />
<meta property="og:video:width" content="${CLIP_W}" />
<meta property="og:video:height" content="${CLIP_H}" />`
    : ''

  const tags = `<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}" />
<link rel="canonical" href="${esc(origin)}/u/${esc(id.handle || id.did)}" />
<meta property="og:type" content="${canEncode ? 'video.other' : 'music.song'}" />
<meta property="og:site_name" content="FreeqWorld ID" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(desc)}" />
<meta property="og:url" content="${esc(origin)}/u/${esc(id.handle || id.did)}" />
<meta property="og:image" content="${esc(card)}" />
<meta property="og:image:type" content="image/png" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:image:alt" content="${esc(who)}'s pixel character and the first eight bars of their theme tune" />
${video}
<meta property="og:audio" content="${esc(wav)}" />
<meta property="og:audio:type" content="audio/wav" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${esc(title)}" />
<meta name="twitter:description" content="${esc(desc)}" />
<meta name="twitter:image" content="${esc(card)}" />`

  // There is ONE pfp build (base '/id/', for world.freeq.at) but two hosts serve
  // it: on pfp.freeq.at the app is at the root, so '/id/assets/...' 404s into the
  // SPA fallback and the browser refuses the HTML as a module script. Rewrite the
  // asset base to match wherever this page is actually being served from.
  const rebased = (opts.basePath ?? '/id/') === '/id/'
    ? indexHtml
    : indexHtml.replace(/(src|href)="\/id\//g, '$1="/')

  // strip the build's own title + og/twitter/description tags, then inject ours
  const stripped = rebased
    .replace(/<title>[\s\S]*?<\/title>/i, '')
    .replace(/[ \t]*<meta (property="og:[^"]*"|name="(twitter:[^"]*|description)")[^>]*>\n?/gi, '')
  return stripped.replace(/<\/head>/i, `${tags}\n</head>`)
}
