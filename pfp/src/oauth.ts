// One-tap path: real AT Protocol OAuth via the freeq auth broker, then the
// broker sets the avatar on the user's behalf (it holds the DPoP-bound token;
// the browser never touches a credential). See the broker's /api/pfp/set-avatar
// and docs/PFP-APP-PLAN.md. The app-password path (atproto.ts) stays as the
// no-OAuth fallback.

const BROKER_URL = 'https://auth.freeq.at'

export interface PfpOAuthReturn {
  brokerToken: string
  did: string
  handle: string
  variant: 'portrait' | 'explorer'
  post: boolean
}

/** Redirect into the broker OAuth flow, remembering the render choices. */
export function startPfpOAuth(handle: string, variant: string, post: boolean): void {
  const clean = handle.trim().replace(/^@/, '')
  sessionStorage.setItem('pfp-oauth-intent', JSON.stringify({ variant, post }))
  const returnTo = `${location.origin}${location.pathname}`
  location.href =
    `${BROKER_URL}/auth/login?handle=${encodeURIComponent(clean)}&return_to=${encodeURIComponent(returnTo)}`
}

/** Consume a `#oauth=…` broker return, if present, restoring the render intent. */
export function consumePfpOAuthReturn(): PfpOAuthReturn | null {
  const hash = location.hash
  if (!hash.startsWith('#oauth=')) return null
  history.replaceState(null, '', location.pathname + location.search)
  try {
    const json = atob(hash.slice('#oauth='.length).replace(/-/g, '+').replace(/_/g, '/'))
    const r = JSON.parse(json) as { did?: string; handle?: string; broker_token?: string }
    if (!r.did || !r.broker_token) return null
    const raw = sessionStorage.getItem('pfp-oauth-intent')
    sessionStorage.removeItem('pfp-oauth-intent')
    const intent = raw ? (JSON.parse(raw) as { variant?: string; post?: boolean }) : {}
    return {
      brokerToken: r.broker_token,
      did: r.did,
      handle: r.handle ?? r.did,
      variant: intent.variant === 'portrait' ? 'portrait' : 'explorer',
      post: intent.post !== false,
    }
  } catch {
    return null
  }
}

/** Ask the broker to set the avatar (and optionally post) on the user's PDS. */
export async function setAvatarViaBroker(
  brokerToken: string,
  imageB64: string,
  post: boolean,
): Promise<{ handle: string; posted: boolean }> {
  const res = await fetch(`${BROKER_URL}/api/pfp/set-avatar`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ broker_token: brokerToken, image_b64: imageB64, post }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(text || `broker error ${res.status}`)
  const body = JSON.parse(text) as { handle?: string; posted?: boolean }
  return { handle: body.handle ?? '', posted: !!body.posted }
}
