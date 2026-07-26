// Living room music: the world's soundtrack, and how identity enters it.
//
// THE RULE THAT DECIDES EVERYTHING: a room has ONE piece of music. Twenty
// people in a room cannot each play their own tune — that's not a soundtrack,
// it's a crowd of ringtones. So the room owns the bed (key, tempo, harmony,
// groove) and identity enters it as a QUOTE: three to five notes, transposed
// into the room's key, snapped to the room's beat, on a voice reserved for it
// (spec §11.3 layer 5 — "briefly quotes a joining user's deterministic
// leitmotif"). You hear your own tune in full exactly where it's about you: the
// ID app, and the moment you arrive in the world.
//
// WHEN YOU HEAR WHAT
//   your full theme     signing in / spawning (2 bars, then it hands over to
//                       the room), and on the ID app
//   your own motif      when you arrive somewhere; and if you're alone in a
//                       room, your motif becomes the room's melody
//   someone else's      they arrive (quiet, bar-aligned, budgeted) · you open
//   motif               their card (louder — you asked) · they @mention you
//                       (their motif IS your notification, so you know who is
//                       calling without reading)
//   nobody's motif      on every chat line. That's the speech blip, which is
//                       tinted by their motif but is not the motif (spec §30.5:
//                       "avoid constant reaction sounds").
//
// HOW IT STAYS MUSICAL
//   * the bed is rendered ONCE as four stems (base / rhythm / lead / texture)
//     played in sync; MusicState moves their gains, so the room can breathe
//     with activity without ever re-rendering or losing the loop point
//   * quotes are scheduled on the next bar line from the bed's own audio clock,
//     so they land on the beat instead of near it
//   * quotes are re-keyed into the room's scale and the lead stem ducks under
//     them — the melody makes room for the person
//   * a budget (per-person cooldown, a global gap, and a crowd rule) means a
//     busy room stays music instead of becoming a doorbell

import { compose, motifForScale, type Theme } from './index.ts'
import { MOTIF_VOICES, type CanonicalMotif } from './motif.ts'
import { deriveLeitmotif } from '../../shared/src/leitmotif.ts'
import { degreeToMidi, noteToMidi, SCALES } from './theory.ts'
import { renderScore } from './synth.ts'
import { CHANNELS, ticksToSeconds, type Channel, type Score } from './score.ts'
import { mintChiptune } from './mint.ts'
import { toAudioBuffer } from './web.ts'

// --- pure pieces (unit-tested; no audio context needed) ----------------------

/** §11.3's layers, mapped onto the channel budget. */
export const STEMS = {
  base: ['triangle', 'pulse2'], // harmonic bed: bass + harmony
  rhythm: ['noise', 'dpcm'], // percussion
  lead: ['pulse1'], // the melody / conversation layer
  texture: ['aux'], // ambience
} as const satisfies Record<string, readonly Channel[]>

export type StemName = keyof typeof STEMS

export interface MusicStateLike {
  energy: number
  tension: number
  density: number
  brightness: number
}

/** Activity -> stem gains. Bounded and gentle: the bed never disappears and
 *  never doubles; the room leans in and out (spec §11.3 adaptation). */
export function stemGains(state: MusicStateLike | null): Record<StemName, number> {
  const s = state ?? { energy: 0.25, tension: 0.1, density: 0.2, brightness: 0.5 }
  return {
    base: 0.85 + s.brightness * 0.15,
    // drums fade in with activity — an empty room shouldn't have a backbeat
    rhythm: Math.max(0, Math.min(1, (s.energy - 0.12) / 0.45)) * (0.55 + s.density * 0.45),
    // the melody arrives once there's something happening
    lead: Math.max(0.12, Math.min(1, (s.density + s.energy) / 1.1)),
    texture: 0.35 + s.tension * 0.5,
  }
}

/** The audio-clock time of the next bar line of a loop that started at
 *  `startedAt`. Quotes land here, which is why they sound intentional. */
export function nextBarTime(
  now: number, startedAt: number, bpm: number, beatsPerBar = 4, minLead = 0.06,
): number {
  const barSeconds = (beatsPerBar * 60) / bpm
  const elapsed = Math.max(0, now + minLead - startedAt)
  return startedAt + Math.ceil(elapsed / barSeconds) * barSeconds
}

export function nextBeatTime(
  now: number, startedAt: number, bpm: number, minLead = 0.04,
): number {
  const beat = 60 / bpm
  const elapsed = Math.max(0, now + minLead - startedAt)
  return startedAt + Math.ceil(elapsed / beat) * beat
}

