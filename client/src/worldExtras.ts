// Pure helpers for the world's living layer: threads as places, media as
// wall art, and DID-derived companions.

export interface ThreadPlace {
  root: string
  count: number
  lastTs: number
  preview: string
}

/** Group threaded messages (thread_root chains) into up to six active places. */
export function threadsOf(
  log: { id: string; ts: number; thread_root?: string; sender_name: string; content: string }[],
): ThreadPlace[] {
  const byRoot = new Map<string, ThreadPlace>()
  const rootMsg = new Map(log.map((m) => [m.id, m]))
  for (const m of log) {
    if (!m.thread_root) continue
    const root = m.thread_root
    let t = byRoot.get(root)
    if (!t) {
      const rm = rootMsg.get(root)
      t = { root, count: rm ? 1 : 0, lastTs: rm?.ts ?? 0, preview: rm ? rm.content.slice(0, 40) : m.content.slice(0, 40) }
      byRoot.set(root, t)
    }
    t.count++
    if (m.ts > t.lastTs) t.lastTs = m.ts
  }
  return [...byRoot.values()].sort((a, b) => b.lastTs - a.lastTs).slice(0, 6)
}

const IMAGE_URL = /https?:\/\/\S+\.(?:png|jpe?g|gif|webp)(?:\?\S*)?|https:\/\/irc\.freeq\.at\/api\/v1\/media\/\S+/gi

/** Image links posted in the channel — the room hangs its own pictures. */
export function imageUrlsIn(text: string): string[] {
  return [...text.matchAll(IMAGE_URL)].map((m) => m[0])
}

export interface Familiar {
  kind: 'wisp' | 'beetle' | 'bird' | 'slime'
  color: string
}

const FAMILIAR_KINDS: Familiar['kind'][] = ['wisp', 'beetle', 'bird', 'slime']
const FAMILIAR_COLORS = ['#ffd166', '#06d6a0', '#ef476f', '#118ab2', '#f78c6b', '#9b5de5']

/** Roughly a third of DIDs come with a small companion — same one everywhere, forever. */
export function familiarFor(did: string): Familiar | null {
  let h = 0
  for (const c of did) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0
  const u = h >>> 0
  if (u % 3 !== 0) return null
  return {
    kind: FAMILIAR_KINDS[(u >>> 4) % FAMILIAR_KINDS.length]!,
    color: FAMILIAR_COLORS[(u >>> 8) % FAMILIAR_COLORS.length]!,
  }
}
