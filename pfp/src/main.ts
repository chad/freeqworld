// FreeqWorld ID — see the deterministic pixel character your identity derives
// into, and (soon) set it as your Bluesky avatar. Reveal-only milestone: handle
// or "surprise me" → PFP preview + PNG download. No login required.

import { generateKeypair, didFromPublicKey } from '../../shared/src/signing'
import { renderPfp, traitSummary, canvasToPngBlob, type Variant } from './render'
import { login, uploadBlob, setAvatar, postAboutIt } from './atproto'

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

let currentDid: string | null = null
let currentLabel = ''
let variant: Variant = 'explorer'

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
  const { avatar, canvas } = await renderPfp(currentDid, variant, 512)
  const target = $<HTMLCanvasElement>('pfp')
  const ctx = target.getContext('2d')!
  ctx.imageSmoothingEnabled = false
  ctx.clearRect(0, 0, target.width, target.height)
  ctx.drawImage(canvas, 0, 0, target.width, target.height)

  $('did').textContent = short(currentDid)
  $('did').title = currentDid
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

async function surpriseMe(): Promise<void> {
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
  for (const v of ['portrait', 'explorer'] as Variant[]) {
    $(`v-${v}`).addEventListener('click', () => {
      variant = v
      $('v-portrait').classList.toggle('active', v === 'portrait')
      $('v-explorer').classList.toggle('active', v === 'explorer')
      void paint()
    })
  }
  $('setbsky').addEventListener('click', openConnect)
  $('c-cancel').addEventListener('click', () => $('connect').classList.add('hidden'))
  $('c-go').addEventListener('click', () => void doConnect())
  $<HTMLInputElement>('c-pass').addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') void doConnect()
  })
  $('done-close').addEventListener('click', () => $('done').classList.add('hidden'))
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
    const { canvas } = await renderPfp(session.did, variant, 1000)
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