/** How much music the visitor wants. Constant loops are fatiguing, and the spec
 *  asks for a focus soundtrack and silence as options (§30.5), so the bed can
 *  rest instead of only being on or off. */
export type MusicMode = 'off' | 'events' | 'activity' | 'always'

export const MUSIC_MODES: { mode: MusicMode; label: string; hint: string }[] = [
  { mode: 'off', label: 'off', hint: 'no room music (motifs and effects still follow their own levels)' },
  { mode: 'events', label: 'moments', hint: 'only around arrivals, mentions and room changes' },
  { mode: 'activity', label: 'breathing', hint: 'swells when the room is alive, rests when it goes quiet' },
  { mode: 'always', label: 'always', hint: 'a continuous loop' },
]

export interface BedOptions {
  /** 'activity': silence after this long with nothing happening */
  restAfterMs?: number
  /** 'events': how long a moment keeps the music up */
  eventWindowMs?: number
}

/** The bed's overall level for a given mode and situation. Separate from the
 *  visitor's music volume: this is the engine deciding whether music belongs
 *  right now, which is what "don't play it all the time" means. */
export function bedGain(
  mode: MusicMode, state: MusicStateLike | null, msSinceEvent: number, opts: BedOptions = {},
): number {
  if (mode === 'off') return 0
  if (mode === 'always') return 1
  const eventWindow = opts.eventWindowMs ?? 22_000
  if (mode === 'events') {
    if (msSinceEvent >= eventWindow) return 0
    // hold, then fade out over the last three seconds of the window
    return Math.min(1, (eventWindow - msSinceEvent) / 3_000)
  }
  // 'activity': a live room keeps the music up; a still one is allowed silence
  const restAfter = opts.restAfterMs ?? 40_000
  const energy = state?.energy ?? 0
  const density = state?.density ?? 0
  const alive = Math.max(energy, density)
  if (msSinceEvent < eventWindow) return 1
  if (alive > 0.25) return 1
  const past = msSinceEvent - eventWindow
  const window = Math.max(1, restAfter - eventWindow)
  return Math.max(0, 1 - past / window)
}

export type QuoteReason = 'arrival' | 'inspect' | 'mention' | 'self' | 'ensemble'

export interface BudgetOptions {
  /** don't quote the same person again within this window */
  cooldownMs?: number
  /** minimum gap between any two quotes */
  gapMs?: number
  /** above this many people, arrivals stop quoting (only direct interaction) */
  crowd?: number
}

/** "Limit identity motifs" (spec §30.5), as a testable object.
 *
 *  Reasons the visitor asked for (inspect, mention) are always allowed and
 *  bypass the crowd rule — silence in response to a deliberate action reads as
 *  a bug. Ambient reasons (arrival) are the ones that need discipline. */
export class MotifBudget {
  private lastByDid = new Map<string, number>()
  private lastAny = -Infinity
  private readonly cooldownMs: number
  private readonly gapMs: number
  private readonly crowd: number

  constructor(opts: BudgetOptions = {}) {
    this.cooldownMs = opts.cooldownMs ?? 45_000
    this.gapMs = opts.gapMs ?? 2_500
    this.crowd = opts.crowd ?? 8
  }

  allow(did: string, reason: QuoteReason, now: number, population = 1): boolean {
    const deliberate = reason === 'inspect' || reason === 'mention'
    if (!deliberate) {
      if (population > this.crowd) return false
      if (now - this.lastAny < this.gapMs) return false
      if (now - (this.lastByDid.get(did) ?? -Infinity) < this.cooldownMs) return false
    } else if (now - (this.lastByDid.get(did) ?? -Infinity) < 1_200) {
      return false // even deliberate actions don't machine-gun
    }
    this.lastByDid.set(did, now)
    this.lastAny = now
    return true
  }

  reset(): void {
    this.lastByDid.clear()
    this.lastAny = -Infinity
  }
}

/** A canonical motif, re-keyed into the room's scale and register.
 *
 *  Without this the quote fights the bed: the leitmotif is authored in its own
 *  absolute pitches (spec §11.5) and the room is in its own key. Contour is
 *  preserved exactly; only the tuning moves. */
export function motifNotesInKey(canon: CanonicalMotif, theme: Theme, octave = 1): number[] {
  const scale = SCALES[theme.scale]
  const root = noteToMidi(theme.key)
  const { degrees } = motifForScale(canon, theme.scale)
  return degrees.map((d) => degreeToMidi(root, scale, d) + octave * 12)
}

