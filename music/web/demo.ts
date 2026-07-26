// Demo page: play the six launch-room themes, and mint a tune from any DID.

import { THEMES } from '../src/themes.ts'
import { compose } from '../src/compose.ts'
import { mintChiptune, mintStinger } from '../src/mint.ts'
import { ChiptunePlayer } from '../src/web.ts'
import { midiToName } from '../src/theory.ts'
import { ticksPerBar, ticksToSeconds, type Score } from '../src/score.ts'
import type { Theme } from '../src/compose.ts'

const player = new ChiptunePlayer()
const $ = (sel: string) => document.querySelector(sel) as HTMLElement

const CH_COLOR: Record<string, string> = {
  pulse1: '#ffd166', pulse2: '#06d6a0', triangle: '#118ab2',
  noise: '#ef476f', dpcm: '#9b5de5', aux: '#4a4a5e',
}

function drawRoll(score: Score): void {
  const cv = $('#roll') as unknown as HTMLCanvasElement
  const ctx = cv.getContext('2d')!
  const w = (cv.width = cv.clientWidth * devicePixelRatio)
  const h = (cv.height = 220 * devicePixelRatio)
  ctx.fillStyle = '#0d0d16'
  ctx.fillRect(0, 0, w, h)

  const bar = ticksPerBar(score.meter)
  ctx.strokeStyle = '#1e1e2e'
  for (let t = 0; t < score.length; t += bar) {
    const x = (t / score.length) * w
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, h)
    ctx.stroke()
  }
  const lo = 24
  const hi = 96
  for (const n of score.notes) {
    const x = (n.t / score.length) * w
    const y = h - ((n.midi - lo) / (hi - lo)) * h
    ctx.fillStyle = CH_COLOR[n.ch] ?? '#fff'
    ctx.fillRect(x, y - 2 * devicePixelRatio, Math.max(2, (n.dur / score.length) * w - 1), 4 * devicePixelRatio)
  }
}

function info(theme: Theme, score: Score, extra = ''): void {
  const secs = ticksToSeconds(score.length, score.bpm)
  const lead = score.notes.filter((n) => n.ch === 'pulse1')
  const range = lead.length
    ? `${midiToName(Math.min(...lead.map((n) => n.midi)))}–${midiToName(Math.max(...lead.map((n) => n.midi)))}`
    : '—'
  $('#info').innerHTML =
    `<b>${theme.name}</b> · ${theme.bpm} BPM · ${theme.scale} · ${score.notes.length} notes · ` +
    `${secs.toFixed(1)}s loop · lead ${range}${extra}`
  drawRoll(score)
}

function playTheme(theme: Theme): void {
  const score = compose(theme)
  player.play(theme)
  info(theme, score)
}

const rooms = $('#rooms')
for (const [id, theme] of Object.entries(THEMES)) {
  const b = document.createElement('button')
  b.textContent = theme.name
  b.onclick = () => {
    for (const el of rooms.querySelectorAll('button')) el.classList.remove('on')
    b.classList.add('on')
    playTheme(theme)
  }
  rooms.append(b)
}

$('#stop').onclick = () => {
  player.stop()
  for (const el of rooms.querySelectorAll('button')) el.classList.remove('on')
}

$('#mint').onclick = async () => {
  const did = ($('#did') as unknown as HTMLInputElement).value.trim()
  if (!did) return
  const minted = await mintChiptune(did)
  const score = compose(minted.theme)
  player.play(minted.theme)
  const card = minted.card.map(([k, v]) => `<span class="chip"><i>${k}</i>${v}</span>`).join('')
  $('#card').innerHTML = card
  info(minted.theme, score, ` · seed ${minted.seedHex.slice(0, 12)}…`)
}

$('#stinger').onclick = async () => {
  const did = ($('#did') as unknown as HTMLInputElement).value.trim()
  if (!did) return
  player.oneShotScore(await mintStinger(did))
}
