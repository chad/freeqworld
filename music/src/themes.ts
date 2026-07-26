// The six launch-room themes from the vision doc (§11.7). Each one is a data
// description; compose() turns it into notes.

import type { Theme } from './compose.ts'

export const PLAZA: Theme = {
  id: 'plaza',
  name: 'The Plaza',
  bpm: 108,
  meter: [4, 4],
  key: 'D4',
  scale: 'major',
  // bright suspended harmony: Isus2 – V – vi – IV
  progression: [
    { degree: 0, quality: 'sus2' },
    { degree: 4, quality: 'triad' },
    { degree: 5, quality: 'triad' },
    { degree: 3, quality: 'sus2' },
  ],
  bass: 'walking',
  harmony: 'arp',
  drums: 'straight',
  lead: { patch: 'lead.pulse25', density: 0.62, rest: 0.16, octave: 1 },
  bars: 32,
}

export const WORKSHOP: Theme = {
  id: 'workshop',
  name: 'The Workshop',
  bpm: 92,
  meter: [4, 4],
  // irregular five-beat insert every eight measures
  insert: { everyBars: 8, meter: [5, 4] },
  key: 'A3',
  scale: 'dorian',
  progression: [
    { degree: 0, quality: 'triad', bars: 2 },
    { degree: 6, quality: 'triad' },
    { degree: 3, quality: 'triad' },
  ],
  bass: 'ostinato',
  harmony: 'stab',
  drums: 'mechanical',
  lead: { patch: 'lead.pulse125', density: 0.45, rest: 0.3, octave: 1 },
  bars: 32,
}

export const LABORATORY: Theme = {
  id: 'laboratory',
  name: 'The Agent Laboratory',
  bpm: 118,
  meter: [4, 4],
  key: 'F4',
  scale: 'lydian',
  progression: [
    { degree: 0, quality: 'seventh' },
    { degree: 1, quality: 'seventh' },
    { degree: 5, quality: 'seventh' },
    { degree: 4, quality: 'sus4' },
  ],
  bass: 'pulse',
  harmony: 'arp',
  drums: 'four',
  lead: { patch: 'lead.bell', density: 0.6, rest: 0.35, octave: 1 },
  bars: 32,
}

export const LIBRARY: Theme = {
  id: 'library',
  name: 'The Library',
  bpm: 72,
  meter: [4, 4],
  key: 'G3',
  scale: 'minor',
  progression: [
    { degree: 0, quality: 'triad', bars: 2 },
    { degree: 5, quality: 'triad', bars: 2 },
  ],
  bass: 'sparse',
  harmony: 'pad',
  drums: 'sparse',
  texture: 'wind',
  lead: { patch: 'lead.pulse50', density: 0.22, rest: 0.4, octave: 1, shape: 'fall' },
  bars: 16,
}

export const CLUB: Theme = {
  id: 'club',
  name: 'The Club',
  bpm: 126,
  meter: [4, 4],
  key: 'C4',
  scale: 'dorian',
  // stable cycle underneath, angular voicings on top
  progression: [
    { degree: 0, quality: 'seventh', bars: 2 },
    { degree: 3, quality: 'ninth' },
    { degree: 4, quality: 'seventh' },
  ],
  bass: 'funk',
  harmony: 'stab',
  drums: 'breaks',
  lead: { patch: 'lead.pwm', density: 0.85, rest: 0.3, octave: 1 },
  bars: 32,
}

export const VAULT: Theme = {
  id: 'vault',
  name: 'The Encrypted Vault',
  bpm: 64,
  meter: [4, 4],
  key: 'E3',
  scale: 'phrygian',
  progression: [
    { degree: 0, quality: 'power', bars: 2 },
    { degree: 1, quality: 'power', bars: 2 },
  ],
  bass: 'pulse',
  harmony: 'chord',
  drums: 'sparse',
  lead: { patch: 'lead.pulse50', density: 0.3, rest: 0.4, octave: 1 },
  bars: 16,
}

export const THEMES: Record<string, Theme> = {
  plaza: PLAZA,
  workshop: WORKSHOP,
  laboratory: LABORATORY,
  library: LIBRARY,
  club: CLUB,
  vault: VAULT,
}

export function getTheme(id: string): Theme {
  const t = THEMES[id]
  if (!t) throw new Error(`unknown theme: ${id} (have ${Object.keys(THEMES).join(', ')})`)
  return t
}