/** Build a one-shot Score for a quote, in the room's key and tempo. */
export function quoteScore(canon: CanonicalMotif, theme: Theme, reason: QuoteReason): Score {
  const notes = motifNotesInKey(canon, theme, reason === 'mention' ? 2 : 1)
  const patch = MOTIF_VOICES[canon.instrument].patch
  const { rhythm } = motifForScale(canon, theme.scale)
  const notesOut = []
  let t = 0
  for (let i = 0; i < notes.length; i++) {
    const dur = Math.max(6, (rhythm[i] ?? 4) * 12) // 16th units -> ticks
    notesOut.push({
      ch: 'pulse1' as Channel,
      patch,
      t,
      dur: Math.max(12, dur - 4),
      midi: notes[i]!,
      vel: i === 0 ? 1 : 0.88,
    })
    t += dur
  }
  return {
    id: `quote:${canon.did}:${reason}`,
    name: 'leitmotif quote',
    bpm: theme.bpm,
    meter: theme.meter,
    length: t,
    notes: notesOut,
  }
}

/** Split a composed score into the four stems. Each note is rendered exactly
 *  once overall, so four stems cost the same synthesis as one mixdown. */
export function splitStems(score: Score): Record<StemName, Score> {
  const out = {} as Record<StemName, Score>
  for (const [name, channels] of Object.entries(STEMS) as [StemName, readonly Channel[]][]) {
    out[name] = { ...score, notes: score.notes.filter((n) => channels.includes(n.ch)) }
  }
  return out
}

// --- the live engine --------------------------------------------------------

/** Emitted whenever the music says something about somebody, so the interface
 *  can show whose theme you're hearing. */
export interface Cue {
  kind: 'bed' | 'quote' | 'own' | 'ensemble' | 'rest'
  /** whose motif, when it's a person */
  did?: string
  dids?: string[]
  reason?: QuoteReason
  /** human-readable: a room name, or a person's motif */
  name: string
  seconds: number
  /** audio-clock time it starts (may be slightly in the future: bar-aligned) */
  at: number
}

export interface RoomMusicOptions {
  /** bars of bed to render; shorter = less memory, which matters on phones */
  bars?: number
  /** stems are rendered at this rate and resampled by the browser; chip audio
   *  has almost nothing above 11 kHz, so 24 kHz saves half the memory */
  sampleRate?: number
  budget?: BudgetOptions
}

interface Playing {
  sources: AudioBufferSourceNode[]
  gains: Record<StemName, GainNode>
  startedAt: number
  theme: Theme
  loopSeconds: number
}

export class RoomMusic {
  readonly ctx: AudioContext
  /** separate buses, because the spec requires separate mutes (§26) */
  readonly musicBus: GainNode
  readonly motifBus: GainNode
  readonly effectsBus: GainNode

  private current?: Playing
  private state: MusicStateLike | null = null
  private budget: MotifBudget
  private opts: RoomMusicOptions
  private population = 1
  private selfDid: string | null = null
  private selfLoop: number | null = null
  private stemCache = new Map<string, Record<StemName, AudioBuffer>>()
  private mode: MusicMode = 'activity'
  private lastEventAt = 0
  private restTimer: number | null = null
  /** whether the bed is currently resting, so wake/rest is announced once and
   *  not re-announced on every ramp while a fade is still in progress */
  private resting = false
  private bedGainNode: GainNode
  private listeners: ((cue: Cue) => void)[] = []

  constructor(ctx?: AudioContext, opts: RoomMusicOptions = {}) {
    const Ctor: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    this.ctx = ctx ?? new Ctor()
    this.opts = opts
    this.budget = new MotifBudget(opts.budget)
    this.musicBus = this.ctx.createGain()
    this.motifBus = this.ctx.createGain()
    this.effectsBus = this.ctx.createGain()
    // restrained by default (spec §30.5)
    this.musicBus.gain.value = 0.5
    this.motifBus.gain.value = 0.75
    this.effectsBus.gain.value = 0.6
    for (const bus of [this.musicBus, this.motifBus, this.effectsBus]) bus.connect(this.ctx.destination)
    // the mode/rest level sits between the stems and the visitor's music level,
    // so "the room is quiet right now" and "I like music at 40%" don't fight
    this.bedGainNode = this.ctx.createGain()
    this.bedGainNode.gain.value = 1
    this.bedGainNode.connect(this.musicBus)
    this.lastEventAt = Date.now()
  }

