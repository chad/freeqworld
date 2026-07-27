// Familiars: the small creature a Handler (level 12) dispatches into a room.
//
// Derived from the owner's DID the same way everything else here is —
// HKDF-SHA256 with its OWN info string, so it is a separate domain from the
// avatar and the leitmotif. `shared/src/avatar.ts` and `shared/src/leitmotif.ts`
// are frozen conformance fixtures and must not be touched; this file gets its
// own fixtures (familiar.test.ts) and should be treated as frozen once shipped,
// because changing a species or a name silently re-homes somebody's pet.
//
// canonical_seed = HKDF-SHA256(ikm=DID, salt="freeq-world-familiar", info="familiar-v1")

import { hkdfSha256, pick, seededPrng } from './hkdf'

/** Species that read at 8×8 pixels. Kept small on purpose: a familiar has to be
 *  recognisable as a *kind* of thing at a glance, in one frame, in a dark room. */
export const SPECIES = ['wisp', 'moth', 'cat', 'crow', 'newt', 'snail'] as const
export type Species = (typeof SPECIES)[number]

/** Two-syllable pronounceable names, built from parts rather than a word list so
 *  the space is large without shipping a dictionary. */
const ONSET = ['m', 'p', 't', 'k', 'r', 's', 'n', 'l', 'v', 'b', 'f', 'th'] as const
const NUCLEUS = ['a', 'e', 'i', 'o', 'u', 'ai', 'ir', 'or'] as const
const CODA = ['', '', '', 'n', 'k', 'l', 'r', 's'] as const

/** Accent colours, drawn from the same family as avatar accents so a familiar
 *  looks like it belongs to its owner without copying their palette exactly. */
const GLOWS = ['#ffd166', '#06d6a0', '#ef476f', '#118ab2', '#f78c6b', '#9b5de5', '#67c26b', '#56c9d6'] as const

export interface Familiar {
  schema: 'freeq.at/world/familiar/v1'
  /** the DID this familiar belongs to */
  owner: string
  base_generator: 'familiar-v1'
  canonical_seed_hex: string
  species: Species
  /** the derived given name, e.g. "mira" */
  name: string
  /** primary body colour */
  colour: string
  /** the glow it casts, and its accent */
  glow: string
  /** how it moves: affects the idle bob and follow distance */
  gait: 'drift' | 'hop' | 'pad' | 'flit'
}

export async function familiarSeed(owner: string): Promise<Uint8Array> {
  return hkdfSha256(owner, 'freeq-world-familiar', 'familiar-v1', 32)
}

/** Two syllables, always consonant-initial, so it is always pronounceable.
 *  A diphthong takes no coda — "vosirs" and "bibaik" are what happens when it
 *  does, and a pet's name has to be sayable out loud. */
function syllables(rng: () => number): string {
  const a = `${pick(rng, ONSET)}${pick(rng, NUCLEUS)}`
  const nucleus = pick(rng, NUCLEUS)
  const coda = nucleus.length > 1 ? '' : pick(rng, CODA)
  return `${a}${pick(rng, ONSET)}${nucleus}${coda}`
}

const GAIT_BY_SPECIES: Record<Species, Familiar['gait']> = {
  wisp: 'drift',
  moth: 'flit',
  cat: 'pad',
  crow: 'flit',
  newt: 'pad',
  snail: 'hop',
}

export async function deriveFamiliar(owner: string): Promise<Familiar> {
  const seed = await familiarSeed(owner)
  const rng = seededPrng(seed)
  const species = pick(rng, SPECIES)
  const name = syllables(rng)
  const colour = pick(rng, GLOWS)
  const glow = pick(rng, GLOWS)
  return {
    schema: 'freeq.at/world/familiar/v1',
    owner,
    base_generator: 'familiar-v1',
    canonical_seed_hex: [...seed].map((x) => x.toString(16).padStart(2, '0')).join(''),
    species,
    name,
    colour,
    glow,
    gait: GAIT_BY_SPECIES[species],
  }
}

/** The IRC nick a familiar spawns under: `<species>-<name>`, optionally suffixed
 *  when the server says that nick is taken. The DERIVED name never changes; only
 *  the wire nick tolerates a suffix, so two people whose familiars collide both
 *  keep their real one. */
export function familiarNick(f: Pick<Familiar, 'species' | 'name'>, suffix = 0): string {
  const base = `${f.species}-${f.name}`
  return suffix > 0 ? `${base}-${suffix}` : base
}

/** IRC nicks: letters, digits and a few specials, not starting with a digit.
 *  Ours are always `species-name[-n]`, but assert it rather than assume it. */
export function isLegalNick(nick: string): boolean {
  return /^[a-z][a-z0-9-]{1,29}$/i.test(nick)
}

// ---------------------------------------------------------------------------
// The hatch decision — kept pure so the witness's rule is testable.
// ---------------------------------------------------------------------------

/** The level at which the shipped ladder promises a familiar. Read from
 *  LEVELS in xp.ts rather than repeated as a number, so the two cannot drift. */
export const FAMILIAR_EVENT = 'familiar_hatched'

