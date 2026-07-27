/// <reference types="vite/client" />
// FreeqWorld ID — see the deterministic pixel character your identity derives
// into, and (soon) set it as your Bluesky avatar. Reveal-only milestone: handle
// or "surprise me" → PFP preview + PNG download. No login required.

import { generateKeypair, didFromPublicKey } from '../../shared/src/signing'
import { deriveAvatar } from '../../shared/src/avatar'
import { renderPfp, traitSummary, type Variant } from './render'
import { login, uploadBlob, setAvatar, postAboutIt } from './atproto'
import { bytesToBase64, canonicalFace } from './canonical'
import { checkable, describe, faceState, forget } from './verify'
import {
  revealTheme, toggleTheme, playStinger, downloadScore,
  downloadTheme, stopTheme, themeClock, onPlayStateChange,
  onSilentPlayback,
} from './theme'
import { Stage } from './stage'
import { startPfpOAuth, consumePfpOAuthReturn, setAvatarViaBroker, type PfpOAuthReturn } from './oauth'

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

/** '/' on pfp.freeq.at, '/id/' under world.freeq.at — vite bakes it in. */
const APP_BASE = import.meta.env.BASE_URL

let currentDid: string | null = null
let currentLabel = ''
/** which still is exported / shown when not on the live view */
let variant: Variant = 'explorer'
/** the default view: the character moving, in time with their own theme */
let view: 'live' | Variant = 'live'
/** true when a shared link put someone else's identity on screen */
let viewingShared = false

const stage = new Stage($<HTMLCanvasElement>('pfp'))
stage.setClock(themeClock)

async function resolveHandle(handle: string): Promise<string> {
  const clean = handle.trim().replace(/^@/, '')
  const res = await fetch(
    `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(clean)}`,
  )
  if (!res.ok) throw new Error(`couldn't resolve @${clean} — is that a real Bluesky handle?`)
  const body = (await res.json()) as { did: string }
  return body.did
}

function short(did: string): string {
  return did.length > 30 ? `${did.slice(0, 20)}…${did.slice(-6)}` : did
}

async function paint(): Promise<void> {
  if (!currentDid) return
  const avatar = await deriveAvatar(currentDid)
  if (view === 'live') {
    // the animated stage owns the canvas
    await stage.show(currentDid)
    stage.start()
  } else {
    stage.stop()
    const { canvas } = await renderPfp(currentDid, variant, 512)
    const target = $<HTMLCanvasElement>('pfp')
    const ctx = target.getContext('2d')!
    ctx.imageSmoothingEnabled = false
    ctx.clearRect(0, 0, target.width, target.height)
    ctx.drawImage(canvas, 0, 0, target.width, target.height)
  }
  $('livebadge').classList.toggle('hidden', view !== 'live')

  $('did').textContent = short(currentDid)
  $('did').title = currentDid
  rememberInUrl()
  // the same DID also derives a theme tune (silent until asked)
  void revealTheme(currentDid)
  // ...and we can tell them where they stand without them having to ask
  void paintFaceState(currentDid)
  $('label').textContent = currentLabel
  $('traits').innerHTML = traitSummary(avatar)
    .map(([k, v]) => `<span class="trait"><b>${k}</b> ${v}</span>`)
    .join('')
  $('result').classList.remove('hidden')
}

async function generateFromHandle(): Promise<void> {
  const handle = $<HTMLInputElement>('handle').value.trim()
  if (!handle) return
  setBusy(true)
  viewingShared = false
  $('viewing').classList.add('hidden')
  $('shared').classList.add('hidden')
  try {
    currentDid = await resolveHandle(handle)
    currentLabel = `@${handle.replace(/^@/, '')}`
    await paint()
  } catch (e) {
    toast(String((e as Error).message ?? e))
  } finally {
    setBusy(false)
  }
}

/** Keep the address bar pointing at whoever is on screen, so copying the URL
 *  out of the browser gives a link that unfurls as THIS character (the server
 *  serves per-profile OpenGraph tags for `?u=` as well as `/u/`). */
function rememberInUrl(): void {
  if (!currentDid) return
  const who = currentLabel.startsWith('@') ? currentLabel.slice(1) : currentDid
  // The identity lives in the QUERY, never the path: oauth.ts derives the
  // broker's return_to from location.pathname and that allowlist is compiled
  // into the broker, so a path-based URL would break one-tap avatar writes.
  const next = `${APP_BASE}?u=${encodeURIComponent(who)}`
  if (location.pathname + location.search !== next) history.replaceState(null, '', next)
}

