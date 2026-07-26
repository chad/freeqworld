// A Score is the intermediate representation the composer emits and the synth
// renders. Time is in ticks so composition stays integer-exact; the renderer
// converts to seconds with the score's bpm.

export const TPQ = 48 // ticks per quarter note (divisible by 2,3,4,6,8,16)

/** NES-shaped channel budget: 2 pulse, 1 triangle, 1 noise, 1 sample slot,
 *  plus one expansion-style `aux` slot used only for ambient beds. */
export type Channel = 'pulse1' | 'pulse2' | 'triangle' | 'noise' | 'dpcm' | 'aux'

export const CHANNELS: Channel[] = ['pulse1', 'pulse2', 'triangle', 'noise', 'dpcm', 'aux']

export interface Note {
  ch: Channel
  /** patch name, see instruments.ts */
  patch: string
  t: number // start, ticks
  dur: number // ticks
  /** MIDI note. For noise/dpcm patches this selects the drum pitch/period. */
  midi: number
  /** 0..1 */
  vel?: number
  /** semitone offsets cycled at ~60Hz — the classic chiptune "chord on one channel" */
  arp?: number[]
  /** glide from this many semitones away into `midi` */
  slide?: number
}

export interface Score {
  id: string
  name: string
  bpm: number
  /** [beats per bar, beat unit] */
  meter: [number, number]
  /** total length in ticks (the loop point) */
  length: number
  notes: Note[]
}

export function ticksPerBar(meter: [number, number]): number {
  return Math.round((meter[0] * TPQ * 4) / meter[1])
}

export function ticksToSeconds(ticks: number, bpm: number): number {
  return (ticks / TPQ) * (60 / bpm)
}

/** Channels are monophonic on real hardware: later notes cut earlier ones. */
export function monophonize(notes: Note[]): Note[] {
  const out: Note[] = []
  for (const ch of CHANNELS) {
    const lane = notes.filter((n) => n.ch === ch).sort((a, b) => a.t - b.t || a.midi - b.midi)
    for (let i = 0; i < lane.length; i++) {
      const n = { ...lane[i]! }
      const next = lane[i + 1]
      if (next && n.t + n.dur > next.t) n.dur = Math.max(1, next.t - n.t)
      if (next && next.t === n.t) continue // dropped: hardware can only sound one
      out.push(n)
    }
  }
  return out.sort((a, b) => a.t - b.t)
}
