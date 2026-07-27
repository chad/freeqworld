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
import { completionsFromEvents, creditedXp, levelFor } from '../../shared/src/xp'
import type { CardStanding } from './card.ts'

const APPVIEW = 'https://public.api.bsky.app/xrpc'
/** the freeq server that holds the signed completion log */
const IRC_HTTP = process.env.FREEQ_HTTP ?? 'https://irc.freeq.at'

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

/** Standing for the card and the page, from the same public signed log the
 *  obelisk reads. A card that shows a level is a card worth posting. */
export async function standingFor(did: string): Promise<CardStanding | null> {
  try {
    const events: unknown[] = []
    for (const ch of ['#general', '#lobby', '#dev']) {
      const r = await fetch(
        `${IRC_HTTP}/api/v1/channels/${encodeURIComponent(ch)}/events?type=quest_complete&limit=500`,
        { signal: AbortSignal.timeout(5000) },
      )
      if (!r.ok) continue
      const body = (await r.json()) as { events?: unknown[] }
      events.push(...(body.events ?? []))
    }
    const completions = (await completionsFromEvents(events as never)).filter((c) => c.player === did)
    if (!completions.length) return null
    const xp = creditedXp(completions)
    const lv = levelFor(xp)
    return { level: lv.level, title: lv.title, xp, runs: completions.filter((c) => c.verified).length }
  } catch {
    return null
  }
}

