// The world's sound (spec §11), on the shared chiptune engine in music/.
//
// This file is now a thin adapter: the engine (music/src/room.ts) owns the
// layered bed, the identity quotes and the budget that keeps them from becoming
// a doorbell. Keeping the old public surface (setRoom / setState / speechBlip /
// playLeitmotif / playEnsemble / stinger / toggle) means every call site in
// app.ts keeps working, and the room you walk into is now the same music you
// auditioned on pfp.freeq.at.
//
// What you hear, and when:
//   own theme in full   arriving in the world (2–4 bars, then the room takes over)
//   own motif           when you're alone in a room, as the room's melody
//   others' motifs      arrival (quiet, on the bar, budgeted) · opening their
//                       card (louder) · when they @mention you (their motif IS
//                       the notification)
//   speech              a blip tinted by their motif — never the motif itself
//                       (spec §30.5: avoid constant reaction sounds)

import type { MusicState } from '../../shared/src/music'
import { deriveLeitmotif } from '../../shared/src/leitmotif'
import { MUSIC_MODES, RoomMusic, type Cue, type MusicMode } from '../../music/src/room.ts'
import { themeForCue } from '../../music/src/themes.ts'
import { midiToFreq } from '../../music/src/theory.ts'

export interface AudioPrefs {
  music: number
  motifs: number
  effects: number
  /** how much music: off / moments / breathing / always (spec §30.5) */
  mode: MusicMode
}

const PREFS_KEY = 'fimp-audio-prefs'
/** 'breathing' by default: the room's music swells when something is happening
 *  and rests when it isn't, rather than looping at you forever. */
const DEFAULT_PREFS: AudioPrefs = { music: 0.5, motifs: 0.75, effects: 0.6, mode: 'activity' }

export { MUSIC_MODES, type Cue, type MusicMode }

export class ChiptuneEngine {
  private engine: RoomMusic | null = null
  private state: MusicState | null = null
  private cue = 'plaza_108bpm'
  private bpm = 108
  private channel = '#plaza'
  private _muted = true
  private identityDid: string | null = null
  private prefs: AudioPrefs = { ...DEFAULT_PREFS }
  private cueListeners: ((cue: Cue) => void)[] = []

  constructor() {
    try {
      const saved = localStorage.getItem(PREFS_KEY)
      if (saved) this.prefs = { ...DEFAULT_PREFS, ...(JSON.parse(saved) as Partial<AudioPrefs>) }
    } catch {
      /* defaults are fine */
    }
  }

  get muted(): boolean {
    return this._muted
  }

  status(): { muted: boolean; ctxState: string; scheduling: boolean; prefs: AudioPrefs; cue: string } {
    return {
      muted: this._muted,
      ctxState: this.engine?.ctx.state ?? 'none',
      scheduling: this.engine?.position !== null && this.engine?.position !== undefined,
      prefs: this.prefs,
      cue: this.cue,
    }
  }

