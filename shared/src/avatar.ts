// Deterministic avatar system (spec §8, §12.2).
// canonical_seed = HKDF-SHA256(ikm=DID, salt="freeq-world-avatar", info="avatar-v1")
// All traits are abstract — nothing is inferred from profile data (spec §8.4).

import { hkdfSha256, pick, seededPrng, sha256Hex } from './hkdf'

export const TRAIT_KEYS = [
  'body_silhouette',
  'head_shape',
  'skin_palette',
  'hair_shape',
  'hair_palette',
  'eye_pixels',
  'shirt_jacket',
  'pants_skirt',
  'shoes',
  'accessory',
  'idle_movement',
  'walk_cadence',
  'speech_sound',
  'accent_palette',
  'arrival_effect',
  'musical_leitmotif',
] as const

export type TraitKey = (typeof TRAIT_KEYS)[number]
export type Traits = Record<TraitKey, string | number>

export interface Avatar {
  schema: 'freeq.at/profile/avatar/v1'
  did: string
  base_generator: 'avatar-v1'
  canonical_seed_hex: string
  traits: Traits
}

const OPTIONS = {
  body_silhouette: ['slim', 'broad', 'round', 'tall', 'compact', 'angular'],
  head_shape: ['round', 'square', 'oval', 'wide'],
  // stylized fictional palette — deliberately includes non-naturalistic hues
  skin_palette: ['#e8b48c', '#c68863', '#8d5a3b', '#5c3a26', '#f4d6b8', '#9fb8ad', '#b7a6d9', '#7d9c6f'],
  hair_shape: ['crop', 'spikes', 'bob', 'long', 'curls', 'mohawk', 'bald', 'bun'],
  hair_palette: ['#2b2b3a', '#5a3825', '#c9a227', '#b8434e', '#3f7cac', '#67c26b', '#e8e6df', '#8447ad'],
  eye_pixels: ['dot', 'wide', 'wink', 'visor'],
  shirt_jacket: ['#3f7cac', '#b8434e', '#67c26b', '#c9a227', '#8447ad', '#3a9188', '#d97b29', '#6d7680'],
  pants_skirt: ['#31394d', '#5a3825', '#3a5a40', '#6b3a55', '#444444', '#7a5c99'],
  shoes: ['#1e1e28', '#5a3825', '#b8434e', '#e8e6df'],
  accessory: ['none', 'hat', 'glasses', 'scarf', 'antenna', 'flower', 'headphones', 'badge'],
  idle_movement: ['bob', 'sway', 'blink', 'tap'],
  walk_cadence: ['steady', 'bouncy', 'brisk', 'ambling'],
  speech_sound: ['beep', 'blip', 'burble', 'chirp', 'hum'],
  accent_palette: ['#ffd166', '#06d6a0', '#ef476f', '#118ab2', '#f78c6b', '#9b5de5'],
  arrival_effect: ['sparkle', 'dissolve', 'drop', 'teleport-rings'],
} as const

export async function canonicalSeed(did: string): Promise<Uint8Array> {
  return hkdfSha256(did, 'freeq-world-avatar', 'avatar-v1', 32)
}

export async function deriveAvatar(did: string): Promise<Avatar> {
  const seed = await canonicalSeed(did)
  const rng = seededPrng(seed)
  const traits = {} as Traits
  for (const key of TRAIT_KEYS) {
    if (key === 'musical_leitmotif') {
      // pointer to the leitmotif derivation (own HKDF domain, spec §11.5)
      traits[key] = 'motif-v1'
      continue
    }
    traits[key] = pick(rng, OPTIONS[key])
  }
  const canonical_seed_hex = [...seed].map((x) => x.toString(16).padStart(2, '0')).join('')
  return { schema: 'freeq.at/profile/avatar/v1', did, base_generator: 'avatar-v1', canonical_seed_hex, traits }
}

export type Facing = 'north' | 'south' | 'east' | 'west'

export interface SpritePixels {
  width: number
  height: number
  /** palette indices, 0 = transparent */
  pixels: Uint8Array
  palette: string[]
}

const W = 16
const H = 24

