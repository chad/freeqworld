// Device identity (spec §6.2 steps 6–7): an ed25519 keypair generated in the
// browser, stored locally, encoded as did:key. Optionally linked to a Bluesky
// handle whose resolved did:plc anchors the avatar (spec §8.2 bootstrap).
// The secret key never leaves the browser.

import { didFromPublicKey, keypairFromSeed, type Keypair } from '../../shared/src/signing'

export interface OAuthSession {
  method: 'web-token'
  did: string // the real AT Protocol did (did:plc:…), OAuth-verified
  handle: string
  pds_url: string
  web_token: string
  broker_token: string
  broker_url: string
}

export interface Identity {
  /** primary identity: the OAuth-verified did:plc when present, else the device did:key */
  did: string
  /** the browser-held device key — always present, signs world-layer events (autographs) */
  device_did: string
  keypair: Keypair
  handle: string
  display_name: string
  linked_did?: string
  linked_handle?: string
  client_instance: string
  oauth?: OAuthSession
}

const STORE_KEY = 'freeqworld-identity-v1'

interface StoredIdentity {
  seed_b64: string
  handle: string
  display_name: string
  linked_did?: string
  linked_handle?: string
  client_instance: string
  oauth?: OAuthSession
}

function toB64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function fromB64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
}

function hydrate(stored: StoredIdentity): Identity {
  const keypair = keypairFromSeed(fromB64(stored.seed_b64))
  const device_did = didFromPublicKey(keypair.publicKey)
  return {
    did: stored.oauth?.did ?? device_did,
    device_did,
    keypair,
    handle: stored.oauth?.handle ?? stored.handle,
    display_name: stored.display_name,
    linked_did: stored.linked_did,
    linked_handle: stored.linked_handle,
    client_instance: stored.client_instance,
    oauth: stored.oauth,
  }
}

export function loadIdentity(): Identity | null {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return null
    return hydrate(JSON.parse(raw) as StoredIdentity)
  } catch {
    return null
  }
}

export function createIdentity(displayName: string, linked?: { did: string; handle: string }): Identity {
  const seed = crypto.getRandomValues(new Uint8Array(32))
  const slug = displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'wanderer'
  const stored: StoredIdentity = {
    seed_b64: toB64(seed),
    handle: linked?.handle ?? `${slug}.guest`,
    display_name: displayName,
    linked_did: linked?.did,
    linked_handle: linked?.handle,
    client_instance: `web-${crypto.randomUUID().slice(0, 8)}`,
  }
  localStorage.setItem(STORE_KEY, JSON.stringify(stored))
  return hydrate(stored)
}

export function updateDisplayName(name: string): void {
  const raw = localStorage.getItem(STORE_KEY)
  if (!raw) return
  const stored = JSON.parse(raw) as StoredIdentity
  stored.display_name = name
  localStorage.setItem(STORE_KEY, JSON.stringify(stored))
}

const BROKER_URL = 'https://auth.freeq.at'

/** Begin the real AT Protocol OAuth flow via the freeq auth broker (same-window redirect). */
export function startOAuth(handle: string): void {
  const clean = handle.trim().replace(/^@/, '')
  localStorage.setItem('fimp-oauth-pending', clean)
  const url = `${BROKER_URL}/auth/login?handle=${encodeURIComponent(clean)}&return_to=${encodeURIComponent(window.location.origin)}`
  window.location.href = url
}

/** Consume a `#oauth=` result from the broker redirect, if present. */
export function consumeOAuthReturn(): Identity | null {
  const hash = window.location.hash
  if (!hash.startsWith('#oauth=')) return null
  history.replaceState(null, '', window.location.pathname + window.location.search)
  try {
    const json = atob(hash.slice('#oauth='.length).replace(/-/g, '+').replace(/_/g, '/'))
    const result = JSON.parse(json) as { did?: string; handle?: string; pds_url?: string; web_token?: string; token?: string; broker_token?: string }
    if (!result.did) return null
    const oauth: OAuthSession = {
      method: 'web-token',
      did: result.did,
      handle: result.handle ?? localStorage.getItem('fimp-oauth-pending') ?? result.did,
      pds_url: result.pds_url ?? '',
      web_token: result.web_token ?? result.token ?? '',
      broker_token: result.broker_token ?? '',
      broker_url: BROKER_URL,
    }
    localStorage.removeItem('fimp-oauth-pending')
    return attachOAuth(oauth)
  } catch {
    return null
  }
}

/** Attach an OAuth session to the stored identity (creating one if needed). */
function attachOAuth(oauth: OAuthSession): Identity {
  const raw = localStorage.getItem(STORE_KEY)
  let stored: StoredIdentity
  if (raw) {
    stored = JSON.parse(raw) as StoredIdentity
  } else {
    const seed = crypto.getRandomValues(new Uint8Array(32))
    stored = {
      seed_b64: toB64(seed),
      handle: oauth.handle,
      display_name: oauth.handle.split('.')[0] ?? oauth.handle,
      client_instance: `web-${crypto.randomUUID().slice(0, 8)}`,
    }
  }
  stored.oauth = oauth
  stored.handle = oauth.handle
  stored.display_name = oauth.handle.split('.')[0] ?? oauth.handle
  localStorage.setItem(STORE_KEY, JSON.stringify(stored))
  return hydrate(stored)
}

/** Persist a refreshed broker token (rotation on session refresh). */
export function updateBrokerToken(token: string): void {
  const raw = localStorage.getItem(STORE_KEY)
  if (!raw) return
  const stored = JSON.parse(raw) as StoredIdentity
  if (stored.oauth) {
    stored.oauth.broker_token = token
    localStorage.setItem(STORE_KEY, JSON.stringify(stored))
  }
}

/** Resolve a Bluesky handle to its AT Protocol DID via the public AppView. */
export async function resolveBlueskyHandle(handle: string): Promise<string> {
  const clean = handle.trim().replace(/^@/, '')
  const res = await fetch(
    `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(clean)}`,
  )
  if (!res.ok) throw new Error(`could not resolve ${clean}`)
  const body = (await res.json()) as { did: string }
  return body.did
}

/** The DID the avatar derives from: linked Bluesky identity when present, else the device did:key. */
export function avatarDid(id: Identity): string {
  return id.linked_did ?? id.did
}
