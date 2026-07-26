// The six launch-room themes from the vision doc (§11.7). Each one is a data
// description; compose() turns it into notes.

import type { Theme } from './compose.ts'
import { rngFromString } from './seed.ts'

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

export const STATION: Theme = {
  id: 'station',
  name: 'The Station',
  bpm: 112,
  meter: [4, 4],
  key: 'B3',
  scale: 'mixolydian',
  // departures and arrivals: a cycle that never quite settles
  progression: [
    { degree: 0, quality: 'sus2' },
    { degree: 6, quality: 'triad' },
    { degree: 3, quality: 'triad' },
    { degree: 4, quality: 'sus4' },
  ],
  bass: 'pulse',
  harmony: 'arp',
  drums: 'straight',
  lead: { patch: 'lead.pulse25', density: 0.55, rest: 0.22, octave: 1 },
  bars: 32,
}

export const OUTSKIRTS: Theme = {
  id: 'outskirts',
  name: 'The Outskirts',
  bpm: 100,
  meter: [4, 4],
  key: 'D3',
  scale: 'minorPentatonic',
  progression: [
    { degree: 0, quality: 'power', bars: 2 },
    { degree: 4, quality: 'power' },
    { degree: 3, quality: 'power' },
  ],
  bass: 'walking',
  harmony: 'arp-down',
  drums: 'sparse',
  texture: 'wind',
  lead: { patch: 'lead.pulse125', density: 0.3, rest: 0.38, octave: 1, shape: 'fall' },
  bars: 16,
}

export const THEATER: Theme = {
  id: 'theater',
  name: 'The Theater',
  bpm: 116,
  meter: [4, 4],
  key: 'C4',
  scale: 'major',
  // curtain-up harmony: bold, resolved, a little theatrical
  progression: [
    { degree: 0, quality: 'triad' },
    { degree: 3, quality: 'triad' },
    { degree: 4, quality: 'seventh' },
    { degree: 0, quality: 'sixth' },
  ],
  bass: 'root5',
  harmony: 'stab',
  drums: 'four',
  lead: { patch: 'lead.pulse25', density: 0.6, rest: 0.2, octave: 1, shape: 'arch' },
  bars: 32,
}

export const GARDEN: Theme = {
  id: 'garden',
  name: 'The Garden',
  bpm: 84,
  meter: [4, 4],
  key: 'F4',
  scale: 'lydian',
  progression: [
    { degree: 0, quality: 'sus2', bars: 2 },
    { degree: 3, quality: 'triad' },
    { degree: 1, quality: 'triad' },
  ],
  bass: 'sparse',
  harmony: 'arp',
  drums: 'sparse',
  texture: 'wind',
  lead: { patch: 'lead.pulse50', density: 0.32, rest: 0.35, octave: 1 },
  bars: 16,
}

export const THEMES: Record<string, Theme> = {
  plaza: PLAZA,
  workshop: WORKSHOP,
  laboratory: LABORATORY,
  library: LIBRARY,
  club: CLUB,
  vault: VAULT,
  station: STATION,
  outskirts: OUTSKIRTS,
  theater: THEATER,
  garden: GARDEN,
}

/** Every RoomTemplate the live world can classify a channel into (spec
 *  §11.7 / shared/src/protocol.ts) resolves to an authored theme. Aliases share
 *  a theme where the rooms share a mood; the tempo comes from the world. */
const TEMPLATE_THEMES: Record<string, string> = {
  plaza: 'plaza',
  workshop: 'workshop',
  club: 'club',
  library: 'library',
  laboratory: 'laboratory',
  vault: 'vault',
  theater: 'theater',
  garden: 'garden',
  office: 'workshop', // mechanical, focused
  classroom: 'library', // sparse, attentive
  lounge: 'plaza', // bright and social
  'train car': 'station',
  'dungeon chamber': 'vault',
  'empty tile grid': 'outskirts',
  // the older static world names its cues differently
  lab: 'laboratory',
  station: 'station',
  outskirts: 'outskirts',
}

/** The world names each room's music by cue (`plaza_108bpm`, spec §11.7 /
 *  shared/src/world.ts). Authored themes win; anything unknown still gets its
 *  own consistent music, derived from the cue name, so a new room is never
 *  silent. The server's bpm always wins — the world decides the tempo. */
export function themeForCue(cue: string, bpm?: number, channel?: string): Theme {
  // cues look like 'plaza_108bpm' (static world) or 'train car_live' (live world,
  // `${template}_live`), so strip either suffix before looking the template up
  const id = cue.replace(/_(live|\d+bpm)$/, '').trim().toLowerCase()
  const authored = THEMES[TEMPLATE_THEMES[id] ?? id]
  if (authored) return bpm && bpm !== authored.bpm ? { ...authored, bpm } : authored

  // derived fallback: deterministic in the cue name, so the room sounds the
  // same for everybody, every visit
  const rng = rngFromString(`room:${cue}:${channel ?? ''}`)
  const keys = ['C', 'D', 'E', 'F', 'G', 'A', 'B']
  const modes: Theme['scale'][] = ['major', 'minor', 'dorian', 'mixolydian', 'lydian', 'minorPentatonic']
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!
  return {
    id,
    name: cue,
    bpm: bpm ?? 108,
    meter: [4, 4],
    key: `${pick(keys)}${rng() < 0.5 ? 3 : 4}`,
    scale: pick(modes),
    progression: [{ degree: 0 }, { degree: 5 }, { degree: 3 }, { degree: 4 }],
    bass: pick(['walking', 'pulse', 'root5', 'ostinato'] as const),
    harmony: pick(['arp', 'arp-down', 'stab', 'chord'] as const),
    drums: pick(['straight', 'four', 'mechanical', 'sparse'] as const),
    lead: { patch: pick(['lead.pulse25', 'lead.pulse125', 'lead.pulse50'] as const), density: 0.45, rest: 0.25, octave: 1 },
    bars: 16,
  }
}

export function getTheme(id: string): Theme {
  const t = THEMES[id]
  if (!t) throw new Error(`unknown theme: ${id} (have ${Object.keys(THEMES).join(', ')})`)
  return t
}
