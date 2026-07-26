// The other half of a FreeqWorld identity: the tune.
//
// Same input as the face (the DID), same discipline (HKDF → traits → output,
// nothing uploaded, nothing inferred from profile data). The face comes from
// `avatar-v1`; the music comes from `chiptune-v1` + the `motif-v1` leitmotif
// (spec §11.5). Everything below is generated in the browser — no audio files.

import { compose } from '../../music/src/compose.ts'
import { mintChiptune, mintStinger, type Minted } from '../../music/src/mint.ts'
import { renderScore } from '../../music/src/synth.ts'
import { ChiptunePlayer } from '../../music/src/web.ts'
import { encodeWav } from '../../music/src/wav.ts'

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

let player: ChiptunePlayer | null = null
let minted: Minted | null = null
let mintedDid: string | null = null
let playing = false
/** Once someone has asked for sound we may greet later reveals with a stinger. */
let soundWanted = false

/** The traits worth showing next to the face; the rest you hear. Mirrors
 *  render.ts's traitSummary so the two reveals read the same way. */
export function themeSummary(m: Minted): [string, string][] {
  const want = ['key', 'tempo', 'motif', 'voice', 'percussion']
  return m.card.filter(([k]) => want.includes(k))
}

function chips(m: Minted): string {
  return themeSummary(m)
    .map(([k, v]) => `<span class="trait"><b>${k}</b> ${v}</span>`)
    .join('')
}

function setButton(state: 'idle' | 'working' | 'playing'): void {
  const b = $<HTMLButtonElement>('hear')
  b.disabled = state === 'working'
  b.textContent =
    state === 'working' ? 'composing…' : state === 'playing' ? '■ stop theme' : '▶ hear your theme'
  b.classList.toggle('active', state === 'playing')
}

/** Called whenever the revealed identity changes. Mints (cheap) but does not
 *  make a sound unless the visitor has already opted into audio. */
export async function revealTheme(did: string): Promise<void> {
  if (mintedDid === did) return // variant switch — leave the music playing
  stopTheme()
  mintedDid = did
  minted = await mintChiptune(did, 32)
  $('theme-traits').innerHTML = chips(minted)
  $('theme-name').textContent = minted.theme.name
  $('theme').classList.remove('hidden')
  setButton('idle')
  if (soundWanted) void playStinger()
}

export function stopTheme(): void {
  if (playing) {
    player?.stop()
    playing = false
  }
  setButton('idle')
}

export async function toggleTheme(): Promise<void> {
  if (!minted) return
  if (playing) {
    stopTheme()
    return
  }
  soundWanted = true
  setButton('working')
  // yield so the button repaints before the (synchronous) render
  await new Promise((r) => setTimeout(r, 16))
  try {
    player ??= new ChiptunePlayer()
    player.play(minted.theme, { fade: 0.35 })
    playing = true
    setButton('playing')
  } catch {
    setButton('idle')
  }
}

/** Just the 3–5 note calling card — what plays when you walk into a room. */
export async function playStinger(): Promise<void> {
  if (!mintedDid) return
  soundWanted = true
  player ??= new ChiptunePlayer()
  player.oneShotScore(await mintStinger(mintedDid))
}

export function downloadTheme(label: string): void {
  if (!minted) return
  const wav = encodeWav(renderScore(compose(minted.theme), { loop: true }))
  // handles make good filenames; "a fresh did:key identity" does not
  const handle = label.replace(/^@/, '').trim()
  const name = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(handle)
    ? handle
    : minted.seedHex.slice(0, 8)
  const url = URL.createObjectURL(new Blob([wav.buffer as ArrayBuffer], { type: 'audio/wav' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `freeqworld-theme-${name}.wav`
  a.click()
  URL.revokeObjectURL(url)
}
