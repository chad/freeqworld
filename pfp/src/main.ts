// FreeqWorld ID — see the deterministic pixel character your identity derives
// into, and (soon) set it as your Bluesky avatar. Reveal-only milestone: handle
// or "surprise me" → PFP preview + PNG download. No login required.

import { generateKeypair, didFromPublicKey } from '../../shared/src/signing'
import { deriveAvatar } from '../../shared/src/avatar'
import { renderPfp, traitSummary, canvasToPngBlob, canvasToPngBase64, type Variant } from './render'
import { login, uploadBlob, setAvatar, postAboutIt } from './atproto'
import {
  revealTheme, toggleTheme, playStinger, downloadTheme, stopTheme, themeClock, onPlayStateChange,
} from './theme'
import { Stage } from './stage'
import { startPfpOAuth, consumePfpOAuthReturn, setAvatarViaBroker, type PfpOAuthReturn } from './oauth'

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

let currentDid: string | null = null
let currentLabel = ''
/** which still is exported / shown when not on the live view */
let variant: Variant = 'explorer'
/** the default view: the character moving, in time with their own theme */
let view: 'live' | Variant = 'live'

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
  // the same DID also derives a theme tune (silent until asked)
  void revealTheme(currentDid)
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
  const kp = generateKeypair()
  currentDid = didFromPublicKey(kp.publicKey)
  currentLabel = 'a fresh did:key identity'
  await paint()
}

async function download(): Promise<void> {
  if (!currentDid) return
  const { canvas } = await renderPfp(currentDid, variant, 1024)
  const blob = await canvasToPngBlob(canvas)
  const url = URL.createObjectURL(blob)
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
    const { canvas } = await renderPfp(ret.did, variant, 512)
    const b64 = await canvasToPngBase64(canvas)
    const { handle, posted } = await setAvatarViaBroker(ret.brokerToken, b64, ret.post)
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

    status.textContent = 'rendering your character…'
    const { canvas } = await renderPfp(session.did, variant, 512)
    const bytes = new Uint8Array(await (await canvasToPngBlob(canvas)).arrayBuffer())

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
onPlayStateChange((on) => {
  $('nowplaying-text').textContent = on
    ? 'now playing — your character moves to it'
    : 'your theme, composed from your DID'
  if (on && view !== 'live') setView('live') // the music deserves the animation
})

// Handle a broker OAuth return on load (one-tap completion).
const oauthReturn = consumePfpOAuthReturn()
if (oauthReturn) void completeOAuth(oauthReturn)
