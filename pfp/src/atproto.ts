// Minimal AT Protocol write client for setting a Bluesky avatar from the
// browser, via an app password (Path B in docs/PFP-APP-PLAN.md).
//
// Why app password, not OAuth: the freeq auth broker signs users in but does
// NOT proxy authenticated write XRPC (its /xrpc/* is 404), and AT Proto OAuth
// tokens are DPoP-bound — unusable from plain browser JS without the broker's
// DPoP key. App-password createSession returns an ordinary Bearer that works
// directly against the user's PDS (CORS is open on the entryway and PDS hosts).
// The password is used once, in memory, and never stored.
//
// Everything sits behind BskyWriter so an OAuth-proxy path can replace it later
// without touching the UI.

export interface Session {
  did: string
  handle: string
  pds: string
  accessJwt: string
}

export interface BlobRef {
  $type: 'blob'
  ref: { $link: string }
  mimeType: string
  size: number
}

/** Resolve a Bluesky handle to its DID via the public AppView. */
export async function resolveHandleToDid(handle: string): Promise<string> {
  const clean = handle.trim().replace(/^@/, '')
  const res = await fetch(
    `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(clean)}`,
  )
  if (!res.ok) throw new Error(`couldn't resolve @${clean} — is that a real Bluesky handle?`)
  return ((await res.json()) as { did: string }).did
}

/** Resolve a DID to its PDS service endpoint (did:plc via plc.directory, did:web via .well-known). */
export async function resolvePds(did: string): Promise<string> {
  let doc: { service?: Array<{ id?: string; type?: string; serviceEndpoint?: string }> }
  if (did.startsWith('did:plc:')) {
    const r = await fetch(`https://plc.directory/${encodeURIComponent(did)}`)
    if (!r.ok) throw new Error('could not resolve your identity document')
    doc = await r.json()
  } else if (did.startsWith('did:web:')) {
    const domain = did.slice('did:web:'.length).replace(/:/g, '/')
    const r = await fetch(`https://${domain}/.well-known/did.json`)
    if (!r.ok) throw new Error('could not resolve did:web identity')
    doc = await r.json()
  } else {
    throw new Error(`unsupported DID method: ${did}`)
  }
  const svc = (doc.service ?? []).find(
    (s) => s.id?.endsWith('#atproto_pds') || s.type === 'AtprotoPersonalDataServer',
  )
  if (!svc?.serviceEndpoint) throw new Error('no PDS found in your identity document')
  return String(svc.serviceEndpoint).replace(/\/$/, '')
}

async function xrpcJson<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  const text = await res.text()
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  if (!res.ok) {
    const msg = (body.message as string) || (body.error as string) || `request failed (${res.status})`
    throw new Error(msg)
  }
  return body as T
}

/** Log in with an app password. Resolves handle → DID → PDS, then createSession. */
export async function login(handleOrDid: string, appPassword: string): Promise<Session> {
  const did = handleOrDid.startsWith('did:') ? handleOrDid : await resolveHandleToDid(handleOrDid)
  const pds = await resolvePds(did)
  const out = await xrpcJson<{ did: string; handle: string; accessJwt: string }>(
    `${pds}/xrpc/com.atproto.server.createSession`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: did, password: appPassword.trim() }),
    },
  )
  return { did: out.did, handle: out.handle, pds, accessJwt: out.accessJwt }
}

export async function uploadBlob(s: Session, bytes: Uint8Array, mimeType: string): Promise<BlobRef> {
  const out = await xrpcJson<{ blob: BlobRef }>(`${s.pds}/xrpc/com.atproto.repo.uploadBlob`, {
    method: 'POST',
    headers: { 'content-type': mimeType, authorization: `Bearer ${s.accessJwt}` },
    body: bytes as BufferSource,
  })
  return out.blob
}

/** Existing app.bsky.actor.profile record, or null if the user has none yet. */
export async function getProfileRecord(s: Session): Promise<Record<string, unknown> | null> {
  const u = new URL(`${s.pds}/xrpc/com.atproto.repo.getRecord`)
  u.searchParams.set('repo', s.did)
  u.searchParams.set('collection', 'app.bsky.actor.profile')
  u.searchParams.set('rkey', 'self')
  const res = await fetch(u, { headers: { authorization: `Bearer ${s.accessJwt}` } })
  if (res.status === 400 || res.status === 404) return null // RecordNotFound — first profile
  const body = (await res.json()) as { value?: Record<string, unknown>; message?: string }
  if (!res.ok) throw new Error(body.message || 'could not read your profile')
  return body.value ?? null
}

/** Swap ONLY the avatar; preserve displayName/description/banner/etc. */
export async function setAvatar(s: Session, avatar: BlobRef): Promise<void> {
  const existing = (await getProfileRecord(s)) ?? {}
  const record = { ...existing, $type: 'app.bsky.actor.profile', avatar }
  await xrpcJson(`${s.pds}/xrpc/com.atproto.repo.putRecord`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${s.accessJwt}` },
    body: JSON.stringify({ repo: s.did, collection: 'app.bsky.actor.profile', rkey: 'self', record }),
  })
}

/** Build a post with the PFP image and a link facet back to FreeqWorld. */
export async function postAboutIt(s: Session, image: BlobRef): Promise<void> {
  const enc = new TextEncoder()
  const url = 'pfp.freeq.at'
  const text = `I'm now my FreeqWorld self ✦\n\nYour identity has a face — mine's derived from my DID: ${url}`
  const start = enc.encode(text.slice(0, text.indexOf(url))).length
  const end = start + enc.encode(url).length
  const record = {
    $type: 'app.bsky.feed.post',
    text,
    createdAt: new Date().toISOString(),
    embed: {
      $type: 'app.bsky.embed.images',
      images: [{ image, alt: 'My FreeqWorld pixel character — derived from my DID.', aspectRatio: { width: 1, height: 1 } }],
    },
    facets: [
      {
        index: { byteStart: start, byteEnd: end },
        features: [{ $type: 'app.bsky.richtext.facet#link', uri: `https://${url}` }],
      },
    ],
  }
  await xrpcJson(`${s.pds}/xrpc/com.atproto.repo.createRecord`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${s.accessJwt}` },
    body: JSON.stringify({ repo: s.did, collection: 'app.bsky.feed.post', record }),
  })
}