// Procedural 16×24 pixel body. Rows: hair/head 0–9, torso 10–17, legs 18–21,
// shoes 22–23. Facing changes the face; walk frames swing arms and legs.
export function renderSpritePixels(av: Avatar, facing: Facing, frame: number): SpritePixels {
  const t = av.traits
  const palette = [
    'transparent',
    String(t.skin_palette),
    String(t.hair_palette),
    String(t.shirt_jacket),
    String(t.pants_skirt),
    String(t.shoes),
    '#14141c', // outline/eyes
    String(t.accent_palette),
    '#ffffff',
  ]
  const SKIN = 1, HAIR = 2, SHIRT = 3, PANTS = 4, SHOE = 5, INK = 6, ACCENT = 7, WHITE = 8
  const px = new Uint8Array(W * H)
  const set = (x: number, y: number, c: number) => {
    if (x >= 0 && x < W && y >= 0 && y < H) px[y * W + x] = c
  }
  const hspan = (x0: number, x1: number, y: number, c: number) => {
    for (let x = x0; x <= x1; x++) set(x, y, c)
  }

  const silhouette = String(t.body_silhouette)
  const bodyW = silhouette === 'broad' || silhouette === 'round' ? 10 : silhouette === 'slim' ? 6 : 8
  const bodyX0 = Math.floor((W - bodyW) / 2)
  const bodyX1 = bodyX0 + bodyW - 1

  const headShape = String(t.head_shape)
  const headW = headShape === 'wide' ? 10 : headShape === 'square' ? 8 : 8
  const headX0 = Math.floor((W - headW) / 2)
  const headX1 = headX0 + headW - 1
  const headTop = silhouette === 'tall' ? 1 : 2

  // head
  for (let y = headTop; y <= 9; y++) {
    const shrink = headShape === 'round' || headShape === 'oval' ? (y === headTop || y === 9 ? 1 : 0) : 0
    hspan(headX0 + shrink, headX1 - shrink, y, SKIN)
  }

  // hair
  const hair = String(t.hair_shape)
  if (hair !== 'bald') {
    hspan(headX0, headX1, headTop, HAIR)
    hspan(headX0, headX1, headTop + 1, HAIR)
    if (hair === 'spikes' || hair === 'mohawk') {
      for (let x = headX0 + (hair === 'mohawk' ? Math.floor(headW / 2) - 1 : 0); x <= (hair === 'mohawk' ? headX0 + Math.floor(headW / 2) : headX1); x += hair === 'mohawk' ? 1 : 2) {
        set(x, headTop - 1, HAIR)
      }
    }
    if (hair === 'bob' || hair === 'long' || hair === 'curls') {
      set(headX0, headTop + 2, HAIR); set(headX1, headTop + 2, HAIR)
      set(headX0, headTop + 3, HAIR); set(headX1, headTop + 3, HAIR)
      if (hair === 'long') { set(headX0, headTop + 4, HAIR); set(headX1, headTop + 4, HAIR) }
    }
    if (hair === 'bun') set(Math.floor(W / 2), headTop - 1, HAIR)
  }

  // face (not shown when facing north)
  if (facing !== 'north') {
    const eyeY = headTop + 4
    const eyes = String(t.eye_pixels)
    const mid = Math.floor(W / 2)
    const eyeL = facing === 'east' ? mid : facing === 'west' ? headX0 + 1 : headX0 + 2
    const eyeR = facing === 'east' ? headX1 - 1 : facing === 'west' ? mid - 1 : headX1 - 2
    if (eyes === 'visor') {
      hspan(eyeL, eyeR, eyeY, ACCENT)
    } else {
      set(eyeL, eyeY, INK)
      if (eyes !== 'wink') set(eyeR, eyeY, INK)
      if (eyes === 'wide') { set(eyeL, eyeY - 1, WHITE); set(eyeR, eyeY - 1, WHITE) }
    }
  } else {
    // back of head is hair
    if (hair !== 'bald') for (let y = headTop; y <= 8; y++) hspan(headX0, headX1, y, HAIR)
  }

  // torso
  for (let y = 10; y <= 17; y++) hspan(bodyX0, bodyX1, y, SHIRT)
  // accent stripe
  hspan(bodyX0, bodyX1, 13, ACCENT)

  // arms (swing with walk frame)
  const swing = frame === 0 ? 0 : frame === 1 ? 1 : -1
  set(bodyX0 - 1, 11 + swing, SKIN)
  set(bodyX0 - 1, 12 + swing, SKIN)
  set(bodyX1 + 1, 11 - swing, SKIN)
  set(bodyX1 + 1, 12 - swing, SKIN)

  // legs
  const legY0 = 18
  const legW = Math.max(2, Math.floor(bodyW / 2) - 1)
  const gap = frame === 0 ? 2 : frame === 1 ? 4 : 0
  const legL0 = Math.floor(W / 2) - Math.floor(gap / 2) - legW
  const legR0 = Math.floor(W / 2) + Math.ceil(gap / 2)
  for (let y = legY0; y <= 21; y++) {
    hspan(legL0, legL0 + legW - 1, y, PANTS)
    hspan(legR0, legR0 + legW - 1, y, PANTS)
  }
  for (let y = 22; y <= 23; y++) {
    hspan(legL0, legL0 + legW - 1, y, SHOE)
    hspan(legR0, legR0 + legW - 1, y, SHOE)
  }

  // accessory
  const acc = String(t.accessory)
  if (acc === 'hat') { hspan(headX0 - 1, headX1 + 1, headTop, ACCENT); hspan(headX0, headX1, headTop - 1, ACCENT) }
  if (acc === 'antenna') { set(Math.floor(W / 2), headTop - 1, INK); set(Math.floor(W / 2), headTop - 2, ACCENT) }
  if (acc === 'scarf') hspan(bodyX0, bodyX1, 10, ACCENT)
  if (acc === 'glasses' && facing !== 'north') hspan(headX0 + 1, headX1 - 1, headTop + 4, INK)
  if (acc === 'headphones') { set(headX0 - 1, headTop + 3, ACCENT); set(headX1 + 1, headTop + 3, ACCENT) }
  if (acc === 'flower') set(headX1, headTop + 1, ACCENT)
  if (acc === 'badge') set(bodyX0 + 1, 11, ACCENT)

  return { width: W, height: H, pixels: px, palette }
}

/** Deterministic content hash over all four facings — conformance fixture value (spec §31). */
export async function spriteHash(av: Avatar): Promise<string> {
  const parts: number[] = []
  for (const facing of ['south', 'north', 'east', 'west'] as Facing[]) {
    const { pixels, palette } = renderSpritePixels(av, facing, 0)
    parts.push(...pixels)
    for (const color of palette) for (const ch of color) parts.push(ch.charCodeAt(0))
  }
  return sha256Hex(new Uint8Array(parts))
}
