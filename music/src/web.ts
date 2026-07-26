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
  private timeline?: { startedAt: number; duration: number; bpm: number }

  /** Where playback is, for anything that wants to move in time with it
   *  (the animated avatar stage, beat indicators, visualisers). */
  get position(): { seconds: number; beats: number; bars: number } | null {
    const tl = this.timeline
    if (!tl || this.ctx.state !== 'running') return null
    const elapsed = this.ctx.currentTime - tl.startedAt
    if (elapsed < 0) return { seconds: 0, beats: 0, bars: 0 }
    const seconds = elapsed % tl.duration
    const beats = (elapsed * tl.bpm) / 60
    return { seconds, beats, bars: beats / 4 }
  }

  constructor(ctx?: AudioContext) {
    const Ctor: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    this.ctx = ctx ?? new Ctor()
  }

  /** MUST be called synchronously inside a user-gesture handler.
   *
   *  iOS only honours `resume()` while the gesture is still on the stack — a
   *  single `await` before this point (even `setTimeout(0)`) leaves the context
   *  suspended forever and the page plays silence. Two more Safari details are
   *  handled here: a one-frame silent buffer to fully open the output pipeline,
   *  and `audioSession.type = 'playback'` so Web Audio isn't muted by the
   *  physical ring/silent switch (Safari 16.4+; Web Audio, unlike <audio>,
   *  otherwise obeys it and iPhones live on silent). */
  unlock(): void {
    type Session = { type: string }
    const nav = navigator as unknown as { audioSession?: Session }
    try {
      if (nav.audioSession) nav.audioSession.type = 'playback'
    } catch {
      /* not supported — the mute switch may silence us, nothing else to do */
    }
    void this.ctx.resume()
    const buf = this.ctx.createBuffer(1, 1, this.ctx.sampleRate)
    const src = this.ctx.createBufferSource()
    src.buffer = buf
    src.connect(this.ctx.destination)
    src.start(0)
  }

  /** False if the browser is still refusing to make sound. */
  get running(): boolean {
    return this.ctx.state === 'running'
  }

  /** Render (and memoise) a theme's loop. */
  buffer(theme: Theme, opts?: RenderOptions): AudioBuffer {
    const key = JSON.stringify(theme)
    let buf = this.cache.get(key)
    if (!buf) {
      // render at the device's own rate: Safari runs at 48 kHz and resampling a
      // 44.1 kHz buffer costs memory and (on older iOS) plays back wrong
      buf = toAudioBuffer(
        renderScore(compose(theme), { sampleRate: this.ctx.sampleRate, loop: true, ...opts }),
        this.ctx,
      )
      this.cache.set(key, buf)
    }
    return buf
  }

  /** Crossfade into a theme, looping forever. */
  play(theme: Theme, opts: { loop?: boolean; fade?: number; volume?: number } = {}): PlayHandle {
    // belt and braces: unlock() should already have run inside the gesture
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
    this.timeline = { startedAt: this.ctx.currentTime, duration: buf.duration, bpm: theme.bpm }

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
    source.buffer = toAudioBuffer(
      renderScore(score, { sampleRate: this.ctx.sampleRate, loop: false, tail: 1 }),
      this.ctx,
    )
    const gain = this.ctx.createGain()
    gain.gain.value = volume
    source.connect(gain).connect(this.ctx.destination)
    source.start()
    return { source, gain, stop: () => source.stop() }
  }

  stop(fade = 0.3): void {
    this.current?.stop(fade)
    this.current = undefined
    this.timeline = undefined
  }
}

/** Convenience for one-off rendering without a player. */
export function renderTheme(theme: Theme): { score: Score; audio: Audio } {
  const score = compose(theme)
  return { score, audio: renderScore(score) }
}