  /** MUST be called synchronously inside a user gesture (see web.ts — iOS only
   *  honours resume() while the gesture is on the stack). */
  unlock(): void {
    const nav = navigator as unknown as { audioSession?: { type: string } }
    try {
      if (nav.audioSession) nav.audioSession.type = 'playback'
    } catch {
      /* older Safari: the ring/silent switch wins, nothing to do */
    }
    void this.ctx.resume()
    const src = this.ctx.createBufferSource()
    src.buffer = this.ctx.createBuffer(1, 1, this.ctx.sampleRate)
    src.connect(this.ctx.destination)
    src.start(0)
  }

  get running(): boolean {
    return this.ctx.state === 'running'
  }

  /** Where the bed is, for anything that wants to move in time with it. */
  get position(): { beats: number; bars: number } | null {
    if (!this.current || !this.running) return null
    const elapsed = this.ctx.currentTime - this.current.startedAt
    const beats = (elapsed * this.current.theme.bpm) / 60
    return { beats, bars: beats / this.current.theme.meter[0] }
  }

  onCue(fn: (cue: Cue) => void): () => void {
    this.listeners.push(fn)
    return () => {
      this.listeners = this.listeners.filter((f) => f !== fn)
    }
  }

  private emit(cue: Cue): void {
    for (const fn of this.listeners) {
      try {
        fn(cue)
      } catch {
        /* a broken listener must not take the music down */
      }
    }
  }

  setMode(mode: MusicMode): void {
    this.mode = mode
    this.noteActivity() // a deliberate change counts as a moment
    this.applyBedGain(0.4)
  }

  getMode(): MusicMode {
    return this.mode
  }

  /** Something happened in the room (someone spoke, arrived, you changed rooms).
   *  In 'events' and 'activity' modes this is what brings the music up. */
  noteActivity(): void {
    this.lastEventAt = Date.now()
    this.applyBedGain(0.5)
  }

  private applyBedGain(fade = 1.5): void {
    const target = bedGain(this.mode, this.state, Date.now() - this.lastEventAt)
    const now = this.ctx.currentTime
    const prev = this.bedGainNode.gain.value
    this.bedGainNode.gain.cancelScheduledValues(now)
    this.bedGainNode.gain.setValueAtTime(prev, now)
    this.bedGainNode.gain.linearRampToValueAtTime(target, now + fade)
    // announce the TRANSITION, not the ramp: reading the live gain value mid-fade
    // re-announced the room every couple of seconds and stamped on cues that
    // matter more (like "your theme")
    const nowResting = target <= 0.02
    if (nowResting !== this.resting) {
      this.resting = nowResting
      if (nowResting) this.emit({ kind: 'rest', name: 'the room goes quiet', seconds: fade, at: now })
      else if (this.current) this.emit({ kind: 'bed', name: this.current.theme.name, seconds: 0, at: now })
    }
  }

  private startRestTicker(): void {
    if (this.restTimer !== null) return
    // one slow tick; the ramps do the actual work
    this.restTimer = window.setInterval(() => this.applyBedGain(2.5), 2_000)
  }

  setVolumes(v: { music?: number; motifs?: number; effects?: number }): void {
    const t = this.ctx.currentTime
    if (v.music !== undefined) this.musicBus.gain.setTargetAtTime(v.music, t, 0.05)
    if (v.motifs !== undefined) this.motifBus.gain.setTargetAtTime(v.motifs, t, 0.05)
    if (v.effects !== undefined) this.effectsBus.gain.setTargetAtTime(v.effects, t, 0.05)
  }

  private stems(theme: Theme): Record<StemName, AudioBuffer> {
    const key = JSON.stringify(theme)
    let cached = this.stemCache.get(key)
    if (cached) return cached
    const bars = this.opts.bars ?? 16
    const score = compose({ ...theme, bars })
    const sampleRate = Math.min(this.ctx.sampleRate, this.opts.sampleRate ?? 24_000)
    const split = splitStems(score)
    cached = {} as Record<StemName, AudioBuffer>
    for (const name of Object.keys(STEMS) as StemName[]) {
      cached[name] = toAudioBuffer(
        renderScore(split[name], { loop: true, sampleRate, tail: 1.5 }),
        this.ctx,
      )
    }
    this.stemCache.set(key, cached)
    if (this.stemCache.size > 8) this.stemCache.delete(this.stemCache.keys().next().value!)
    return cached
  }

