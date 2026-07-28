// The social card for /score/<who> — the theme as music, not as a profile.
//
// The character card answers "who is this?". This one answers "what does it
// sound like?", so the notation is the subject rather than a strip at the
// bottom. Three layers, back to front:
//
//   1. the whole piece as a ghosted piano roll, full bleed — the SHAPE of it
//   2. the opening phrase engraved on a staff, glowing — the part you can READ
//   3. the type: what it is, whose it is, and the facts of the derivation
//
// Same constraint as the rest of the card pipeline: hand-rolled deterministic
// PNG, no canvas, no system fonts, so a DID always produces identical bytes.

import { deriveAvatar } from '../../shared/src/avatar'
import { compose } from '../../music/src/compose.ts'
import { mintChiptune } from '../../music/src/mint.ts'
import { monophonize, ticksPerBar, TPQ } from '../../music/src/score.ts'
import { quantizeForNotation } from '../../music/src/musicxml.ts'
import { keySignatureFifths } from '../../music/src/midi.ts'
import { noteToMidi, SCALES } from '../../music/src/theory.ts'
import { backdrop, drawSprite, drawRoll, hslToRgb } from './card.ts'
import { drawText, drawTextCentered, textWidth } from './font.ts'
import { createBitmap, encodePng, fillEllipse, fillRect, type Bitmap, type RGB } from './png.ts'
import { drawStaff } from './staff.ts'

const W = 1200
const H = 630
const INK: RGB = [13, 13, 20]
const PAPER: RGB = [216, 214, 200]
const DIM: RGB = [138, 136, 150]

