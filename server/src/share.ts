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
import { renderScoreCard } from './scorecard.ts'
import { compose } from '../../music/src/compose.ts'
import { mintChiptune } from '../../music/src/mint.ts'
import { renderScore } from '../../music/src/synth.ts'
import { encodeWav } from '../../music/src/wav.ts'
import { encodeMidi } from '../../music/src/midi.ts'
import { encodeMusicXml } from '../../music/src/musicxml.ts'
import { noteToMidi, SCALES } from '../../music/src/theory.ts'
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
  const raw = decodeURIComponent(input).trim().replace(/^@/, '').replace(/\.(png|wav|json|mp4|mid|midi|musicxml|mxl)$/i, '')
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

/** The unfurl image for /score/<who>: the opening phrase, engraved. */
const scoreCardCache = new Map<string, { png: Uint8Array; at: number }>()
export async function scoreCardPng(id: Identity): Promise<Buffer> {
  const hit = scoreCardCache.get(id.did)
  if (hit && Date.now() - hit.at < TTL) return Buffer.from(hit.png)
  const png = await renderScoreCard(id.did, id.label)
  scoreCardCache.set(id.did, { png, at: Date.now() })
  if (scoreCardCache.size > 400) scoreCardCache.delete(scoreCardCache.keys().next().value!)
  return Buffer.from(png)
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

/** The theme as a portable score. A tune derived from a DID stops being
 *  something only this engine can play and becomes a file you can open in a DAW
 *  (MIDI) or engrave as sheet music (MusicXML). */
export async function themeScore(
  id: Identity, format: 'midi' | 'musicxml', bars = 16,
): Promise<{ body: Buffer; type: string; filename: string }> {
  const minted = await mintChiptune(id.did, bars)
  const score = compose(minted.theme)
  const tonicPc = noteToMidi(minted.theme.key) % 12
  const scale = SCALES[minted.theme.scale]
  const who = (id.handle || id.did).replace(/[^a-z0-9.]/gi, '_')
  const comment = `derived from ${id.did} — freeq chiptune-v1`
  if (format === 'midi') {
    return {
      body: Buffer.from(encodeMidi(score, { title: minted.theme.name, comment, tonicPc, scale })),
      type: 'audio/midi',
      filename: `freeqworld-${who}.mid`,
    }
  }
  return {
    body: Buffer.from(
      encodeMusicXml(score, {
        title: minted.theme.name, composer: id.handle || id.did, comment, tonicPc, scale,
      }),
      'utf8',
    ),
    type: 'application/vnd.recordare.musicxml+xml',
    filename: `freeqworld-${who}.musicxml`,
  }
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

/**
 * The score page: your theme as engraved sheet music, in the browser.
 *
 * A file that lands in ~/Downloads is a worse artefact than a page you can look
 * at and send to somebody. This renders the same MusicXML with
 * OpenSheetMusicDisplay (lazy — 313kB gzipped, and it must never enter the main
 * ID app bundle), on paper-white, with the downloads and the audio underneath.
 */
export async function scorePage(id: Identity, origin: string): Promise<string> {
  const minted = await mintChiptune(id.did, 16)
  const who = id.label
  const theme = minted.theme
  const xmlUrl = `${origin}/theme/${encodeURIComponent(id.handle || id.did)}.musicxml`
  const midiUrl = `${origin}/theme/${encodeURIComponent(id.handle || id.did)}.mid`
  const wavUrl = `${origin}/theme/${encodeURIComponent(id.handle || id.did)}.wav`
  const cardUrl = `${origin}/score/${encodeURIComponent(id.handle || id.did)}.png`
  const title = `${who}'s theme — ${theme.name}`
  const desc =
    `${theme.key} ${theme.scale}, ${theme.bpm} BPM. Composed from ${who}'s identity by HKDF — ` +
    `not chosen, not uploaded. Sheet music, MIDI and MusicXML, all recomputable from the DID.`
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}" />
<meta property="og:type" content="music.song" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(desc)}" />
<meta property="og:image" content="${esc(cardUrl)}" />
<meta property="og:audio" content="${esc(wavUrl)}" />
<meta name="twitter:card" content="summary_large_image" />
<link rel="alternate" type="application/vnd.recordare.musicxml+xml" href="${esc(xmlUrl)}" />
<style>
  :root { --bg:#0d0d14; --fg:#d8d6c8; --dim:#8a8896; --amber:#ffd166; --cyan:#56c9d6; --border:#2a2a38; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
         font:14px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; }
  header { max-width:1000px; margin:0 auto; padding:24px 20px 12px; }
  h1 { font-size:1.3rem; margin:0 0 4px; color:var(--amber); }
  .sub { color:var(--dim); font-size:.85rem; }
  .chips { display:flex; flex-wrap:wrap; gap:6px; margin:12px 0 0; }
  .chip { border:1px solid var(--border); border-radius:999px; padding:3px 10px; font-size:.78rem; }
  .chip b { color:var(--cyan); font-weight:600; }
  .bar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin:14px 0 0; }
  a.btn, button.btn { display:inline-block; padding:6px 12px; border-radius:6px; cursor:pointer;
        border:1px solid var(--border); background:#161620; color:var(--cyan);
        text-decoration:none; font:inherit; font-size:.82rem; }
  a.btn:hover, button.btn:hover { border-color:var(--cyan); }
  a.btn.primary { background:var(--amber); color:#1a1a22; border-color:var(--amber); font-weight:600; }
  /* the score itself sits on paper, because that is what it is */
  #paper { background:#fff; margin:18px auto 40px; max-width:1000px; border-radius:8px;
           padding:14px 8px 24px; min-height:220px; overflow-x:auto; }
  #status { color:var(--dim); text-align:center; padding:60px 20px; font-size:.85rem; }
  footer { max-width:1000px; margin:0 auto; padding:0 20px 40px; color:var(--dim); font-size:.78rem; line-height:1.6; }
  footer a { color:var(--cyan); }