export async function cardPng(id: Identity): Promise<Buffer> {
  const hit = cardCache.get(id.did)
  if (hit && Date.now() - hit.at < TTL) return hit.png
  const { png } = await renderCard(id.did, id.label.toUpperCase(), await standingFor(id.did))
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
  const standing = await standingFor(id.did)
  const title = standing
    ? `${who} in FreeqWorld \u2726 level ${standing.level} ${standing.title} \u00b7 ${c.key}, ${c.tempo}`
    : `${who} in FreeqWorld \u2726 ${c.key}, ${c.tempo}`
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

// --- "wear your derived face" ------------------------------------------------
//
// The one external quest that needs NO oracle. An AT Proto avatar is addressed
// by the hash of its bytes inside a record signed by that person's repo key, and
// our portrait is a pure function of their DID — so we recompute the image,
// compute its CID, and compare. Nobody's word is involved, and anyone can repeat
// the check with this code.

import { renderFace, type FaceVariant } from './face.ts'

const faceCache = new Map<string, { png: Buffer; cid: string; at: number }>()

export async function facePng(did: string, variant: FaceVariant): Promise<{ png: Buffer; cid: string }> {
  const key = `${did}:${variant}`
  const hit = faceCache.get(key)
  if (hit && Date.now() - hit.at < 6 * 3600_000) return { png: hit.png, cid: hit.cid }
  const f = await renderFace(did, variant)
  faceCache.set(key, { png: f.png, cid: f.cid, at: Date.now() })
  if (faceCache.size > 300) faceCache.delete(faceCache.keys().next().value!)
  return { png: f.png, cid: f.cid }
}

export interface FaceCheck {
  did: string
  handle: string
  /** the CID their signed profile record points at, if any */
  avatar_cid: string | null
  /** what each variant of their derived portrait hashes to */
  expected: Record<FaceVariant, string>
  /** which variant they are wearing, or null */
  wearing: FaceVariant | null
  /** bytes of what they are actually wearing, for diagnosing a mismatch */
  avatar_size: number | null
  /** where the record was read from */
  source: string
  /** how to reproduce this result yourself */
  proof: string
}

/** Is this identity wearing the face its DID derives? */
export async function checkFace(id: Identity): Promise<FaceCheck> {
  let avatarCid: string | null = null
  let avatarSize: number | null = null
  let source = APPVIEW
  try {
    // the PDS they chose is authoritative and never lags behind a change they
    // just made; the AppView is only a fallback
    try {
      const doc = (await (await fetch(`https://plc.directory/${encodeURIComponent(id.did)}`,
        { signal: AbortSignal.timeout(5000) })).json()) as { service?: { id?: string; serviceEndpoint?: string }[] }
      const ep = doc.service?.find((x) => x.id?.endsWith('#atproto_pds'))?.serviceEndpoint
      if (ep) source = `${String(ep).replace(/\/$/, '')}/xrpc`
    } catch {
      /* keep the AppView */
    }
    const r = await fetch(
      `${source}/com.atproto.repo.getRecord?repo=${encodeURIComponent(id.did)}` +
        `&collection=app.bsky.actor.profile&rkey=self`,
      { signal: AbortSignal.timeout(6000) },
    )
    if (r.ok) {
      const body = (await r.json()) as { value?: { avatar?: { ref?: { $link?: string }; size?: number } } }
      avatarCid = body.value?.avatar?.ref?.$link ?? null
      avatarSize = body.value?.avatar?.size ?? null
    }
  } catch {
    /* unreachable: report unknown rather than guessing */
  }
  const variants: FaceVariant[] = ['explorer', 'portrait']
  const expected = {} as Record<FaceVariant, string>
  for (const v of variants) expected[v] = (await facePng(id.did, v)).cid
  const wearing = variants.find((v) => expected[v] === avatarCid) ?? null
  return {
    did: id.did,
    handle: id.handle,
    avatar_cid: avatarCid,
    avatar_size: avatarSize,
    source,
    expected,
    wearing,
    proof:
      'the avatar blob is addressed by the hash of its bytes inside a record signed by that repo; ' +
      'render the portrait from the DID, hash it, compare (shared/src/cid.ts)',
  }
}

// --- an invitation that unfurls ---------------------------------------------
//
// The link a host hands out is the thing that actually travels, so it should
// arrive as "X invited you", with X's character on it — not as a generic site
// card. The token is verified before we put anybody's name on it: it carries
// the witness DID, and a did:key holds its own public key, so a forged token
// cannot borrow someone's identity for an unfurl.

import { checkInvite, decodeInvite } from '../../shared/src/invite'
import { publicKeyFromDid } from '../../shared/src/signing'

export interface InviteView {
  host: Identity
  token: string
}

/** Verify the signature (not the redeemer rules — nobody has redeemed yet). */
export async function inviteView(token: string): Promise<InviteView | null> {
  const parsed = decodeInvite(token)
  if (!parsed) return null
  try {
    publicKeyFromDid(parsed.payload.witness)
  } catch {
    return null
  }
  // checkInvite with an empty redeemer still runs the signature + expiry checks
  const res = checkInvite(token, '', {})
  if (res.reason === 'malformed' || res.reason === 'bad-signature' || res.reason === 'expired') return null
  try {
    return { host: await resolveIdentity(parsed.payload.inviter), token }
  } catch {
    return null
  }
}

export async function invitePage(view: InviteView, origin: string, worldOrigin: string): Promise<string> {
  const who = view.host.label
  const card = `${origin}/card/${encodeURIComponent(view.host.handle || view.host.did)}.png`
  const enter = `${worldOrigin}/?invite=${encodeURIComponent(view.token)}`
  const title = `${who} invited you into FreeqWorld`
  const desc =
    `A federated chat network rendered as a 1992 RPG. Your character and your theme tune are ` +
    `computed from your identity — nothing is uploaded, and nothing is stored. ` +
    `Arrive, say hello, and ${who} is credited for bringing you.`
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="FreeqWorld" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(desc)}" />
<meta property="og:url" content="${esc(origin)}/i/${encodeURIComponent(view.token)}" />
<meta property="og:image" content="${esc(card)}" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${esc(title)}" />
<meta name="twitter:description" content="${esc(desc)}" />
<meta name="theme-color" content="#0d0d14" />
<script>location.replace(${JSON.stringify(enter)})</script>
<style>
 html,body{margin:0;height:100%;background:#0d0d14;color:#d8d6c8;font-family:ui-monospace,Menlo,monospace;
   display:flex;align-items:center;justify-content:center;text-align:center}
 a{color:#ffb454} img{max-width:min(680px,92vw);border-radius:12px;border:1px solid #2c2c40}
 p{color:#8a8896;font-size:.9rem}
</style>
</head><body><div>
  <img src="${esc(card)}" alt="${esc(who)}'s character" />
  <p>${esc(title)} — <a href="${esc(enter)}">come in</a></p>
</div></body></html>`
}
