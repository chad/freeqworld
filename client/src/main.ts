import { App } from './app'

// Quiet two classes of doomed requests the SDK fires optimistically:
// - Bluesky profile lookups for did:key actors (Bluesky only resolves did:plc/did:web)
// - the pins REST endpoint, which is cross-origin from this deployment
// Answering them synthetically keeps the network tab and console clean.
const realFetch = window.fetch.bind(window)
window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (url.includes('app.bsky.actor.getProfile') && url.includes('did%3Akey')) {
    return Promise.resolve(new Response(JSON.stringify({ error: 'InvalidRequest' }), { status: 400, headers: { 'content-type': 'application/json' } }))
  }
  if (/\/api\/v1\/channels\/[^/]+\/pins/.test(url) && !url.startsWith(location.origin)) {
    return Promise.resolve(new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }))
  }
  return realFetch(input, init)
}

const app = new App()
app.start()
// e2e test hook — exposes teleport/join/state helpers
;(window as unknown as Record<string, unknown>).__fimp = app.testHook()