/** The canonical share URL for whoever is on screen. Same origin as the app, so
 *  it works on pfp.freeq.at and at world.freeq.at/id alike. */
function shareUrl(): string {
  const who = currentLabel.startsWith('@') ? currentLabel.slice(1) : currentDid ?? ''
  return `${location.origin}${APP_BASE}u/${encodeURIComponent(who)}`
}

function openShare(): void {
  if (!currentDid) return
  const url = shareUrl()
  $<HTMLInputElement>('sharelink').value = url
  const mine = !viewingShared && currentLabel.startsWith('@')
  const text = mine
    ? `my FreeqWorld character — and the chiptune my DID composes ✦`
    : viewingShared
      ? `${currentLabel}'s FreeqWorld character — and the chiptune their DID composes ✦`
      : `a FreeqWorld character and its chiptune, derived from a DID ✦`
  $<HTMLAnchorElement>('sharepost').href =
    `https://bsky.app/intent/compose?text=${encodeURIComponent(`${text}\n\n${url}`)}`
  $('shared').classList.remove('hidden')
  $<HTMLInputElement>('sharelink').select()
}

async function copyShareLink(): Promise<void> {
  const input = $<HTMLInputElement>('sharelink')
  try {
    await navigator.clipboard.writeText(input.value)
    $('sharecopy').textContent = 'copied'
  } catch {
    input.select() // clipboard blocked: at least it's selected
    $('sharecopy').textContent = 'select + copy'
  }
  setTimeout(() => ($('sharecopy').textContent = 'copy'), 2000)
}

/** Someone opened a shared link: show that person, and say whose it is. */
async function showSharedIdentity(who: string): Promise<void> {
  setBusy(true)
  try {
    const isDid = who.startsWith('did:')
    currentDid = isDid ? who : await resolveHandle(who)
    currentLabel = isDid ? 'a shared identity' : `@${who.replace(/^@/, '')}`
    viewingShared = true
    $('viewing-who').textContent = currentLabel
    $('viewing').classList.remove('hidden')
    $<HTMLInputElement>('handle').value = isDid ? '' : who.replace(/^@/, '')
    await paint()
  } catch (e) {
    toast(String((e as Error).message ?? e))
  } finally {
    setBusy(false)
  }
}

function setView(v: 'live' | Variant): void {
  view = v
  if (v !== 'live') variant = v
  for (const id of ['live', 'portrait', 'explorer']) {
    $(`v-${id}`).classList.toggle('active', id === v)
  }
  void paint()
}

