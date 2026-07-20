// Device identity (spec §6.2 steps 6–7): an ed25519 keypair generated in the
// browser, stored locally, encoded as did:key. Optionally linked to a Bluesky
// handle whose resolved did:plc anchors the avatar (spec §8.2 bootstrap).
// The secret key never leaves the browser.

import { didFromPublicKey, keypairFromSeed, type Keypair } from '../../shared/src/signing'

export interface Identity {
  did: string
  keypair: Keypair
  handle: string
  display_name: string
  linked_did?: string
  linked_handle?: string
  client_instance: string
}

const STORE_KEY = 'freeqworld-identity-v1'

interface StoredIdentity {
  seed_b64: string
  handle: string
  display_name: string
  linked_did?: string
  linked_handle?: string
  client_instance: string
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
  return {
    did: didFromPublicKey(keypair.publicKey),
    keypair,
    handle: stored.handle,
    display_name: stored.display_name,
    linked_did: stored.linked_did,
    linked_handle: stored.linked_handle,
    client_instance: stored.client_instance,
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