  /** Cross-fade into a room's cue. */
  enterRoom(theme: Theme, fade = 0.8): void {
    if (this.ctx.state === 'suspended') void this.ctx.resume()
    // the world re-sends the room on every roster change; restarting the bed
    // each time would crossfade over itself and reset the motif budget
    if (this.current && JSON.stringify(this.current.theme) === JSON.stringify(theme)) return
    const buffers = this.stems(theme)
    this.stop(fade)

    const t = this.ctx.currentTime + 0.05
    const targets = stemGains(this.state)
    const gains = {} as Record<StemName, GainNode>
    const sources: AudioBufferSourceNode[] = []
    for (const name of Object.keys(STEMS) as StemName[]) {
      const gain = this.ctx.createGain()
      gain.gain.setValueAtTime(0, t)
      gain.gain.linearRampToValueAtTime(targets[name], t + fade)
      gain.connect(this.bedGainNode)
      const src = this.ctx.createBufferSource()
      src.buffer = buffers[name]
      src.loop = true
      src.connect(gain)
      src.start(t)
      sources.push(src)
      gains[name] = gain
    }
    this.current = {
      sources,
      gains,
      startedAt: t,
      theme,
      loopSeconds: buffers.base.duration,
    }
    this.budget.reset()
    this.applySelfLoop()
    this.resting = false
    this.applyBedGain(0.6)
    this.startRestTicker()
    this.emit({ kind: 'bed', name: theme.name, seconds: 0, at: t })
  }

  stop(fade = 0.4): void {
    const cur = this.current
    if (!cur) return
    const t = this.ctx.currentTime
    for (const name of Object.keys(cur.gains) as StemName[]) {
      const g = cur.gains[name].gain
      g.cancelScheduledValues(t)
      g.setValueAtTime(g.value, t)
      g.linearRampToValueAtTime(0, t + fade)
    }
    for (const s of cur.sources) s.stop(t + fade + 0.05)
    this.current = undefined
    if (this.selfLoop !== null) {
      clearInterval(this.selfLoop)
      this.selfLoop = null
    }
    if (this.restTimer !== null) {
      clearInterval(this.restTimer)
      this.restTimer = null
    }
  }

  /** Server-computed MusicState (spec §11.2) moves the layer gains. */
  setMusicState(state: MusicStateLike): void {
    this.state = state
    this.applyBedGain(3)
    const cur = this.current
    if (!cur) return
    const targets = stemGains(state)
    const t = this.ctx.currentTime
    for (const name of Object.keys(STEMS) as StemName[]) {
      cur.gains[name].gain.setTargetAtTime(targets[name], t, 1.2) // slow: no pumping
    }
  }

  /** Who I am, and how many of us are here — together these decide whether the
   *  room's melody is the room's or mine. */
  setIdentity(did: string | null): void {
    this.selfDid = did
    this.applySelfLoop()
  }

  setPopulation(n: number): void {
    const was = this.population
    this.population = n
    if ((was <= 1) !== (n <= 1)) this.applySelfLoop()
  }

  /** Alone in a room: your motif becomes the melody, every four bars, with the
   *  room's own lead ducked under it. The world sounds like you when there's
   *  nobody to sound like. */
  private applySelfLoop(): void {
    if (this.selfLoop !== null) {
      clearInterval(this.selfLoop)
      this.selfLoop = null
    }
    const cur = this.current
    if (!cur) return
    const alone = this.population <= 1 && this.selfDid
    const t = this.ctx.currentTime
    cur.gains.lead.gain.setTargetAtTime(
      alone ? stemGains(this.state).lead * 0.25 : stemGains(this.state).lead, t, 1.5,
    )
    if (!alone) return
    const barSeconds = (cur.theme.meter[0] * 60) / cur.theme.bpm
    // deliberately NOT fired straight away: arriving already plays your theme,
    // and stacking your motif on top of it is the room shouting at you
    this.selfLoop = window.setInterval(
      () => void this.quote(this.selfDid!, 'self'),
      barSeconds * 4000,
    )
  }

