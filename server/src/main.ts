// WS + HTTP shell around Town. Serves the built client, the JSON API,
// the /ws participant socket, and the /fed federation socket.
// Runs two peered towns by default: freeq-city :8787 and neonwharf :8788.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket, WebSocketServer } from 'ws'
import { Town, type Connection } from './town'
import { appPageWithOg, cardPng, clipMp4, resolveIdentity, stingerWav, themeWav } from './share.ts'
import type { ClientFrame, DurableEvent } from '../../shared/src/protocol'

const CLIENT_DIST = join(fileURLToPath(new URL('.', import.meta.url)), '../../client/dist')
const PFP_DIST = join(fileURLToPath(new URL('.', import.meta.url)), '../../pfp/dist')

/** Media responses with byte-range support.
 *
 *  Not optional for video: Discord, Telegram, iMessage and every browser
 *  <video> element probe with a Range request first and refuse to play a
 *  response that answers 200 with the whole file instead of 206. */
function sendMedia(
  req: IncomingMessage, res: ServerResponse, body: Buffer, type: string, filename?: string,
): void {
  const headers: Record<string, string> = {
    'content-type': type,
    'accept-ranges': 'bytes',
    'cache-control': 'public, max-age=86400',
  }
  if (filename) headers['content-disposition'] = `inline; filename="${filename}"`

  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''))
  if (range) {
    const start = range[1] ? Number(range[1]) : 0
    const end = range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1
    if (start >= body.length || start > end) {
      res.writeHead(416, { 'content-range': `bytes */${body.length}` })
      res.end()
      return
    }
    const slice = body.subarray(start, end + 1)
    res.writeHead(206, {
      ...headers,
      'content-range': `bytes ${start}-${end}/${body.length}`,
      'content-length': String(slice.length),
    })
    res.end(req.method === 'HEAD' ? undefined : slice)
    return
  }
  res.writeHead(200, { ...headers, 'content-length': String(body.length) })
  res.end(req.method === 'HEAD' ? undefined : body)
}

/** Hashed build assets are immutable and cached hard; the HTML that POINTS at
 *  them must always be revalidated, or a deploy leaves returning visitors on a
 *  stale page referencing bundles that no longer exist. */
function cacheHeaders(filePath: string): Record<string, string> {
  return filePath.startsWith('/assets/')
    ? { 'cache-control': 'public, max-age=31536000, immutable' }
    : { 'cache-control': 'no-cache, must-revalidate' }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
}

export interface RunningTown {
  town: Town
  port: number
  close: () => void
}

export function startTown(town: Town, port: number): RunningTown {
  const http = createServer(async (req, res) => {
    try {
      await handleHttp(town, req, res)
    } catch (err) {
      res.writeHead(500)
      res.end(String(err))
    }
  })

  const wss = new WebSocketServer({ noServer: true })
  const fedWss = new WebSocketServer({ noServer: true })

  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
    } else if (url.pathname === '/fed') {
      fedWss.handleUpgrade(req, socket, head, (ws) => fedWss.emit('connection', ws, req))
    } else {
      socket.destroy()
    }
  })

  wss.on('connection', (ws) => {
    const conn: Connection = {
      send: (frame) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame))
      },
      close: () => ws.close(),
    }
    ws.on('message', (data) => {
      try {
        const frame = JSON.parse(String(data)) as ClientFrame
        town.handleFrame(conn, frame)
      } catch (err) {
        conn.send({ t: 'error', message: `bad frame: ${String(err)}` })
      }
    })
    ws.on('close', () => town.disconnect(conn))
    ws.on('error', () => town.disconnect(conn))
  })

  // inbound federation links from peer towns
  fedWss.on('connection', (ws) => {
    let peerName = ''
    ws.on('message', (data) => {
      try {
        const frame = JSON.parse(String(data)) as { t: 'fed-hello'; server: string } | { t: 'fed-event'; durable: DurableEvent }
        if (frame.t === 'fed-hello') {
          peerName = frame.server
          town.attachPeer(peerName, (durable) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'fed-event', durable }))
          })
        } else if (frame.t === 'fed-event' && peerName) {
          town.receiveFederated(peerName, frame.durable)
        }
      } catch {
        /* drop malformed peer frames */
      }
    })
  })

  const presenceTimer = setInterval(() => town.flushPresence(), 100)
  http.listen(port)
  return {
    town,
    port,
    close: () => {
      clearInterval(presenceTimer)
      wss.close()
      fedWss.close()
      http.close()
    },
  }
}