/** Beat dots + "now playing" line, driven by the same clock as the stage. */
function runBeatIndicator(): void {
  const dots = [...document.querySelectorAll<HTMLElement>('#beats i')]
  const tick = () => {
    const { beats, playing } = themeClock()
    const active = playing ? Math.floor(beats) % 4 : -1
    dots.forEach((d, i) => d.classList.toggle('on', i === active))
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

async function surpriseMe(): Promise<void> {
  stopTheme() // a new identity gets a new tune
  viewingShared = false
  $('viewing').classList.add('hidden')
  const kp = generateKeypair()
  currentDid = didFromPublicKey(kp.publicKey)
  currentLabel = 'a fresh did:key identity'
  await paint()
}


/** Say whether this identity already wears its derived face. Runs after the
 *  reveal, never blocks it, and stays quiet for a guest did:key (which has no
 *  Bluesky profile to check). */
async function paintFaceState(did: string, refresh = false): Promise<void> {
  const el = $('facestate')
  if (!checkable(did)) {
    el.classList.add('hidden')
    return
  }
  const state = await faceState(did, refresh)
  if (!state || currentDid !== did) return
  const { text, verified } = describe(state)
  el.textContent = text
  el.style.color = verified ? 'var(--green)' : 'var(--dim)'
  el.classList.remove('hidden')
}

async function download(): Promise<void> {
  if (!currentDid) return
  // the same canonical bytes we would upload, so what you download is the exact
  // artifact that can be verified against your DID
  const face = await canonicalFace(currentDid, variant)
  const url = URL.createObjectURL(new Blob([face.bytes as unknown as BlobPart], { type: 'image/png' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `freeqworld-pfp-${variant}.png`
  a.click()
  URL.revokeObjectURL(url)
}

function setBusy(b: boolean): void {
  $<HTMLButtonElement>('go').disabled = b
  $('go').textContent = b ? 'summoning…' : 'see my character'
}

function toast(msg: string): void {
  const el = document.createElement('div')
  el.className = 'toast'
  el.textContent = msg
  document.body.appendChild(el)
  setTimeout(() => el.remove(), 3600)
}

function bind(): void {
  $('go').addEventListener('click', () => void generateFromHandle())
  $<HTMLInputElement>('handle').addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') void generateFromHandle()
  })
  $('surprise').addEventListener('click', (e) => {
    e.preventDefault()
    void surpriseMe()
  })
  $('download').addEventListener('click', () => void download())
  $('hear').addEventListener('click', () => void toggleTheme())
  $('theme-sting').addEventListener('click', (e) => {
    e.preventDefault()
    void playStinger()
  })
  $('theme-dl').addEventListener('click', (e) => {
    e.preventDefault()
    downloadTheme(currentLabel)
  })
  $('theme-midi').addEventListener('click', (e) => {
    e.preventDefault()
    downloadScore(currentLabel, 'midi')
  })
  $('theme-xml').addEventListener('click', (e) => {
    e.preventDefault()
    downloadScore(currentLabel, 'musicxml')
  })
  // three views: the live animated character (default), and the two stills
  // that get exported / uploaded
  for (const v of ['live', 'portrait', 'explorer'] as const) {
    $(`v-${v}`).addEventListener('click', () => setView(v))
  }
  // the canvas itself is the play button on the live view
  $('pfp').addEventListener('click', () => {
    if (view === 'live') void toggleTheme()
    else setView('live')
  })
  $('stage-play').addEventListener('click', (e) => {
    e.stopPropagation()
    void toggleTheme()
  })
  // looking at someone else's? the point is that YOURS exists too
  $('seemine').addEventListener('click', () => {
    const input = $<HTMLInputElement>('handle')
    input.value = ''
    input.focus()
    input.scrollIntoView({ behavior: 'smooth', block: 'center' })
    input.style.borderColor = 'var(--amber)'
    window.setTimeout(() => (input.style.borderColor = ''), 1800)
    toast('type your Bluesky handle — your character is already derived, you just have not seen it')
  })
  $('enterworld').addEventListener('click', () => {
    // carry the handle across so the world can skip straight to sign-in
    const handle = currentLabel.startsWith('@') ? currentLabel.slice(1) : ''
    const url = handle
      ? `https://world.freeq.at/?h=${encodeURIComponent(handle)}`
      : 'https://world.freeq.at/'
    window.open(url, '_blank', 'noopener')
  })
  $('share').addEventListener('click', openShare)
  $('sharecopy').addEventListener('click', () => void copyShareLink())
  $('setbsky').addEventListener('click', openConnect)
  $('c-cancel').addEventListener('click', () => $('connect').classList.add('hidden'))
  $('c-go').addEventListener('click', () => void doConnect())
  $('c-oauth').addEventListener('click', () => {
    const handle = $<HTMLInputElement>('c-handle').value.trim()
    if (!handle) { $('c-err').textContent = 'enter your handle first'; return }
    startPfpOAuth(handle, variant, $<HTMLInputElement>('c-post').checked)
  })
  $<HTMLInputElement>('c-pass').addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') void doConnect()
  })
  $('done-close').addEventListener('click', () => $('done').classList.add('hidden'))
}

function showDone(handle: string, posted: boolean): void {
  // the avatar just changed: re-read the record rather than trusting our memory
  if (currentDid) {
    forget(currentDid)
    window.setTimeout(() => void paintFaceState(currentDid!, true), 1500)
  }
  $('connect').classList.add('hidden')
  const prof = $<HTMLAnchorElement>('done-profile')
  prof.href = `https://bsky.app/profile/${handle}`
  $('done-msg').textContent = posted
    ? `@${handle} is now your FreeqWorld self — and you posted about it.`
    : `@${handle}'s avatar is now your FreeqWorld self.`
  $('done').classList.remove('hidden')
}

// Returning from the broker OAuth redirect: the broker holds the token and does
// the write; we render the (deterministic) PFP for the verified DID and hand it
// over.
async function completeOAuth(ret: PfpOAuthReturn): Promise<void> {
  currentDid = ret.did
  currentLabel = `@${ret.handle}`
  // keep the visitor on the live view; `variant` is only what gets uploaded
  variant = ret.variant
  await paint()
  $('connect').classList.remove('hidden')
  $<HTMLButtonElement>('c-oauth').disabled = true
  $<HTMLButtonElement>('c-go').disabled = true
  $('c-err').textContent = ''
  $('c-status').textContent = 'setting your avatar…'
  try {
    // the canonical bytes, so the result is verifiable by anyone (see canonical.ts)
    const face = await canonicalFace(ret.did, variant)
    const { handle, posted } = await setAvatarViaBroker(ret.brokerToken, bytesToBase64(face.bytes), ret.post)
    showDone(handle || ret.handle, posted)
  } catch (e) {
    $('c-status').textContent = ''
    $('c-err').textContent = String((e as Error).message ?? e)
    $<HTMLButtonElement>('c-oauth').disabled = false
    $<HTMLButtonElement>('c-go').disabled = false
  }
}

function openConnect(): void {
  const guess = $<HTMLInputElement>('handle').value.trim() || currentLabel.replace(/^@/, '')
  if (guess && !guess.includes(' ') && guess.includes('.')) $<HTMLInputElement>('c-handle').value = guess
  $('c-err').textContent = ''
  $('c-status').textContent = ''
  $<HTMLButtonElement>('c-go').disabled = false
  $('connect').classList.remove('hidden')
  $<HTMLInputElement>('c-handle').value ? $('c-pass').focus() : $('c-handle').focus()
}

async function doConnect(): Promise<void> {
  const handle = $<HTMLInputElement>('c-handle').value.trim()
  const pass = $<HTMLInputElement>('c-pass').value
  const alsoPost = $<HTMLInputElement>('c-post').checked
  const err = $('c-err')
  const status = $('c-status')
  err.textContent = ''
  if (!handle || !pass) {
    err.textContent = 'handle and app password are both required'
    return
  }
  $<HTMLButtonElement>('c-go').disabled = true
  try {
    status.textContent = 'signing in…'
    const session = await login(handle, pass)
    // the avatar is derived from the AUTHENTICATED DID — truly their identity
    currentDid = session.did
    currentLabel = `@${session.handle}`
    await paint()

    status.textContent = 'fetching your canonical portrait…'
    const face = await canonicalFace(session.did, variant)
    const bytes = face.bytes

    status.textContent = 'uploading…'
    const avatarBlob = await uploadBlob(session, bytes, 'image/png')
    status.textContent = 'setting your avatar…'
    await setAvatar(session, avatarBlob)

    if (alsoPost) {
      status.textContent = 'posting…'
      const postBlob = await uploadBlob(session, bytes, 'image/png')
      await postAboutIt(session, postBlob)
    }

    // never keep the password around
    $<HTMLInputElement>('c-pass').value = ''
    $('connect').classList.add('hidden')
    const prof = $<HTMLAnchorElement>('done-profile')
    prof.href = `https://bsky.app/profile/${session.handle}`
    $('done-msg').textContent = alsoPost
      ? `@${session.handle} is now your FreeqWorld self — and you posted about it.`
      : `@${session.handle}'s avatar is now your FreeqWorld self.`
    $('done').classList.remove('hidden')
  } catch (e) {
    err.textContent = String((e as Error).message ?? e)
    status.textContent = ''
    $<HTMLButtonElement>('c-go').disabled = false
  }
}

bind()
runBeatIndicator()
onSilentPlayback(() => {
  // iPhones live on silent, and Web Audio obeys the switch on older Safari
  $('nowplaying-text').innerHTML =
    "no sound? on iPhone, flick the <b>ring/silent switch</b> — or turn the volume up"
  $('nowplaying').classList.add('on')
})
onPlayStateChange((on) => {
  $('nowplaying-text').textContent = on
    ? 'now playing — your character moves to it'
    : 'your theme, composed from your DID'
  if (on && view !== 'live') setView('live') // the music deserves the animation
})

// Handle a broker OAuth return on load (one-tap completion).
const oauthReturn = consumePfpOAuthReturn()
if (oauthReturn) void completeOAuth(oauthReturn)

// ?u=<handle|did> — someone followed a shared link. The share page redirects
// here so the visitor lands on a playable character rather than a static card.
const fromPath = new RegExp(`^${APP_BASE}u/(.+)$`).exec(location.pathname)?.[1]
const shared = new URLSearchParams(location.search).get('u') ?? (fromPath ? decodeURIComponent(fromPath) : null)
if (!oauthReturn && shared) void showSharedIdentity(shared)
