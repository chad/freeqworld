// Bluesky handle -> DID -> tune. Read-only, unauthenticated, CORS-open public
// AppView; the same resolution path the PFP app uses (fimp/pfp/src/atproto.ts).

export interface Profile {
  did: string
  handle: string
  displayName?: string
  avatar?: string
}

const APPVIEW = 'https://public.api.bsky.app/xrpc'

/** Resolve "@alice.bsky.social" (or a raw did:...) to a DID. */
export async function resolveHandleToDid(input: string): Promise<string> {
  const clean = input.trim().replace(/^@/, '')
  if (clean.startsWith('did:')) return clean
  const res = await fetch(
    `${APPVIEW}/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(clean)}`,
  )
  if (!res.ok) throw new Error(`couldn't resolve @${clean} — is that a real Bluesky handle?`)
  return ((await res.json()) as { did: string }).did
}

/** Profile card (display name + avatar) purely for the UI — never for the music.
 *  Traits are derived from the DID alone (spec §8.4: nothing inferred from
 *  profile data), so renaming yourself never changes your tune. */
export async function fetchProfile(actor: string): Promise<Profile> {
  const res = await fetch(`${APPVIEW}/app.bsky.actor.getProfile?actor=${encodeURIComponent(actor)}`)
  if (!res.ok) throw new Error(`no profile for ${actor}`)
  const j = (await res.json()) as Profile
  return { did: j.did, handle: j.handle, displayName: j.displayName, avatar: j.avatar }
}