/** Outbound federation link: dial a peer town's /fed and exchange events both ways. */
export function dialPeer(town: Town, peerServer: string, peerUrl: string): void {
  const connect = () => {
    const ws = new WebSocket(`${peerUrl.replace(/^http/, 'ws')}/fed`)
    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'fed-hello', server: town.config.server }))
      town.attachPeer(peerServer, (durable) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'fed-event', durable }))
      })
    })
    ws.on('message', (data) => {
      try {
        const frame = JSON.parse(String(data)) as { t: string; durable?: DurableEvent }
        if (frame.t === 'fed-event' && frame.durable) town.receiveFederated(peerServer, frame.durable)
      } catch {
        /* ignore */
      }
    })
    ws.on('error', () => {})
    ws.on('close', () => setTimeout(connect, 2000))
  }
  connect()
}

async function handleHttp(town: Town, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x')
  const path = url.pathname

  const json = (body: unknown, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
    res.end(JSON.stringify(body))
  }

  if (path === '/api/town') return json(town.townProfile())
  if (path === '/api/rooms') return json(town.rooms())
  if (path.startsWith('/api/history/')) {
    const channel = decodeURIComponent(path.slice('/api/history/'.length))
    return json(town.getLog(channel).slice(-200))
  }
  // raw durable storage — lets anyone verify the encrypted room stores ciphertext only
  if (path.startsWith('/api/debug/log/')) {
    const channel = decodeURIComponent(path.slice('/api/debug/log/'.length))
    return json({ server: town.config.server, channel, durable_log: town.getLog(channel) })
  }
  // live ephemeral presence — demonstrates the durable/ephemeral split
  if (path.startsWith('/api/debug/presence/')) {
    const channel = decodeURIComponent(path.slice('/api/debug/presence/'.length))
    return json({ server: town.config.server, channel, ephemeral: true, positions: town.getPresence(channel) })
  }
  if (path === '/api/agents') {
    return json(town.getAgents().map((a) => a.member))
  }

  // --- shareable identity pages -------------------------------------------
  // /u/<handle> unfurls as that person's character + tune (a static SPA can't:
  // crawlers don't run JS, so its OG tags can never vary per person).
  // Reachable under /id/... on world.freeq.at and at the root on pfp.freeq.at.
  const share = path.startsWith('/id/') ? path.slice('/id'.length) : path
  const shareMatch = /^\/(u|card|theme|stinger|clip)\/(.+)$/.exec(share)
  // The app's own address bar is `?u=<handle>` (that's the URL a visitor copies
  // after following a share, or after looking someone up). Crawlers asking for
  // it must get THAT person's card, not the generic site one — so serve the
  // share page for it too, canonicalised to /u/<handle>.
  const appQueryWho = (share === '/' || share === '') ? url.searchParams.get('u') : null
  if (shareMatch || appQueryWho) {
    const kind = shareMatch ? (shareMatch[1] as string) : 'u'
    const rawWho = shareMatch ? (shareMatch[2] as string) : appQueryWho!
    // ONE canonical origin for shares, rather than whatever host served this
    // request. The miren router strips X-Forwarded-Host and rewrites
    // X-Forwarded-Proto, so the public hostname simply isn't knowable from the
    // headers here — and a single canonical domain is what we want anyway, so
    // every share of a person consolidates on one URL (and one cached card).
    const reqHost = String(req.headers.host ?? '')
    const local = /^(localhost|127\.|\[?::1)/.test(reqHost)
    const base = local
      ? `http://${reqHost}${path.startsWith('/id/') ? '/id' : ''}`
      : (process.env.SHARE_ORIGIN ?? 'https://pfp.freeq.at')
    try {
      const id = await resolveIdentity(rawWho)
      if (kind === 'u') {
        // the real app, with this person's OpenGraph tags injected: crawlers
        // read the tags, humans land straight in the app (no interstitial)
        const index = await readFile(join(PFP_DIST, 'index.html'), 'utf8')
        const html = await appPageWithOg(id, base, index, {
          basePath: path.startsWith('/id/') ? '/id/' : '/',
        })
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-cache, must-revalidate',
        })
        res.end(html)
        return
      }
      if (kind === 'card') {
        const png = await cardPng(id)
        res.writeHead(200, {
          'content-type': 'image/png',
          // crawlers refetch often; a day of CDN/browser cache is plenty and the
          // card is a pure function of the DID anyway
          'cache-control': 'public, max-age=86400',
          'content-length': String(png.length),
        })
        res.end(png)
        return
      }
      if (kind === 'clip') {
        const mp4 = await clipMp4(id)
        sendMedia(req, res, mp4, 'video/mp4')
        return
      }
      const wav = kind === 'stinger' ? await stingerWav(id) : await themeWav(id)
      sendMedia(req, res, Buffer.from(wav), 'audio/wav', `freeqworld-${(id.handle || id.did).replace(/[^a-z0-9.]/gi, '_')}.wav`)
      return
    } catch (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`no FreeqWorld identity for that: ${(err as Error).message}`)
      return
    }
  }

  // FreeqWorld ID microapp at /id (built from pfp/, base '/id/')
  if (path === '/id') {
    res.writeHead(302, { location: '/id/' })
    res.end()
    return
  }
  if (path === '/id/' || path.startsWith('/id/')) {
    let sub = path.slice('/id'.length) // '/id/' -> '/', '/id/assets/x' -> '/assets/x'
    if (sub === '/' || sub === '') sub = '/index.html'
    const pfpFull = join(PFP_DIST, sub)
    if (!pfpFull.startsWith(PFP_DIST)) {
      res.writeHead(403)
      res.end()
      return
    }
    try {
      const body = await readFile(pfpFull)
      res.writeHead(200, { 'content-type': MIME[extname(pfpFull)] ?? 'application/octet-stream', ...cacheHeaders(sub) })
      res.end(body)
    } catch {
      res.writeHead(404)
      res.end('not found — build the pfp app first: npx vite build pfp')
    }
    return
  }

  // static client
  let filePath = path === '/' ? '/index.html' : path
  if (!existsSync(join(CLIENT_DIST, filePath))) {
    // A request for a FILE that doesn't exist must 404. It must never fall
    // back to index.html: a browser holding a cached page asks for a hashed
    // bundle that a later deploy deleted, and answering with HTML means the
    // module fails to parse and the world comes up blank forever. Only
    // extensionless paths (SPA routes) fall back.
    if (/\.[a-z0-9]+$/i.test(filePath)) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
      return
    }
    filePath = '/index.html'
  }
  const full = join(CLIENT_DIST, filePath)
  if (!full.startsWith(CLIENT_DIST)) {
    res.writeHead(403)
    res.end()
    return
  }
  try {
    const body = await readFile(full)
    res.writeHead(200, { 'content-type': MIME[extname(full)] ?? 'application/octet-stream', ...cacheHeaders(filePath) })
    res.end(body)
  } catch {
    res.writeHead(404)
    res.end('not found — build the client first: npm run build')
  }
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)
if (isMain || process.env.FIMP_START === '1') {
  const portA = Number(process.env.PORT_A ?? 8787)
  const portB = Number(process.env.PORT_B ?? 8788)
  const urlA = `http://localhost:${portA}`
  const urlB = `http://localhost:${portB}`

  const townA = new Town({
    server: 'freeq-city',
    name: 'Freeq City',
    theme: 'network-noir',
    palette: 'amber-cyan',
    peers: [{ server: 'neonwharf', url: urlB }],
  })
  const townB = new Town({
    server: 'neonwharf',
    name: 'Neon Wharf',
    theme: 'harbor-dusk',
    palette: 'teal-magenta',
    peers: [{ server: 'freeq-city', url: urlA }],
  })

  startTown(townA, portA)
  startTown(townB, portB)
  // one outbound dial is enough: /fed links are bidirectional
  dialPeer(townA, 'neonwharf', urlB)

  console.log(`FreeqWorld up:`)
  console.log(`  Freeq City   ${urlA}  (spawn here)`)
  console.log(`  Neon Wharf   ${urlB}  (federated peer)`)
}
