// Is this identity wearing the portrait its DID derives?
//
// The world only needs the answer, not the copywriting (that lives in the ID
// app). One cached fetch of the same public verifier: /api/face/<did> compares
// the hash of the derived bytes with the avatar blob in their signed profile
// record, read from their own PDS.

export interface FaceState {
  did: string
  wearing: string | null
  avatar_cid: string | null
  avatar_size: number | null
}

const cache = new Map<string, { at: number; state: FaceState | null }>()
const TTL = 60_000

export async function faceState(did: string): Promise<FaceState | null> {
  if (!did.startsWith('did:plc:') && !did.startsWith('did:web:')) return null
  const hit = cache.get(did)
  if (hit && Date.now() - hit.at < TTL) return hit.state
  try {
    const res = await fetch(`/api/face/${encodeURIComponent(did)}`)
    const state = res.ok ? ((await res.json()) as FaceState) : null
    cache.set(did, { at: Date.now(), state })
    return state
  } catch {
    return null // a check that cannot run must never break the world
  }
}

export function invalidate(did: string): void {
  cache.delete(did)
}
