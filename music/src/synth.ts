// Software 2A03-ish synth. Renders a Score to interleaved-free stereo Float32
// buffers. Pure JS, no Web Audio, so the exact same samples come out in Node
// (offline .wav) and in the browser (fed to an AudioBuffer).

import { patch, type Patch } from './instruments.ts'
import { midiToFreq } from './theory.ts'
import { monophonize, ticksToSeconds, type Channel, type Note, type Score } from './score.ts'

export interface RenderOptions {
  sampleRate?: number
  /** fold the ring-out tail back into the head so the file loops seamlessly */
  loop?: boolean
  /** extra seconds rendered past the loop point for release tails */
  tail?: number
  masterGain?: number
  /** peak-normalise to this level (0 disables) */
  normalize?: number
}

export interface Audio {
  sampleRate: number
  left: Float32Array
  right: Float32Array
}

const CHANNEL_MIX: Record<Channel, { gain: number; pan: number }> = {
  pulse1: { gain: 0.9, pan: -0.28 },
  pulse2: { gain: 0.8, pan: 0.28 },
  triangle: { gain: 1.0, pan: 0 },
  noise: { gain: 0.85, pan: 0.12 },
  dpcm: { gain: 1.0, pan: 0 },
  aux: { gain: 0.6, pan: -0.1 },
}

const FRAME = 1 / 60 // NES envelopes/arps tick with the video frame

function polyBlep(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt
    return x + x - x * x - 1
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt
    return x * x + x + x + 1
  }
  return 0
}

function envelope(p: Patch, t: number, dur: number): number {
  const rel = p.release ?? 0.02
  const level = (u: number): number => {
    if (p.volSeq) {
      const i = Math.floor(u / FRAME)
      return i < p.volSeq.length ? p.volSeq[i]! : 0
    }
    const a = p.attack ?? 0.002
    const d = p.decay ?? 0.1
    const s = p.sustain ?? 0.7
    if (u < a) return a === 0 ? 1 : u / a
    if (u < a + d) return 1 - (1 - s) * ((u - a) / (d || 1))
    return s
  }
  if (t <= dur) return level(t)
  const k = 1 - (t - dur) / rel
  return k <= 0 ? 0 : level(dur) * k
}

/** Render one note into `out` (mono), starting at sample `start`. */
function renderNote(out: Float32Array, start: number, note: Note, dur: number, sr: number): void {
  const p = patch(note.patch)
  const vel = note.vel ?? 1
  const total = dur + (p.release ?? 0.02) + (p.volSeq ? 0.02 : 0)
  const n = Math.ceil(total * sr)
  const baseFreq = midiToFreq(note.midi) * Math.pow(2, (p.detune ?? 0) / 1200)

  let phase = Math.random() * 0 // deterministic: always start at 0
  let lfsr = 0x7ffe
  let noiseAcc = 0
  let noiseVal = 1

  for (let i = 0; i < n; i++) {
    const idx = start + i
    if (idx < 0) continue
    if (idx >= out.length) break
    const t = i / sr
    const env = envelope(p, t, dur)
    if (env <= 0 && t > dur) break

    // ---- pitch -----------------------------------------------------------
    let semis = 0
    if (note.arp && note.arp.length) {
      semis += note.arp[Math.floor(t / FRAME) % note.arp.length]!
    }
    if (p.vibrato && t > p.vibrato.delay) {
      const ramp = Math.min(1, (t - p.vibrato.delay) / 0.15)
      semis += ramp * p.vibrato.depth * Math.sin(2 * Math.PI * p.vibrato.rate * t)
    }
    if (p.pitchEnv) {
      semis += p.pitchEnv.amount * Math.max(0, 1 - t / p.pitchEnv.time) ** 2
    }
    if (note.slide) {
      const g = Math.min(1, t / 0.045)
      semis += note.slide * (1 - g)
    }
    const freq = baseFreq * Math.pow(2, semis / 12)

    // ---- waveform --------------------------------------------------------
    let s = 0
    if (p.wave === 'noise') {
      const rate = Math.min(sr * 0.5, freq * 16)
      noiseAcc += rate / sr
      while (noiseAcc >= 1) {
        noiseAcc -= 1
        const fb = (lfsr ^ (lfsr >> (p.noiseMode === 'short' ? 6 : 1))) & 1
        lfsr = (lfsr >> 1) | (fb << 14)
        noiseVal = lfsr & 1 ? 1 : -1
      }
      s = noiseVal
    } else {
      const dt = freq / sr
      phase += dt
      if (phase >= 1) phase -= 1
      if (p.wave === 'pulse') {
        const duty = p.dutySeq ? p.dutySeq[Math.floor(t / FRAME) % p.dutySeq.length]! : (p.duty ?? 0.5)
        s = phase < duty ? 1 : -1
        s += polyBlep(phase, dt)
        s -= polyBlep((phase + 1 - duty) % 1, dt)
      } else if (p.wave === 'triangle') {
        const tri = 4 * Math.abs(phase - 0.5) - 1
        s = Math.round(tri * 7.5) / 7.5 // 16-step quantisation, like the 2A03
      } else if (p.wave === 'fm') {
        const f = p.fm ?? { ratio: 2, index: 4, decay: 0.2 }
        const mi = f.index * Math.exp(-t / f.decay)
        s = Math.sin(2 * Math.PI * phase + mi * Math.sin(2 * Math.PI * phase * f.ratio))
      } else {
        s = Math.sin(2 * Math.PI * phase)
      }
    }

    out[idx] = out[idx]! + s * env * vel * p.gain
  }
}

