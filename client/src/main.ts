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

/**
 * Self-heal a stale cached page.
 *
 * A browser that cached BOTH index.html and its hashed bundle will happily run
 * an old build forever, entirely from disk, never asking the server anything —
 * so a deployed fix looks like it did nothing. (This bit us for real: a client
 * kept spawning into a room the current build no longer spawns into.)
 *
 * Ask the server which bundle it serves now; if it isn't the one executing,
 * reload once through a cache-busting URL. Guarded by sessionStorage so it can
 * never loop, and silent when offline.
 */
async function ensureFreshBuild(): Promise<void> {
  try {
    if (sessionStorage.getItem('fw-refreshed')) return
    const running = [...document.querySelectorAll('script[type=module][src]')]
      .map((s) => (s as HTMLScriptElement).src)
      .pop()
    if (!running) return
    const html = await (await realFetch(location.pathname, { cache: 'no-store' })).text()
    const served = /assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(html)?.[1]
    if (!served || running.includes(served)) return
    sessionStorage.setItem('fw-refreshed', '1')
    location.replace(`${location.pathname}?r=${Date.now()}${location.hash}`)
  } catch {
    /* offline or blocked — keep running what we have */
  }
}
void ensureFreshBuild()

// build stamp — check with `__build` in the console, or open Dev mode
;(window as unknown as Record<string, unknown>).__build = __BUILD__

const app = new App()
app.start()
// e2e test hook — exposes teleport/join/state helpers
;(window as unknown as Record<string, unknown>).__fimp = app.testHook()
