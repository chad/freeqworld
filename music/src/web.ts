// Browser playback. The renderer is the same pure-JS synth used offline, so
// what you hear in the world client is sample-identical to the .wav files —
// we just hand the buffer to Web Audio instead of a file.
//
// Assets stay tiny: a Theme is ~30 lines of JSON, and a loop is rendered on
// the fly in a few hundred milliseconds.

import { compose, type Theme } from './compose.ts'
import { renderScore, type Audio, type RenderOptions } from './synth.ts'
import type { Score } from './score.ts'

export function toAudioBuffer(audio: Audio, ctx: BaseAudioContext): AudioBuffer {
  const buf = ctx.createBuffer(2, audio.left.length, audio.sampleRate)
  buf.getChannelData(0).set(audio.left)
  buf.getChannelData(1).set(audio.right)
  return buf
}

export interface PlayHandle {
  source: AudioBufferSourceNode
  gain: GainNode
  stop: (fadeSeconds?: number) => void
}

export class ChiptunePlayer {
  readonly ctx: AudioContext
  private current?: PlayHandle
  private cache = new Map<string, AudioBuffer>()

  constructor(ctx?: AudioContext) {
    this.ctx = ctx ?? new AudioContext()
  }

  /** Render (and memoise) a theme's loop. */
  buffer(theme: Theme, opts?: RenderOptions): AudioBuffer {
    const key = JSON.stringify(theme)
    let buf = this.cache.get(key)
    if (!buf) {
      buf = toAudioBuffer(renderScore(compose(theme), { loop: true, ...opts }), this.ctx)
      this.cache.set(key, buf)
    }
    return buf
  }

  /** Crossfade into a theme, looping forever. */
  play(theme: Theme, opts: { loop?: boolean; fade?: number; volume?: number } = {}): PlayHandle {
    // browsers hand you a suspended context until a user gesture
    if (this.ctx.state === 'suspended') void this.ctx.resume()
    const fade = opts.fade ?? 0.4
    const buf = this.buffer(theme)
    this.current?.stop(fade)

    const source = this.ctx.createBufferSource()
    source.buffer = buf
    source.loop = opts.loop ?? true
    const gain = this.ctx.createGain()
    const vol = opts.volume ?? 1
    gain.gain.setValueAtTime(0, this.ctx.currentTime)
    gain.gain.linearRampToValueAtTime(vol, this.ctx.currentTime + fade)
    source.connect(gain).connect(this.ctx.destination)
    source.start()

    const handle: PlayHandle = {
      source,
      gain,
      stop: (f = 0.3) => {
        const t = this.ctx.currentTime
        gain.gain.cancelScheduledValues(t)
        gain.gain.setValueAtTime(gain.gain.value, t)
        gain.gain.linearRampToValueAtTime(0, t + f)
        source.stop(t + f + 0.02)
      },
    }
    this.current = handle
    return handle
  }

  /** Fire-and-forget one-shot, e.g. an identity stinger over the room music. */
  oneShot(theme: Theme, volume = 0.9): PlayHandle {
    return this.oneShotScore(compose(theme), volume)
  }

  /** Same, for a Score that wasn't built from a Theme (arrival stingers). */
  oneShotScore(score: Score, volume = 0.9): PlayHandle {
    if (this.ctx.state === 'suspended') void this.ctx.resume()
    const source = this.ctx.createBufferSource()
    source.buffer = toAudioBuffer(renderScore(score, { loop: false, tail: 1 }), this.ctx)
    const gain = this.ctx.createGain()
    gain.gain.value = volume
    source.connect(gain).connect(this.ctx.destination)
    source.start()
    return { source, gain, stop: () => source.stop() }
  }

  stop(fade = 0.3): void {
    this.current?.stop(fade)
    this.current = undefined
  }
}

/** Convenience for one-off rendering without a player. */
export function renderTheme(theme: Theme): { score: Score; audio: Audio } {
  const score = compose(theme)
  return { score, audio: renderScore(score) }
}