export function renderScore(score: Score, opts: RenderOptions = {}): Audio {
  const sr = opts.sampleRate ?? 44100
  const loop = opts.loop ?? true
  const tail = opts.tail ?? 2
  const bodySec = ticksToSeconds(score.length, score.bpm)
  const bodyN = Math.round(bodySec * sr)
  const tailN = Math.ceil(tail * sr)
  const total = bodyN + tailN

  const lanes = new Map<Channel, Float32Array>()
  for (const note of monophonize(score.notes)) {
    let buf = lanes.get(note.ch)
    if (!buf) {
      buf = new Float32Array(total)
      lanes.set(note.ch, buf)
    }
    const start = Math.round(ticksToSeconds(note.t, score.bpm) * sr)
    const dur = Math.max(0.01, ticksToSeconds(note.dur, score.bpm))
    renderNote(buf, start, note, dur, sr)
  }

  const left = new Float32Array(total)
  const right = new Float32Array(total)
  const master = opts.masterGain ?? 0.5
  for (const [ch, buf] of lanes) {
    const mix = CHANNEL_MIX[ch]
    const l = master * mix.gain * Math.cos(((mix.pan + 1) * Math.PI) / 4)
    const r = master * mix.gain * Math.sin(((mix.pan + 1) * Math.PI) / 4)
    for (let i = 0; i < total; i++) {
      left[i] = left[i]! + buf[i]! * l
      right[i] = right[i]! + buf[i]! * r
    }
  }

  // seamless loop: ring-out from past the loop point wraps into the head
  let outL = left
  let outR = right
  if (loop) {
    outL = left.slice(0, bodyN)
    outR = right.slice(0, bodyN)
    for (let i = 0; i < tailN; i++) {
      outL[i % bodyN] = outL[i % bodyN]! + left[bodyN + i]!
      outR[i % bodyN] = outR[i % bodyN]! + right[bodyN + i]!
    }
  }

  postProcess(outL, sr)
  postProcess(outR, sr)

  const norm = opts.normalize ?? 0.92
  if (norm > 0) {
    let peak = 0
    for (let i = 0; i < outL.length; i++) peak = Math.max(peak, Math.abs(outL[i]!), Math.abs(outR[i]!))
    if (peak > 0) {
      const g = norm / peak
      for (let i = 0; i < outL.length; i++) {
        outL[i]! *= g
        outR[i]! *= g
      }
    }
  }

  return { sampleRate: sr, left: outL, right: outR }
}

/** DC block, gentle lowpass (tames square-wave aliasing), soft clip. */
function postProcess(buf: Float32Array, sr: number): void {
  const cutoff = 11000
  const a = Math.exp((-2 * Math.PI * cutoff) / sr)
  let lp = 0
  let hpX = 0
  let hpY = 0
  const R = 1 - (2 * Math.PI * 18) / sr
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i]!
    hpY = x - hpX + R * hpY
    hpX = x
    lp = (1 - a) * hpY + a * lp
    buf[i] = Math.tanh(lp * 1.1) * 0.9
  }
}
