// Chiptune engine (spec §11): all sound is synthesized with the Web Audio
// API — no streamed assets. A base loop per room, layers gated by the shared
// MusicState, personal leitmotifs quoted on arrival, per-DID speech blips.

import type { MusicState } from '../../shared/src/music'
import { deriveLeitmotif } from '../../shared/src/leitmotif'

type Wave = OscillatorType

const MINOR = [0, 2, 3, 5, 7, 8, 10]
const MAJOR = [0, 2, 4, 5, 7, 9, 11]

export class ChiptuneEngine {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private timer: number | null = null
  private nextBeat = 0
  private beatIndex = 0
  private bpm = 108
  private root = 45 // A2
  private state: MusicState | null = null
  private _muted = true

  get muted(): boolean {
    return this._muted
  }

  toggle(): boolean {
    if (this._muted) this.start()
    else this.stop()
    return this._muted
  }

  setRoom(bpm: number, channel: string): void {
    this.bpm = bpm
    // deterministic root per room name so each room has its own key
    let h = 0
    for (const c of channel) h = (h * 31 + c.charCodeAt(0)) | 0
    this.root = 40 + (Math.abs(h) % 10)
  }

  setState(state: MusicState): void {
    this.state = state
  }

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext()
      this.master = this.ctx.createGain()
      this.master.gain.value = 0.14 // restrained default volume (spec §30.5)
      this.master.connect(this.ctx.destination)
    }
    return this.ctx
  }

  start(): void {
    const ctx = this.ensureCtx()
    void ctx.resume()
    this._muted = false
    if (this.timer == null) {
      this.nextBeat = ctx.currentTime + 0.05
      this.timer = window.setInterval(() => this.schedule(), 60)
    }
  }

  stop(): void {
    this._muted = true
    if (this.timer != null) {
      clearInterval(this.timer)
      this.timer = null
    }
    void this.ctx?.suspend()
  }

  private schedule(): void {
    const ctx = this.ctx
    if (!ctx || this._muted) return
    const s = this.state
    const energy = s?.energy ?? 0.2
    const tension = s?.tension ?? 0.1
    const density = s?.density ?? 0.2
    const brightness = s?.brightness ?? 0.5
    // tempo modulates smoothly within a bounded range (spec §11.3)
    const bpm = this.bpm * (0.95 + energy * 0.1)
    const beat = 60 / bpm
    const scale = tension > 0.45 ? MINOR : brightness > 0.6 ? MAJOR : MINOR
    while (this.nextBeat < ctx.currentTime + 0.15) {
      const t = this.nextBeat
      const i = this.beatIndex
      // bass: root movement i ii v i
      const prog = [0, 0, 3, 0, 4, 4, 3, 0]
      const bassDeg = prog[Math.floor(i / 2) % 8]!
      if (i % 2 === 0) this.note(t, this.root + scale[bassDeg % 7]!, beat * 0.9, 'triangle', 0.9)
      // lead arpeggio when the room is dense enough
      if (density > 0.25 || energy > 0.4) {
        const arp = [0, 2, 4, 6]
        const deg = arp[i % 4]! + bassDeg
        this.note(t, this.root + 24 + scale[deg % 7]! + 12 * Math.floor(deg / 7), beat * 0.45, brightness > 0.55 ? 'square' : 'sawtooth', 0.35)
      }
      // noise hat
      if (energy > 0.15 && i % 2 === 1) this.hat(t, 0.04 + density * 0.05)
      // tension ornament: flat second sting
      if (tension > 0.6 && i % 8 === 7) this.note(t, this.root + 13, beat * 0.3, 'square', 0.3)
      this.nextBeat += beat / 2 // 8th grid
      this.beatIndex++
    }
  }

  private note(t: number, midi: number, dur: number, wave: Wave, vel: number): void {
    const ctx = this.ctx!
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = wave
    osc.frequency.value = 440 * Math.pow(2, (midi - 69) / 12)
    gain.gain.setValueAtTime(0.0001, t)
    gain.gain.linearRampToValueAtTime(vel * 0.5, t + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    osc.connect(gain).connect(this.master!)
    osc.start(t)
    osc.stop(t + dur + 0.05)
  }

  private hat(t: number, vel: number): void {
    const ctx = this.ctx!
    const len = 0.04
    const buffer = ctx.createBuffer(1, ctx.sampleRate * len, ctx.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length)
    const src = ctx.createBufferSource()
    src.buffer = buffer
    const gain = ctx.createGain()
    gain.gain.value = vel
    const filter = ctx.createBiquadFilter()
    filter.type = 'highpass'
    filter.frequency.value = 6000
    src.connect(filter).connect(gain).connect(this.master!)
    src.start(t)
  }

  /** Quote a participant's leitmotif on arrival (spec §11.2 identity layer). */
  async playLeitmotif(did: string): Promise<void> {
    if (this._muted || !this.ctx) return
    const motif = await deriveLeitmotif(did)
    const wave: Wave = motif.instrument === 'triangle' ? 'triangle' : motif.instrument === 'fmbell' ? 'sine' : 'square'
    let t = this.ctx.currentTime + 0.05
    for (let i = 0; i < motif.notes.length; i++) {
      const dur = motif.rhythmic_cell[i]! * 0.16
      this.note(t, motif.notes[i]!, dur, wave, 0.5)
      t += dur
    }
  }

  /** Per-DID speech blip (spec §6.5 voice glyph). */
  speechBlip(did: string): void {
    if (this._muted || !this.ctx) return
    let h = 0
    for (const c of did) h = (h * 33 + c.charCodeAt(0)) | 0
    const freq = 300 + (Math.abs(h) % 480)
    const t = this.ctx.currentTime
    const osc = this.ctx.createOscillator()
    const gain = this.ctx.createGain()
    osc.type = 'square'
    osc.frequency.setValueAtTime(freq, t)
    osc.frequency.linearRampToValueAtTime(freq * 1.3, t + 0.05)
    gain.gain.setValueAtTime(0.12, t)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.08)
    osc.connect(gain).connect(this.master!)
    osc.start(t)
    osc.stop(t + 0.1)
  }

  stinger(kind: 'door' | 'mention' | 'lock' | 'portal'): void {
    if (this._muted || !this.ctx) return
    const t = this.ctx.currentTime
    const seqs: Record<string, number[]> = {
      door: [72, 79],
      mention: [84, 88, 91],
      lock: [60, 55, 62],
      portal: [60, 64, 67, 72, 76],
    }
    let time = t
    for (const midi of seqs[kind]!) {
      this.note(time, midi, 0.1, 'square', 0.4)
      time += 0.07
    }
  }
}
