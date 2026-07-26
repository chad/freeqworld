// Chiptune studio: Bluesky handle -> DID -> minted tune, with A/B comparison
// and a feedback log you can copy straight back into a chat.

import { compose, type Theme } from '../src/compose.ts'
import { mintChiptune, mintStinger, type Minted } from '../src/mint.ts'
import { fetchProfile, resolveHandleToDid, type Profile } from '../src/handle.ts'
import { ChiptunePlayer } from '../src/web.ts'
import { renderScore } from '../src/synth.ts'
import { encodeWav } from '../src/wav.ts'
import { ticksPerBar, type Score } from '../src/score.ts'
import { midiToName } from '../src/theory.ts'

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T
const player = new ChiptunePlayer()

interface Entry {
  handle: string
  did: string
  profile?: Profile
  minted: Minted
  score: Score
  rating?: 'love' | 'ok' | 'meh'
  note?: string
}

const entries: Entry[] = []
let currentId = -1
let startedAt = 0
let loopSeconds = 0

const SUGGESTIONS = [
  'bsky.app', 'jay.bsky.team', 'pfrazee.com', 'why.bsky.team',
  'emilyliu.me', 'dholms.xyz', 'retr0.id', 'danabra.mov',
]

// ---------------------------------------------------------------- piano roll
const CH_COLOR: Record<string, string> = {
  pulse1: '#ffd166', pulse2: '#06d6a0', triangle: '#118ab2',
  noise: '#ef476f', dpcm: '#9b5de5', aux: '#33334d',
}

function drawRoll(score: Score, playhead = -1): void {
  const cv = $<HTMLCanvasElement>('#roll')
  const dpr = devicePixelRatio || 1
  const w = (cv.width = cv.clientWidth * dpr)
  const h = (cv.height = 190 * dpr)
  const ctx = cv.getContext('2d')!
  ctx.fillStyle = '#0b0b14'
  ctx.fillRect(0, 0, w, h)

  const bar = ticksPerBar(score.meter)
  for (let t = 0, i = 0; t < score.length; t += bar, i++) {
    ctx.fillStyle = i % 8 === 0 ? '#23233a' : '#16162a'
    ctx.fillRect((t / score.length) * w, 0, 1, h)
  }
  const lo = 26
  const hi = 92
  for (const n of score.notes) {
    const x = (n.t / score.length) * w
    const y = h - ((Math.max(lo, Math.min(hi, n.midi)) - lo) / (hi - lo)) * h
    ctx.fillStyle = CH_COLOR[n.ch] ?? '#fff'
    ctx.globalAlpha = n.ch === 'pulse1' ? 1 : 0.75
    ctx.fillRect(x, y - 1.5 * dpr, Math.max(1.5 * dpr, (n.dur / score.length) * w - dpr), 3 * dpr)
  }
  ctx.globalAlpha = 1
  if (playhead >= 0) {
    ctx.fillStyle = 'rgba(255,255,255,.75)'
    ctx.fillRect(playhead * w, 0, dpr, h)
  }
}

function tick(): void {
  const e = entries[currentId]
  if (e && loopSeconds > 0 && player.ctx.state === 'running') {
    const pos = ((player.ctx.currentTime - startedAt) % loopSeconds) / loopSeconds
    drawRoll(e.score, pos)
  }
  requestAnimationFrame(tick)
}
requestAnimationFrame(tick)

// ---------------------------------------------------------------- rendering
function show(e: Entry): void {
  $('#now').classList.remove('hidden')
  const img = $<HTMLImageElement>('#avatar')
  img.src = e.profile?.avatar ?? ''
  img.style.visibility = e.profile?.avatar ? 'visible' : 'hidden'
  $('#name').textContent = e.profile?.displayName ?? e.handle
  $('#hnd').textContent = e.profile?.handle ?? e.handle
  $('#did').textContent = e.did
  $('#seed').textContent = e.minted.seedHex.slice(0, 16) + '…'

  $('#card').innerHTML = e.minted.card
    .map(([k, v], i) => `<span class="chip${i < 2 ? ' hero' : ''}"><i>${k}</i>${v}</span>`)
    .join('')

  const lead = e.score.notes.filter((n) => n.ch === 'pulse1')
  const range = lead.length
    ? `${midiToName(Math.min(...lead.map((n) => n.midi)))}–${midiToName(Math.max(...lead.map((n) => n.midi)))}`
    : '—'
  $('#meta').textContent =
    `${e.score.notes.length} notes · ${(loopSeconds || 0).toFixed(1)}s loop · lead ${range}`
  drawRoll(e.score)
}

function playEntry(id: number): void {
  const e = entries[id]
  if (!e) return
  currentId = id
  loopSeconds = player.buffer(e.minted.theme).duration
  player.play(e.minted.theme, { fade: 0.25 })
  startedAt = player.ctx.currentTime + 0.25
  show(e)
  renderList()
}

// ---------------------------------------------------------------- the list
function renderList(): void {
  const tb = $('#list tbody')
  tb.innerHTML = ''
  entries.forEach((e, i) => {
    const tr = document.createElement('tr')
    if (i === currentId) tr.className = 'playing'
    const c = Object.fromEntries(e.minted.card)
    tr.innerHTML = `
      <td class="h">@${e.handle}</td>
      <td class="desc">${c.key} · ${c.tempo} · ${c.progression} · ${c.voice} · ${c.percussion}</td>
      <td class="rate">
        <button data-r="love" class="tiny${e.rating === 'love' ? ' on' : ''}" title="this one's great">★</button>
        <button data-r="ok"   class="tiny${e.rating === 'ok' ? ' on' : ''}"   title="fine">·</button>
        <button data-r="meh"  class="tiny${e.rating === 'meh' ? ' on' : ''}"  title="doesn't work">✗</button>
      </td>
      <td><input value="${(e.note ?? '').replace(/"/g, '&quot;')}" placeholder="what's wrong / right about it?" /></td>`
    tr.querySelector('td.h')!.addEventListener('click', () => playEntry(i))
    for (const b of tr.querySelectorAll<HTMLButtonElement>('.rate button')) {
      b.onclick = () => {
        e.rating = b.dataset.r as Entry['rating']
        save()
        renderList()
      }
    }
    const input = tr.querySelector('input')!
    input.oninput = () => {
      e.note = input.value
      save()
    }
    tb.append(tr)
  })
}