  /** Separate music / motif / effects levels (spec §26 accessibility). */
  setPrefs(next: Partial<AudioPrefs>): AudioPrefs {
    this.prefs = { ...this.prefs, ...next }
    if (next.mode) this.engine?.setMode(next.mode)
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(this.prefs))
    } catch {
      /* private mode: preferences just won't persist */
    }
    this.engine?.setVolumes(this.prefs)
    return this.prefs
  }

  getPrefs(): AudioPrefs {
    return { ...this.prefs }
  }

  toggle(): boolean {
    if (this._muted) this.start()
    else this.stop()
    return this._muted
  }

  /** Call from a click handler: iOS only unlocks audio inside a gesture. */
  start(): void {
    if (!this.engine) this.engine = new RoomMusic(undefined, { bars: 16 })
    this.engine.unlock() // synchronous, inside the gesture
    this.engine.setVolumes(this.prefs)
    this.engine.setMode(this.prefs.mode)
    this.engine.setIdentity(this.identityDid)
    for (const fn of this.cueListeners) this.engine.onCue(fn)
    this._muted = false
    if (this.state) this.engine.setMusicState(this.state)
    this.engine.enterRoom(themeForCue(this.cue, this.bpm, this.channel))
  }

  stop(): void {
    this._muted = true
    this.engine?.stop()
  }

  setState(state: MusicState): void {
    this.state = state
    if (!this._muted) this.engine?.setMusicState(state)
  }

  /** Subscribe to what the music is saying, so the interface can show whose
   *  theme is playing. Safe to call before audio exists. */
  onCue(fn: (cue: Cue) => void): void {
    this.cueListeners.push(fn)
    this.engine?.onCue(fn)
  }

  /** Something happened in this room — brings the music back up in the
   *  'moments' and 'breathing' modes. */
  noteActivity(): void {
    this.engine?.noteActivity()
  }

  /** Room change. `cue` is the world's `music.base_cue` (spec §11.7). */
  setRoom(bpm: number, channel: string, cue?: string): void {
    this.bpm = bpm
    this.channel = channel
    if (cue) this.cue = cue
    if (this._muted || !this.engine) return
    this.engine.enterRoom(themeForCue(this.cue, bpm, channel))
  }

  /** Who I am — decides whose motif carries the room when it's empty. */
  setIdentity(did: string | null): void {
    this.identityDid = did
    this.engine?.setIdentity(did)
  }

  setPopulation(n: number): void {
    this.engine?.setPopulation(n)
  }

  /** Your own tune, in full: the moment you arrive in the world. */
  async playOwnTheme(did: string): Promise<void> {
    if (this._muted || !this.engine) return
    await this.engine.ownTheme(did, 4)
  }

  /** Quote a participant's leitmotif (spec §11.3 identity layer). */
  async playLeitmotif(did: string, reason: 'arrival' | 'inspect' | 'mention' = 'arrival'): Promise<void> {
    if (this._muted || !this.engine) return
    await this.engine.quote(did, reason)
  }

  /** People standing together harmonise, in the room's key. */
  async playEnsemble(dids: string[]): Promise<void> {
    if (this._muted || !this.engine) return
    await this.engine.ensemble(dids)
  }

  /** Per-DID speech blip (spec §6.5 voice glyph).
   *
   *  Tinted by the speaker's leitmotif — its first note and its instrument — so
   *  a voice and its theme are audibly the same person, without replaying the
   *  motif on every line. */
  speechBlip(did: string): void {
    if (this._muted || !this.engine) return
    const ctx = this.engine.ctx
    void deriveLeitmotif(did).then((motif) => {
      const t = ctx.currentTime
      const freq = midiToFreq((motif.notes[0] ?? 72) + 12)
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = motif.instrument === 'triangle' ? 'triangle' : motif.instrument === 'fmbell' ? 'sine' : 'square'
      osc.frequency.setValueAtTime(freq, t)
      osc.frequency.linearRampToValueAtTime(freq * 1.28, t + 0.05)
      gain.gain.setValueAtTime(0.16, t)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.09)
      osc.connect(gain).connect(this.engine!.effectsBus)
      osc.start(t)
      osc.stop(t + 0.11)
    })
  }

  stinger(kind: 'door' | 'mention' | 'lock' | 'portal' | 'spark' | 'jump'): void {
    if (this._muted || !this.engine) return
    const ctx = this.engine.ctx
    const seqs: Record<string, number[]> = {
      door: [72, 79],
      mention: [84, 88, 91],
      lock: [60, 55, 62],
      portal: [60, 64, 67, 72, 76],
      spark: [76, 83, 88, 95],
      jump: [67, 79],
    }
    let t = ctx.currentTime
    for (const midi of seqs[kind]!) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'square'
      osc.frequency.value = midiToFreq(midi)
      gain.gain.setValueAtTime(0.0001, t)
      gain.gain.linearRampToValueAtTime(0.32, t + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.1)
      osc.connect(gain).connect(this.engine.effectsBus)
      osc.start(t)
      osc.stop(t + 0.15)
      t += 0.07
    }
  }

  /** Somebody called your name: their motif is the notification, so you learn
   *  who wants you without reading anything. */
  async mentionStinger(did: string): Promise<void> {
    if (this._muted || !this.engine) return
    const quoted = await this.engine.quote(did, 'mention')
    if (!quoted) this.stinger('mention') // budget said no: fall back to the plain cue
  }
}
