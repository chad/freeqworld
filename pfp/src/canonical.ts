// The bytes we upload as your avatar must be the bytes anyone can recompute.
//
// A browser's PNG encoder is not reproducible across browsers or versions, so
// `canvas.toBlob()` output can never be verified by a third party. The server
// renders the same portrait deterministically (server/src/face.ts) and tells us
// the CID those bytes will have as an AT Proto blob — so uploading THEM is what
// makes "this person is provably wearing their derived face" checkable by
// anybody, with no oracle and no trust in us.
//
// There is deliberately NO fallback to the canvas render: quietly uploading
// unverifiable bytes would break the one property this is for.

import type { Variant } from './render'

export interface CanonicalFace {
  bytes: Uint8Array
  /** the CID these bytes will have once uploaded */
  cid: string | null
}

/** `/face/<did>.png` is served by the town server and proxied on pfp.freeq.at. */
export async function canonicalFace(did: string, variant: Variant): Promise<CanonicalFace> {
  const base = location.pathname.startsWith('/id') ? '/id' : ''
  const url = `${base}/face/${encodeURIComponent(did)}.png?variant=${variant === 'portrait' ? 'portrait' : 'explorer'}`
  const res = await fetch(url, { cache: 'force-cache' })
  if (!res.ok) {
    throw new Error(
      "couldn't fetch your canonical portrait — the avatar has to be the exact bytes that can be verified, so nothing was uploaded. try again in a moment.",
    )
  }
  return {
    bytes: new Uint8Array(await res.arrayBuffer()),
    cid: res.headers.get('x-freeq-cid'),
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}