// -------------------------------------------------------------- persistence
const KEY = 'freeq-chiptune-feedback'
function save(): void {
  localStorage.setItem(
    KEY,
    JSON.stringify(entries.map((e) => ({ handle: e.handle, did: e.did, rating: e.rating, note: e.note }))),
  )
}

// -------------------------------------------------------------------- minting
async function mint(input: string, opts: { play?: boolean } = {}): Promise<void> {
  const autoplay = opts.play ?? true
  const status = $('#status')
  status.className = ''
  status.textContent = 'resolving…'
  try {
    const did = await resolveHandleToDid(input)
    let profile: Profile | undefined
    try {
      profile = await fetchProfile(did)
    } catch {
      /* profile is cosmetic only */
    }
    status.textContent = 'composing…'
    await new Promise((r) => setTimeout(r, 0))
    const minted = await mintChiptune(did, 32)
    const score = compose(minted.theme)
    const handle = profile?.handle ?? input.trim().replace(/^@/, '')
    const existing = entries.findIndex((e) => e.did === did)
    const entry: Entry = { handle, did, profile, minted, score }
    if (existing >= 0) {
      entry.rating = entries[existing]!.rating
      entry.note = entries[existing]!.note
      entries[existing] = entry
      if (autoplay) playEntry(existing)
    } else {
      entries.unshift(entry)
      if (autoplay) playEntry(0)
    }
    if (!autoplay) renderList()
    save()
    status.textContent = ''
  } catch (err) {
    status.className = 'err'
    status.textContent = (err as Error).message
  }
}

$('#mint').onclick = () => mint($<HTMLInputElement>('#handle').value)
$<HTMLInputElement>('#handle').addEventListener('keydown', (ev) => {
  if ((ev as KeyboardEvent).key === 'Enter') mint($<HTMLInputElement>('#handle').value)
})

const sugg = $('#sugg')
for (const h of SUGGESTIONS) {
  const b = document.createElement('button')
  b.textContent = h
  b.onclick = () => {
    $<HTMLInputElement>('#handle').value = h
    mint(h)
  }
  sugg.append(b)
}

// ------------------------------------------------------------------ transport
$('#play').onclick = () => {
  if (currentId >= 0) playEntry(currentId)
}
$('#stop').onclick = () => {
  player.stop()
  loopSeconds = 0
}
$('#sting').onclick = async () => {
  const e = entries[currentId]
  if (e) player.oneShotScore(await mintStinger(e.did))
}
$('#dl').onclick = () => {
  const e = entries[currentId]
  if (!e) return
  const wav = encodeWav(renderScore(e.score, { loop: true }))
  const url = URL.createObjectURL(new Blob([wav.buffer as ArrayBuffer], { type: 'audio/wav' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `${e.handle.replace(/[^a-z0-9.]/gi, '_')}.wav`
  a.click()
  URL.revokeObjectURL(url)
}

// ------------------------------------------------------------------- feedback
$('#copy').onclick = async () => {
  const lines = ['# chiptune feedback', '']
  for (const e of entries) {
    const c = Object.fromEntries(e.minted.card)
    const mark = e.rating === 'love' ? '★ love' : e.rating === 'meh' ? '✗ no' : e.rating === 'ok' ? '· ok' : '—'
    lines.push(`- **@${e.handle}** [${mark}] — ${c.key}, ${c.tempo}, ${c.progression}, ` +
      `motif ${c.motif} on ${c.voice}, ${c.bass} bass, ${c.harmony}, ${c.percussion}` +
      (e.note ? `\n  - note: ${e.note}` : '') +
      `\n  - seed \`${e.minted.seedHex.slice(0, 16)}\` · \`${e.did}\``)
  }
  const text = lines.join('\n')
  try {
    await navigator.clipboard.writeText(text)
    $('#copied').textContent = `copied ${entries.length} tunes`
  } catch {
    console.log(text)
    $('#copied').textContent = 'clipboard blocked — dumped to console'
  }
  setTimeout(() => ($('#copied').textContent = ''), 2500)
}

$('#clear').onclick = () => {
  entries.length = 0
  currentId = -1
  player.stop()
  localStorage.removeItem(KEY)
  $('#now').classList.add('hidden')
  renderList()
}

// restore last session's ratings by re-minting the same handles
const saved = JSON.parse(localStorage.getItem(KEY) ?? '[]') as { handle: string; rating?: Entry['rating']; note?: string }[]
;(async () => {
  for (const s of saved.slice().reverse()) {
    try {
      await mint(s.handle, { play: false }) // restore quietly
      const e = entries.find((x) => x.handle === s.handle)
      if (e) {
        e.rating = s.rating
        e.note = s.note
      }
    } catch {
      /* skip */
    }
  }
  renderList()
})()

renderList()

/** exposed for console poking: studio.playTheme(THEMES.plaza) */
;(window as unknown as Record<string, unknown>).studio = {
  player,
  entries,
  playTheme: (t: Theme) => player.play(t),
}