function hexToRgb(hex: string): RGB {
  const n = Number.parseInt(hex.replace('#', ''), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export async function renderScoreCard(did: string, label: string): Promise<Uint8Array> {
  const avatar = await deriveAvatar(did)
  const minted = await mintChiptune(did, 16)
  const theme = minted.theme
  const score = compose(theme)
  const bd = backdrop(avatar)
  const accent = hexToRgb(String(avatar.traits.accent_palette))
  const bmp = createBitmap(W, H)

  // --- 1. backdrop + the piece as texture ----------------------------------
  fillRect(bmp, 0, 0, W, H, INK)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = Math.hypot((x - W * 0.5) / (W * 0.62), (y - H * 0.42) / (H * 0.9))
      if (d >= 1) continue
      const k = (1 - d) ** 1.7
      blend(bmp, x, y, hslToRgb(bd.h, bd.s, 0.15 + k * 0.17), k)
    }
  }
  // Manuscript rules, full bleed and very faint: the card reads as a page the
  // music is written on. A ghosted piano roll was tried here first and looked
  // like static — dashes that the eye keeps mistaking for noteheads.
  for (let i = 0; i < 26; i++) {
    const y = 40 + i * 22
    if (y > H - 20) break
    for (let x = 0; x < W; x++) {
      const ex = Math.min(1, Math.min(x, W - x) / 220)
      blend(bmp, x, y, [255, 255, 255], 0.035 * ex)
    }
  }

  // --- 3a. type across the top ---------------------------------------------
  drawText(bmp, 'FREEQWORLD', 56, 62, DIM, { scale: 3, tracking: 2 })
  drawText(bmp, 'SHEET MUSIC', 56 + textWidth('FREEQWORLD', 3, 2) + 22, 62, accent, { scale: 3, tracking: 2 })

  // the theme's name is the headline; it is often long, so it gets two sizes
  const name = theme.name.toUpperCase().replace(/[—–]/g, '-')
  const big = textWidth(name, 6, 3) <= W - 112 ? 6 : textWidth(name, 5, 3) <= W - 112 ? 5 : 4
  drawText(bmp, name, 56, 132, PAPER, { scale: big, tracking: 3 })
  drawText(bmp, label.toUpperCase(), 56, 132 + big * 9 + 22, accent, { scale: 3, tracking: 2 })

  // --- 2. the opening phrase, engraved -------------------------------------
  // The lead is the tune people would hum, so that is what gets written out.
  // Start where it actually enters: many themes rest for the first bars, and a
  // card showing four empty bars says nothing.
  const bar = ticksPerBar(theme.meter)
  const mono = monophonize(score.notes)
  const lead = mono.filter((n) => n.ch === 'pulse1')
  const voice = lead.length >= 4 ? lead : mono.filter((n) => n.ch === 'pulse2')
  const written = quantizeForNotation(voice, score.length)
  const t0 = written.length ? Math.floor(written[0]!.note.t / bar) * bar : 0
  // four bars: two of this melody is a handful of quarters spread thin across a
  // 1200px card, which looks like an empty stave rather than a tune
  const span = bar * 4
  const phrase = written
    .filter((x) => x.note.t >= t0 && x.note.t < t0 + span)
    .map((x) => ({ midi: x.note.midi, t: x.note.t - t0, dur: x.dur }))

  const staffY = 348
  const gap = 16
  // a lit band behind the staff, so the notation sits on something
  for (let y = staffY - 74; y < staffY + 132; y++) {
    const k = 1 - Math.abs(y - (staffY + 30)) / 130
    if (k <= 0) continue
    for (let x = 0; x < W; x++) {
      const ex = 1 - Math.abs(x - W / 2) / (W / 2)
      blend(bmp, x, y, hslToRgb(bd.h, Math.min(1, bd.s + 0.1), 0.5), k * ex * 0.13)
    }
  }
  drawStaff(bmp, phrase, {
    x: 56, y: staffY, w: W - 112, gap, colour: accent, lineColour: [214, 214, 232],
    fifths: keySignatureFifths(noteToMidi(theme.key) % 12, SCALES[theme.scale]), span, tpq: TPQ,
    barTicks: bar,
    alpha: 1,
  })
  // a soft bloom on the note heads: cheap, and it makes the notation feel lit
  bloom(bmp, 56, staffY - 60, W - 112, 200, accent)

  // --- 3b. the facts, along the bottom -------------------------------------
  const chips: [string, string][] = [
    ['KEY', `${theme.key.replace(/\d/g, '')} ${theme.scale.replace(/([A-Z])/g, ' $1').toUpperCase()}`],
    ['TEMPO', `${theme.bpm} BPM`],
    ['METER', `${theme.meter[0]}/${theme.meter[1]}`],
  ]
  let cx = 56
  const cy = H - 104
  for (const [k, v] of chips) {
    const w = textWidth(k, 2, 1) + textWidth(v, 3, 2) + 34
    fillRect(bmp, cx, cy, w, 44, [10, 10, 17], 0.66)
    fillRect(bmp, cx, cy, 3, 44, accent, 0.9)
    drawText(bmp, k, cx + 14, cy + 12, DIM, { scale: 2, tracking: 1 })
    drawText(bmp, v, cx + 14 + textWidth(k, 2, 1) + 12, cy + 10, PAPER, { scale: 3, tracking: 2 })
    cx += w + 14
  }

  // whose music this is — up beside the title, clear of the notation
  drawSprite(bmp, avatar, W - 196, 74, 7, 'south', 0)

  drawTextCentered(bmp, 'DERIVED FROM THEIR IDENTITY - NOT CHOSEN, NOT UPLOADED', W / 2, H - 34, DIM, {
    scale: 2, tracking: 1,
  })

  return encodePng(bmp)
}

/** A cheap bloom: sample bright pixels in a region and smear a halo under them.
 *  Real blur would cost a full convolution per card; this reads the same at
 *  unfurl size and stays deterministic. */
function bloom(bmp: Bitmap, x0: number, y0: number, w: number, h: number, c: RGB): void {
  const hits: [number, number][] = []
  for (let y = y0; y < y0 + h; y += 2) {
    for (let x = x0; x < x0 + w; x += 2) {
      const i = (y * W + x) * 4
      const r = bmp.data[i] ?? 0
      const g = bmp.data[i + 1] ?? 0
      const b = bmp.data[i + 2] ?? 0
      // only the accent-coloured ink, not the staff lines
      if (Math.abs(r - c[0]) < 40 && Math.abs(g - c[1]) < 40 && Math.abs(b - c[2]) < 40) hits.push([x, y])
    }
  }
  for (const [hx, hy] of hits) fillEllipse(bmp, hx, hy, 11, 11, c, 0.05)
}

function blend(bmp: Bitmap, x: number, y: number, c: RGB, a: number): void {
  fillRect(bmp, x, y, 1, 1, c, Math.max(0, Math.min(1, a)))
}
