// The client's view of the XP ledger.
//
// Fetches the signed completion log (same-origin proxy, because the events API
// sends no CORS header), VERIFIES each witness signature locally, and computes
// levels and boards with the shared pure functions. The proxy is only transport:
// an unsigned or edited completion scores nothing no matter who served it.

import {
  completionsFromEvents, ladderBoard, levelFor, standings,
  type Completion, type Ladder, type Standing,
} from '../../shared/src/xp'

export type { Standing, Ladder }
export { levelFor, ladderBoard }

const TTL = 30_000

let cache: { at: number; completions: Completion[] } | null = null
let inFlight: Promise<Completion[]> | null = null

/** Verified completions across the channels the witness watches. */
export async function loadCompletions(channels: string[] = ['#general', '#lobby', '#dev']): Promise<Completion[]> {
  if (cache && Date.now() - cache.at < TTL) return cache.completions
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      const base = location.pathname.startsWith('/id') ? '/id' : ''
      const res = await fetch(`${base}/api/xp?channels=${encodeURIComponent(channels.join(','))}`)
      if (!res.ok) throw new Error(`xp ${res.status}`)
      const body = (await res.json()) as { events?: unknown[] }
      const completions = await completionsFromEvents(
        (body.events ?? []) as Parameters<typeof completionsFromEvents>[0],
      )
      cache = { at: Date.now(), completions }
      return completions
    } catch {
      // a board that can't load must not take the world down; show it empty
      return cache?.completions ?? []
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

export function invalidate(): void {
  cache = null
}

export async function board(): Promise<Standing[]> {
  return standings(await loadCompletions())
}

/** One player's standing, or a zeroed one so the UI can always render. */
export async function standingFor(did: string | null): Promise<Standing> {
  const all = did ? await board() : []
  const mine = all.find((s) => s.player === did)
  if (mine) return mine
  return {
    player: did ?? '',
    xp: 0,
    level: 1,
    title: 'Wanderer',
    runs: 0,
    byLadder: { courier: 0, cartographer: 0, kindler: 0, welcomer: 0, herald: 0, witness: 0 },
    lastAt: 0,
  }
}