  /**
   * Quote somebody's leitmotif into the room's music.
   * Returns false when the budget refused it — callers can fall back to a
   * non-musical cue (a blip, a visual) instead of stacking sound.
   */
  async quote(did: string, reason: QuoteReason = 'arrival'): Promise<boolean> {
    const cur = this.current
    if (!cur || !this.running) return false
    if (reason !== 'self' && !this.budget.allow(did, reason, Date.now(), this.population)) return false

    const canon = await deriveLeitmotif(did)
    const score = quoteScore(canon, cur.theme, reason)
    const buffer = toAudioBuffer(
      renderScore(score, { loop: false, tail: 0.8, sampleRate: Math.min(this.ctx.sampleRate, 24_000) }),
      this.ctx,
    )
    // deliberate reasons answer on the next beat (responsive); ambient ones wait
    // for the bar line (musical)
    const when = reason === 'mention' || reason === 'inspect'
      ? nextBeatTime(this.ctx.currentTime, cur.startedAt, cur.theme.bpm)
      : nextBarTime(this.ctx.currentTime, cur.startedAt, cur.theme.bpm, cur.theme.meter[0])

    const gain = this.ctx.createGain()
    gain.gain.value = reason === 'arrival' ? 0.5 : reason === 'self' ? 0.42 : 0.8
    const src = this.ctx.createBufferSource()
    src.buffer = buffer
    src.connect(gain).connect(this.motifBus)
    src.start(when)
    if (reason !== 'self') this.noteActivity()
    this.emit({
      kind: reason === 'self' ? 'own' : 'quote',
      did,
      reason,
      name: canon.notes.length + ' notes',
      seconds: buffer.duration,
      at: when,
    })

    // duck the room's melody so the person is heard as the melody
    if (reason !== 'self') {
      const lead = cur.gains.lead.gain
      const target = stemGains(this.state).lead
      lead.cancelScheduledValues(when)
      lead.setTargetAtTime(target * 0.35, when, 0.08)
      lead.setTargetAtTime(target, when + buffer.duration * 0.7, 0.35)
    }
    return true
  }

  /** People standing together: their motifs enter as a staggered canon, all in
   *  the room's key so it reads as one piece of music (spec §11.3). */
  async ensemble(dids: string[]): Promise<boolean> {
    const cur = this.current
    if (!cur || !this.running || dids.length < 2) return false
    if (!this.budget.allow(`ensemble:${dids.join(',')}`, 'ensemble', Date.now(), this.population)) return false
    const beat = 60 / cur.theme.bpm
    const start = nextBarTime(this.ctx.currentTime, cur.startedAt, cur.theme.bpm, cur.theme.meter[0])
    const voices: CanonicalMotif[] = await Promise.all(dids.slice(0, 4).map((d) => deriveLeitmotif(d)))
    voices.forEach((canon, i) => {
      const score = quoteScore(canon, cur.theme, 'ensemble')
      const buffer = toAudioBuffer(
        renderScore(score, { loop: false, tail: 0.6, sampleRate: Math.min(this.ctx.sampleRate, 24_000) }),
        this.ctx,
      )
      const gain = this.ctx.createGain()
      gain.gain.value = 0.34
      const src = this.ctx.createBufferSource()
      src.buffer = buffer
      src.connect(gain).connect(this.motifBus)
      src.start(start + i * beat) // canon-style staggered entries
    })
    this.emit({
      kind: 'ensemble',
      dids: dids.slice(0, 4),
      name: `${Math.min(4, dids.length)} motifs`,
      seconds: 2 + dids.length * (beat as number),
      at: start,
    })
    return true
  }

  /** The one time you hear your own tune in full: arriving in the world. It
   *  plays over the room's bed for a couple of bars and then hands over. */
  async ownTheme(did: string, bars = 4): Promise<void> {
    if (this.ctx.state === 'suspended') void this.ctx.resume()
    const minted = await mintChiptune(did, bars)
    const score = compose(minted.theme)
    const buffer = toAudioBuffer(
      renderScore(score, { loop: false, tail: 1.2, sampleRate: Math.min(this.ctx.sampleRate, 24_000) }),
      this.ctx,
    )
    const t = this.ctx.currentTime + 0.05
    const gain = this.ctx.createGain()
    gain.gain.value = 0.9
    const src = this.ctx.createBufferSource()
    src.buffer = buffer
    src.connect(gain).connect(this.motifBus)
    src.start(t)
    this.emit({ kind: 'own', did, name: minted.theme.name, seconds: buffer.duration, at: t })
    // the room ducks out of the way, then comes back up
    const cur = this.current
    if (cur) {
      const seconds = ticksToSeconds(score.length, score.bpm)
      for (const name of Object.keys(STEMS) as StemName[]) {
        const g = cur.gains[name].gain
        const target = stemGains(this.state)[name]
        g.cancelScheduledValues(t)
        g.setTargetAtTime(target * 0.25, t, 0.15)
        g.setTargetAtTime(target, t + seconds * 0.8, 0.6)
      }
    }
  }
}
