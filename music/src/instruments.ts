// Instrument patches. Deliberately close to what a 2A03 (NES) can actually do:
// square waves with a handful of duties, a quantised triangle, an LFSR noise
// channel, plus one "sample" slot we use for the kick. The FM bell is the one
// luxury (think Genesis/adlib) and is only used by the Agent Laboratory theme.

export interface Patch {
  wave: 'pulse' | 'triangle' | 'noise' | 'fm' | 'sine'
  /** pulse width 0..1 (0.125 / 0.25 / 0.5 are the classic three) */
  duty?: number
  /** duty sequence stepped at 60 Hz (PWM-ish shimmer) */
  dutySeq?: number[]
  gain: number
  /** seconds */
  attack?: number
  decay?: number
  sustain?: number
  release?: number
  /** 16-step-ish volume table stepped at 60 Hz; overrides decay/sustain */
  volSeq?: number[]
  vibrato?: { rate: number; depth: number; delay: number }
  /** downward (positive) pitch blip in semitones, for drums */
  pitchEnv?: { amount: number; time: number }
  /** noise LFSR mode: short = tonal/metallic, long = hiss */
  noiseMode?: 'short' | 'long'
  /** FM only */
  fm?: { ratio: number; index: number; decay: number }
  /** cents of detune, gives a slightly wide/analogue feel when layered */
  detune?: number
}

export const PATCHES: Record<string, Patch> = {
  // ---- leads -------------------------------------------------------------
  'lead.pulse25': {
    wave: 'pulse', duty: 0.25, gain: 0.5,
    attack: 0.002, decay: 0.1, sustain: 0.72, release: 0.05,
    vibrato: { rate: 5.5, depth: 0.16, delay: 0.18 },
  },
  'lead.pulse125': {
    wave: 'pulse', duty: 0.125, gain: 0.46,
    attack: 0.001, decay: 0.08, sustain: 0.66, release: 0.04,
    vibrato: { rate: 6.2, depth: 0.2, delay: 0.14 },
  },
  'lead.pulse50': {
    wave: 'pulse', duty: 0.5, gain: 0.44,
    attack: 0.004, decay: 0.14, sustain: 0.78, release: 0.06,
    vibrato: { rate: 4.8, depth: 0.13, delay: 0.22 },
  },
  'lead.pwm': {
    wave: 'pulse', gain: 0.46, dutySeq: [0.125, 0.18, 0.25, 0.35, 0.5, 0.35, 0.25, 0.18],
    attack: 0.002, decay: 0.12, sustain: 0.7, release: 0.05,
    vibrato: { rate: 5, depth: 0.15, delay: 0.2 },
  },
  'lead.tri': {
    wave: 'triangle', gain: 0.6,
    attack: 0.004, decay: 0.12, sustain: 0.8, release: 0.06,
    vibrato: { rate: 5, depth: 0.14, delay: 0.2 },
  },
  'lead.bell': {
    wave: 'fm', gain: 0.38, attack: 0.001, decay: 0.5, sustain: 0.12, release: 0.25,
    fm: { ratio: 3.01, index: 6, decay: 0.22 },
  },

  // ---- harmony / arps ----------------------------------------------------
  'arp.pulse125': {
    wave: 'pulse', duty: 0.125, gain: 0.26,
    attack: 0.001, decay: 0.05, sustain: 0.35, release: 0.02,
  },
  'arp.pulse25': {
    wave: 'pulse', duty: 0.25, gain: 0.24,
    attack: 0.001, decay: 0.06, sustain: 0.4, release: 0.02,
  },
  'pad.pulse50': {
    wave: 'pulse', duty: 0.5, gain: 0.17,
    attack: 0.03, decay: 0.2, sustain: 0.85, release: 0.12,
  },
  'stab.pulse25': {
    wave: 'pulse', duty: 0.25, gain: 0.3,
    volSeq: [1, 0.95, 0.7, 0.5, 0.35, 0.22, 0.12, 0.05], release: 0.02,
  },

  // ---- bass --------------------------------------------------------------
  'bass.tri': {
    wave: 'triangle', gain: 0.85,
    attack: 0.003, decay: 0.05, sustain: 0.95, release: 0.03,
  },
  'bass.pulse': {
    wave: 'pulse', duty: 0.5, gain: 0.4,
    attack: 0.002, decay: 0.09, sustain: 0.6, release: 0.03,
  },

  // ---- drums -------------------------------------------------------------
  kick: {
    wave: 'pulse', duty: 0.5, gain: 0.75,
    volSeq: [1, 1, 0.8, 0.55, 0.3, 0.12], release: 0.01,
    pitchEnv: { amount: 34, time: 0.05 },
  },
  snare: {
    wave: 'noise', noiseMode: 'long', gain: 0.42,
    volSeq: [1, 0.9, 0.6, 0.4, 0.25, 0.15, 0.08, 0.03], release: 0.01,
  },
  hat: {
    wave: 'noise', noiseMode: 'long', gain: 0.16,
    volSeq: [1, 0.4, 0.12], release: 0.005,
  },
  'hat.open': {
    wave: 'noise', noiseMode: 'long', gain: 0.15,
    volSeq: [1, 0.8, 0.6, 0.45, 0.3, 0.2, 0.12, 0.06], release: 0.02,
  },
  clank: {
    wave: 'noise', noiseMode: 'short', gain: 0.3,
    volSeq: [1, 0.7, 0.45, 0.25, 0.12], release: 0.01,
  },
  wind: {
    wave: 'noise', noiseMode: 'long', gain: 0.07,
    attack: 0.4, decay: 0.3, sustain: 0.6, release: 0.5,
  },
}

export function patch(name: string): Patch {
  const p = PATCHES[name]
  if (!p) throw new Error(`unknown patch: ${name}`)
  return p
}
