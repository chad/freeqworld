#!/usr/bin/env node
// CLI: render room themes and mint per-DID tunes to .wav.
//   node bin/chiptune.ts list
//   node bin/chiptune.ts render plaza --bars 32 -o out/plaza.wav
//   node bin/chiptune.ts all
//   node bin/chiptune.ts mint did:plc:z72i7hdynmk6r22z27h6tvur
//   node bin/chiptune.ts stinger did:plc:... --play

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { compose } from '../src/compose.ts'
import { renderScore } from '../src/synth.ts'
import { encodeWav } from '../src/wav.ts'
import { THEMES, getTheme } from '../src/themes.ts'
import { mintChiptune, mintStinger } from '../src/mint.ts'
import { ticksToSeconds, type Score } from '../src/score.ts'
import type { Theme } from '../src/compose.ts'

const argv = process.argv.slice(2)
const cmd = argv[0] ?? 'help'
const positional = argv.slice(1).filter((a) => !a.startsWith('-'))
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const has = (name: string): boolean => argv.includes(name)

function write(theme: Theme, outPath: string, opts: { play?: boolean } = {}): void {
  const bars = flag('--bars')
  if (bars) theme = { ...theme, bars: Number(bars) }
  writeScore(compose(theme), outPath, opts)
}

function writeScore(score: Score, outPath: string, opts: { play?: boolean } = {}): void {
  const audio = renderScore(score, { loop: !has('--no-loop') })
  const wav = encodeWav(audio)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, wav)
  const secs = ticksToSeconds(score.length, score.bpm)
  console.log(
    `  ${score.name.padEnd(28)} ${String(score.bpm).padStart(3)} BPM  ` +
      `${secs.toFixed(1)}s  ${String(score.notes.length).padStart(4)} notes  -> ${outPath}`,
  )
  if (opts.play || has('--play')) {
    try {
      execFileSync('afplay', [outPath], { stdio: 'inherit' })
    } catch {
      /* no afplay (non-mac) — file is written anyway */
    }
  }
}

const outDir = flag('--out-dir') ?? 'out'

switch (cmd) {
  case 'list': {
    console.log('themes:')
    for (const [id, t] of Object.entries(THEMES)) {
      console.log(`  ${id.padEnd(12)} ${t.name.padEnd(24)} ${t.bpm} BPM  ${t.scale}  ${t.drums}`)
    }
    break
  }

  case 'render': {
    const id = positional[0] ?? 'plaza'
    const theme = getTheme(id)
    write(theme, flag('-o') ?? join(outDir, `${id}.wav`))
    break
  }

  case 'all': {
    console.log('rendering all launch-room themes:')
    for (const id of Object.keys(THEMES)) write(getTheme(id), join(outDir, `${id}.wav`))
    break
  }

  case 'mint': {
    const did = positional[0]
    if (!did) throw new Error('usage: mint <did>')
    const minted = await mintChiptune(did, Number(flag('--bars') ?? 32))
    console.log(`\n  ${did}`)
    console.log(`  seed ${minted.seedHex.slice(0, 32)}…`)
    console.log('  ┌─────────────────────────────────────────')
    for (const [k, v] of minted.card) console.log(`  │ ${k.padEnd(12)} ${v}`)
    console.log('  └─────────────────────────────────────────')
    console.log(`  motif degrees ${JSON.stringify(minted.motif.degrees)}  rhythm ${JSON.stringify(minted.motif.rhythm)}\n`)
    write(minted.theme, flag('-o') ?? join(outDir, `mint-${minted.seedHex.slice(0, 8)}.wav`))
    break
  }

  case 'stinger': {
    const did = positional[0]
    if (!did) throw new Error('usage: stinger <did>')
    writeScore(await mintStinger(did), flag('-o') ?? join(outDir, 'stinger.wav'), { play: has('--play') })
    break
  }

  default:
    console.log(`freeqworld chiptune generator

  node bin/chiptune.ts list
  node bin/chiptune.ts render <theme> [-o file.wav] [--bars 32] [--play]
  node bin/chiptune.ts all [--out-dir out]
  node bin/chiptune.ts mint <did> [--bars 32] [--play]
  node bin/chiptune.ts stinger <did>
`)
}
