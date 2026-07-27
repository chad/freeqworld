// Where a thread's campfire stands in a room.
//
// This used to be three lines inline in the draw setup: pick a random walkable
// tile, done. Which is how fires ended up burning inside the quest board, in
// the middle of a doorway, and on top of each other — a room with four live
// threads looked like scattered debris rather than places to sit.
//
// It lives here as a pure function so the constraint is actually testable: you
// cannot see "no fire overlaps the furniture" in a screenshot of a room that
// happens to have no threads in it today.

export interface Spot {
  x: number
  y: number
}

export interface PlacementOpts {
  /** deterministic per-thread source, so a fire stays where it was */
  rng: () => number
  width: number
  height: number
  walkable: (x: number, y: number) => boolean
  /** furniture, doors, spawn — things a fire must not sit inside */
  blocked: { x: number; y: number; r: number }[]
  /** fires already placed in this room */
  placed: Spot[]
  /** somewhere legal to stand if the room is too full to satisfy the rules */
  fallback: Spot
}

/** how far one fire keeps from another: enough for both labels to be read */
export const FIRE_SPACING = 3.5

export function isClearSpot(x: number, y: number, opts: Pick<PlacementOpts, 'blocked' | 'placed'>): boolean {
  for (const b of opts.blocked) if (Math.hypot(x - b.x, y - b.y) < b.r) return false
  for (const q of opts.placed) if (Math.hypot(x - q.x, y - q.y) < FIRE_SPACING) return false
  return true
}

/**
 * Two passes: insist on a spot that satisfies every rule, and only if the room
 * is genuinely too crowded fall back to any walkable tile. A cramped room with
 * an awkward fire beats a fire that vanishes.
 */
export function placeCampfire(opts: PlacementOpts): Spot {
  const { rng, width, height, walkable } = opts
  let loose: Spot | null = null
  for (let tries = 0; tries < 120; tries++) {
    const x = 3 + rng() * (width - 6)
    const y = 4 + rng() * (height - 7)
    if (!walkable(x, y)) continue
    if (isClearSpot(x, y, opts)) return { x, y }
    loose ??= { x, y }
  }
  return loose ?? opts.fallback
}
