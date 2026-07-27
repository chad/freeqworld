// Does this identity already wear its derived face?
//
// The app should not make you ask an agent and be told no. It knows how to
// check: /api/face/<did> compares the hash of the bytes your DID derives with
// the avatar blob named in your own signed profile record, read from your PDS.

export interface FaceState {
  did: string
  handle: string
  avatar_cid: string | null
  avatar_size: number | null
  source: string
  expected: Record<string, string>
  wearing: string | null
}

const cache = new Map<string, FaceState>()

/** Only an AT Protocol identity has a profile to check. */
export function checkable(did: string): boolean {
  return did.startsWith('did:plc:') || did.startsWith('did:web:')
}

export async function faceState(did: string, refresh = false): Promise<FaceState | null> {
  if (!checkable(did)) return null
  if (!refresh && cache.has(did)) return cache.get(did)!
  const base = location.pathname.startsWith('/id') ? '/id' : ''
  try {
    const res = await fetch(`${base}/api/face/${encodeURIComponent(did)}`)
    if (!res.ok) return null
    const state = (await res.json()) as FaceState
    cache.set(did, state)
    return state
  } catch {
    return null // never let a check failure break the reveal
  }
}

export function forget(did: string): void {
  cache.delete(did)
}

/** One honest line about where they stand, and what to do next. */
export function describe(state: FaceState): { text: string; verified: boolean; action: boolean } {
  if (state.wearing) {
    return {
      verified: true,
      action: false,
      text: `◈ verified — your Bluesky avatar is exactly the portrait this DID derives (${state.wearing}, ${state.expected[state.wearing]!.slice(0, 14)}…). Anyone can check that themselves; nobody has to take your word for it.`,
    }
  }
  if (!state.avatar_cid) {
    return { verified: false, action: true, text: '◇ you have no Bluesky avatar set — this one is derived from your DID, and provably so.' }
  }
  const kb = state.avatar_size ? `${Math.round(state.avatar_size / 1024)}kB` : 'an image'
  return {
    verified: false,
    action: true,
    text: `◇ your Bluesky avatar (${kb}) isn't the portrait this DID derives. Set it below and it becomes verifiable — the check compares the hash of the bytes, so only the real thing passes.`,
  }
}