</style>
</head><body>
<header>
  <h1>${esc(theme.name)}</h1>
  <div class="sub">${esc(who)}'s theme — derived from their identity, not chosen</div>
  <div class="chips">
    <span class="chip"><b>key</b> ${esc(theme.key)} ${esc(theme.scale)}</span>
    <span class="chip"><b>tempo</b> ${theme.bpm} BPM</span>
    <span class="chip"><b>meter</b> ${theme.meter[0]}/${theme.meter[1]}</span>
  </div>
  <div class="bar">
    <audio id="audio" src="${esc(wavUrl)}" preload="none"></audio>
    <button class="btn primary" id="play">▶ play</button>
    <a class="btn" href="${esc(xmlUrl)}" download>download musicxml</a>
    <a class="btn" href="${esc(midiUrl)}" download>download midi</a>
    <a class="btn" href="${esc(wavUrl)}" download>download wav</a>
    <a class="btn" href="${origin}/u/${encodeURIComponent(id.handle || id.did)}">the character →</a>
  </div>
</header>
<div id="paper"><div id="status">engraving…</div></div>
<footer>
  Engraved in your browser from MusicXML with
  <a href="https://opensheetmusicdisplay.org/" target="_blank" rel="noopener">OpenSheetMusicDisplay</a>.
  Every note here is a pure function of <code>${esc(id.did)}</code> — the same input always
  produces this same score. Open the MusicXML in MuseScore, Sibelius or Dorico, or the MIDI in any DAW.
</footer>
<script src="${origin}/osmd.js"></script>
<script>
  var play = document.getElementById('play'), audio = document.getElementById('audio');
  audio.loop = true;
  play.addEventListener('click', function () {
    if (audio.paused) { audio.play(); play.textContent = '■ stop'; }
    else { audio.pause(); audio.currentTime = 0; play.textContent = '▶ play'; }
  });
  // NB: not \`status\` — window.status is a legacy DOMString property, so
  // \`var status = <element>\` coerces the element to "[object HTMLDivElement]".
  // That silently broke the error path itself: .remove() threw, the catch ran,
  // and assigning .textContent to a primitive is a no-op, so the page sat on
  // "engraving…" forever with no console error.
  var statusEl = document.getElementById('status');
  function fail(msg) {
    console.error('[score]', msg);
    if (statusEl) statusEl.textContent = msg;
  }
  if (typeof opensheetmusicdisplay === 'undefined') {
    fail('the engraver did not load — the MusicXML download above still works.');
  } else {
    fetch(${JSON.stringify(xmlUrl)})
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
      .then(function (xml) {
        var osmd = new opensheetmusicdisplay.OpenSheetMusicDisplay('paper', {
          autoResize: true, drawTitle: false, drawPartNames: true, drawComposer: false,
        });
        return osmd.load(xml).then(function () {
          if (statusEl) statusEl.remove();
          osmd.render();
        });
      })
      .catch(function (e) { fail('could not engrave this score: ' + e.message + ' — the downloads above still work.'); });
  }
</script>
</body></html>`
}
