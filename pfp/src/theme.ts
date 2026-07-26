// The other half of a FreeqWorld identity: the tune.
//
// Same input as the face (the DID), same discipline (HKDF → traits → output,
// nothing uploaded, nothing inferred from profile data). The face comes from
// `avatar-v1`; the music comes from `chiptune-v1` + the `motif-v1` leitmotif
// (spec §11.5, canonical derivation in shared/src/leitmotif.ts). Everything is
// generated in the browser — no audio files.

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
let onChange: (playing: boolean) => void = () => {}

export function onPlayStateChange(fn: (playing: boolean) => void): void {
  onChange = fn
}

export function isPlaying(): boolean {
  return playing
}

export function currentTheme(): Minted | null {
  return minted
}

/** Beat position for the animated stage. Before the visitor presses play the
 *  clock free-runs at the tune's tempo, so the character is never frozen. */
export function themeClock(): { beats: number; playing: boolean } {
  const pos = playing ? player?.position : null
  if (pos) return { beats: pos.beats, playing: true }
  const bpm = minted?.theme.bpm ?? 108
  return { beats: (performance.now() / 1000) * (bpm / 60), playing: false }
}

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

function paintState(state: 'idle' | 'working' | 'playing'): void {
  const label = state === 'working' ? 'composing…' : state === 'playing' ? '❚❚ pause' : '▶ play my theme'
  for (const id of ['hear', 'stage-play']) {
    const b = document.getElementById(id) as HTMLButtonElement | null
    if (!b) continue
    b.disabled = state === 'working'
    b.classList.toggle('playing', state === 'playing')
  }
  $('hear').textContent = label
  $('stage-play').textContent = state === 'playing' ? '❚❚' : '▶'
  $('stage-play').classList.toggle('hidden', state === 'playing')
  $('nowplaying').classList.toggle('on', state === 'playing')
  onChange(state === 'playing')
}

/** Phones get a 16-bar loop instead of 32: same key, same motif, same melody
 *  — it just comes round sooner. Halves the render time and the memory, which
 *  on iOS is the difference between music and a killed tab. */
function loopBars(): number {
  const small = typeof matchMedia === 'function' && matchMedia('(max-width: 820px)').matches
  return small ? 16 : 32
}

/** Called whenever the revealed identity changes. Mints (cheap) but makes no
 *  sound until asked. */
export async function revealTheme(did: string): Promise<void> {
  if (mintedDid === did) return // variant switch — leave the music playing
  stopTheme()
  mintedDid = did
  minted = await mintChiptune(did, loopBars())
  $('theme-traits').innerHTML = chips(minted)
  $('theme-name').textContent = minted.theme.name
  $('theme').classList.remove('hidden')
  paintState('idle')
}

export function stopTheme(): void {
  if (playing) {
    player?.stop()
    playing = false
  }
  paintState('idle')
}

export async function toggleTheme(): Promise<void> {
  if (!minted) return
  if (playing) {
    stopTheme()
    return
  }
  // ---- everything up to the first await must stay inside the gesture ----
  player ??= new ChiptunePlayer()
  player.unlock()
  // ----------------------------------------------------------------------
  paintState('working')
  // now yield, so the button repaints before the (synchronous) render
  await new Promise((r) => requestAnimationFrame(() => r(null)))
  try {
    player.play(minted.theme, { fade: 0.35 })
    playing = true
    paintState('playing')
    // Safari can still refuse (ring/silent switch on an iPhone, or a context
    // that never left 'suspended'). Say so instead of pretending to play.
    setTimeout(() => {
      if (playing && !player?.running) onSilent()
    }, 400)
  } catch {
    paintState('idle')
  }
}

let onSilent: () => void = () => {}
export function onSilentPlayback(fn: () => void): void {
  onSilent = fn
}

/** Just the 3–5 note calling card — what plays when you walk into a room. */
export async function playStinger(): Promise<void> {
  if (!mintedDid) return
  player ??= new ChiptunePlayer()
  player.unlock() // sync, still inside the click
  player.oneShotScore(await mintStinger(mintedDid))
}

export function downloadTheme(label: string): void {
  if (!minted) return
  const wav = encodeWav(renderScore(compose(minted.theme), { loop: true }))
  // handles make good filenames; "a fresh did:key identity" does not
  const handle = label.replace(/^@/, '').trim()
  const name = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(handle) ? handle : minted.seedHex.slice(0, 8)
  const url = URL.createObjectURL(new Blob([wav.buffer as ArrayBuffer], { type: 'audio/wav' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `freeqworld-theme-${name}.wav`
  a.click()
  URL.revokeObjectURL(url)
}

// A tiny diagnostic for real-device reports ("it's silent on my phone"): open
// the console and read `freeqAudio`. Costs nothing, saves a lot of guessing.
// (Guarded — this module is also imported by the node test environment.)
if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).freeqAudio = {
    get state(): string {
      return player ? player.ctx.state : 'no-context-yet'
    },
    get running(): boolean {
      return player?.running ?? false
    },
    get sampleRate(): number {
      return player?.ctx.sampleRate ?? 0
    },
    get bars(): number {
      return minted?.theme.bars ?? 0
    },
    get position(): unknown {
      return player?.position ?? null
    },
    get tune(): unknown {
      return minted?.card ?? null
    },
  }
}