export interface HatchRequest {
  /** the player's level, computed from the signed ledger */
  level: number
  /** the level the ladder says unlocks a familiar */
  required: number
  /** xp they have, and what the next level costs — for an honest refusal */
  xp: number
  nextAt: number | null
  /** a hatch already on the ledger for this player, if any */
  existing?: { name: string; ts: number } | null
}

export type HatchDecision =
  | { ok: true }
  | { ok: false; reason: 'too-low'; short: number; level: number; required: number }
  | { ok: false; reason: 'already'; name: string }

/**
 * Whether to witness a hatch. Two refusals, both of which must say what is
 * wrong: not high enough (with the actual gap), or already done (naming the
 * familiar they already have, so the message is useful rather than a wall).
 */
export function hatchDecision(req: HatchRequest): HatchDecision {
  if (req.existing) return { ok: false, reason: 'already', name: req.existing.name }
  if (req.level < req.required) {
    return {
      ok: false,
      reason: 'too-low',
      short: Math.max(0, (req.nextAt ?? req.xp) - req.xp),
      level: req.level,
      required: req.required,
    }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// The sprite. 8×8, one bitmap per species, two frames of animation.
//
// Deliberately tiny and high-contrast: a familiar has to be legible standing
// next to a 16×24 person in a dark room, at the same scale as everything else.
// '.' is transparent, 'B' body, 'D' a darker body shade, 'G' the glow accent,
// 'E' eye (near-black), 'W' a white highlight.
// ---------------------------------------------------------------------------

export type FamiliarFrame = string[]

const SPRITES: Record<Species, [FamiliarFrame, FamiliarFrame]> = {
  // a floating flame-like mote with a bright core
  wisp: [
    ['...GG...', '..GBBG..', '.GBWBBG.', '.GBBBBG.', '..GBBG..', '...GG...', '...G....', '........'],
    ['........', '...GG...', '..GBBG..', '.GBWBBG.', '.GBBBBG.', '..GBBG..', '...GG...', '....G...'],
  ],
  // wings spread wide, a small dark body down the middle — the silhouette is
  // the whole point at this size, so the wings own the width
  moth: [
    ['..G..G..', 'BBB..BBB', 'BBBBBBBB', 'BBB.EBBB', '.BB.EBB.', '..B.EB..', '...DD...', '........'],
    ['..G..G..', '.BB..BB.', 'BBBBBBBB', 'BBBBEBBB', 'BBB.EBBB', '.BB.EBB.', '...DD...', '........'],
  ],
  // sitting cat, ears up, tail out
  cat: [
    ['.B....B.', '.BB..BB.', '.BBBBBB.', '.BEBBEB.', '.BBBBBB.', 'GBBBBBB.', '.BB..BB.', '.DD..DD.'],
    ['.B....B.', '.BB..BB.', '.BBBBBB.', '.BEBBEB.', '.BBBBBB.', '.BBBBBBG', '.BB..BB.', '.DD..DD.'],
  ],
  // upright bird: round head with an eye, a bright beak jutting right, body
  // tapering to a tail on the left, two feet
  crow: [
    ['..BBB...', '.BBEBBGG', '.BBBBB..', 'DBBBBB..', 'DBBBBBB.', '.BBBBB..', '..G.G...', '........'],
    ['..BBB...', '.BBEBBGG', '.BBBBB..', 'DBBBBBB.', 'DBBBBB..', '.BBBBB..', '..G.G...', '..G...G.'],
  ],
  // long-bodied salamander, legs out
  newt: [
    ['........', '.BBBB...', 'BEBBBBG.', '.BBBBBBG', '.BBBBBB.', 'D.D..D.D', '........', '........'],
    ['........', '..BBBB..', '.BEBBBBG', '.BBBBBBB', '.BBBBBB.', '.D.D.D.D', '........', '........'],
  ],
  // shell with a soft body and eyestalks
  snail: [
    ['..G.....', '..GBBB..', '.BBGBBB.', '.BBBGBB.', '.BBBBBB.', 'EBBBBBB.', '.DDDDDD.', '........'],
    ['...G....', '..GBBB..', '.BBGBBB.', '.BBBGBB.', '.BBBBBB.', '.EBBBBBB', '.DDDDDD.', '........'],
  ],
}

/** Colour for a sprite character, given a familiar. */
export function familiarPalette(f: Pick<Familiar, 'colour' | 'glow'>): Record<string, string | null> {
  return {
    '.': null,
    B: f.colour,
    D: shadeHex(f.colour, 0.6),
    G: f.glow,
    E: '#14141c',
    W: '#ffffff',
  }
}

/** Multiply a hex colour's brightness. Kept here so the shared module has no
 *  dependency on the client's gfx helpers. */
export function shadeHex(hex: string, k: number): string {
  const n = Number.parseInt(hex.slice(1), 16)
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    .map((v) => Math.max(0, Math.min(255, Math.round(v * k))))
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

export function familiarSprite(f: Pick<Familiar, 'species'>, frame: number): FamiliarFrame {
  return SPRITES[f.species][frame % 2 === 0 ? 0 : 1]!
}
