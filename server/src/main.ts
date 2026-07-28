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
import { appPageWithOg, cardPng, checkFace, clipMp4, facePng, invitePage, inviteView, resolveIdentity, scoreCardPng, scorePage, stingerWav, themeScore, themeWav } from './share.ts'
import type { FaceVariant } from './face.ts'
import {
  completionsFromEvents, levelFor, QUEST_EVENT, QUEST_KINDS, standings, verifyQuestEvent,
} from '../../shared/src/xp'
import { FAMILIAR_EVENT } from '../../shared/src/familiar'
import type { ClientFrame, DurableEvent } from '../../shared/src/protocol'

const CLIENT_DIST = join(fileURLToPath(new URL('.', import.meta.url)), '../../client/dist')
const PFP_DIST = join(fileURLToPath(new URL('.', import.meta.url)), '../../pfp/dist')
const IRC_HTTP = process.env.FREEQ_HTTP ?? 'https://irc.freeq.at'
/** brief cache so a room full of players doesn't hammer the events API */
/** The shape freeq-server returns from /api/v1/channels/{name}/events. */
interface RawEvent {
  actor_did?: string
  event_type?: string
  payload?: unknown
  signature?: string
  timestamp?: number
}

/** The one hatch a player legitimately holds, or null. Verified exactly like a
 *  completion: the witness names itself in the signed payload, and the signature
 *  must check out against the key inside its own did:key. An unsigned or
 *  mismatched hatch is not a familiar. */
async function verifiedHatch(
  events: RawEvent[], did: string,
): Promise<{ name: string; ts: number; witness: string } | null> {
  const found: { name: string; ts: number; witness: string }[] = []
  for (const e of events) {
    if (e.event_type !== FAMILIAR_EVENT) continue
    const p = e.payload as Record<string, string> | undefined
    if (!p?.player || p.player !== did || !p.name) continue
    const witness = e.actor_did ?? p.witness ?? ''
    if ((p.witness ?? witness) !== witness) continue
    if (!(await verifyQuestEvent(p, e.signature, witness))) continue
    found.push({ name: p.name, ts: Number(p.ts ?? e.timestamp ?? 0), witness })
  }
  // the earliest verified hatch wins, so a second one cannot rename a familiar
  found.sort((a, b) => a.ts - b.ts)
  return found[0] ?? null
}

const xpCache = new Map<string, { events: unknown[]; at: number }>()
/** The same app built with base '/' — what the pfp.freeq.at vhost serves. */
const PFP_DIST_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../../pfp/dist-root')

/** Media responses with byte-range support.
 *
 *  Not optional for video: Discord, Telegram, iMessage and every browser
 *  <video> element probe with a Range request first and refuse to play a
 *  response that answers 200 with the whole file instead of 206. */
function sendMedia(
  req: IncomingMessage, res: ServerResponse, body: Buffer, type: string, filename?: string,
  disposition: 'inline' | 'attachment' = 'inline',
): void {
  const headers: Record<string, string> = {
    'content-type': type,
    'accept-ranges': 'bytes',
    'cache-control': 'public, max-age=86400',
  }
  // A card or a WAV wants to render in the page; a score is a file you take
  // away, and a browser shown MusicXML inline just displays a wall of tags.
  if (filename) headers['content-disposition'] = `${disposition}; filename="${filename}"`

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

  // Is an identity wearing the face its DID derives? Zero-trust: we recompute
  // the portrait and compare hashes with their SIGNED profile record.
  if (path.startsWith('/api/face/') || path.startsWith('/id/api/face/')) {
    const who = path.slice(path.indexOf('/api/face/') + '/api/face/'.length)
    try {
      const id = await resolveIdentity(who)
      return json(await checkFace(id))
    } catch (err) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error).message }))
      return
    }
  }

  // The quest catalogue, so the agents describe exactly the runs the rest of the
  // world describes. shared/src/xp.ts is the single source; the agents run under
  // bare node and cannot import TS, so they read it from here.
  if (path === '/api/quests' || path === '/id/api/quests') {
    return json({
      quests: QUEST_KINDS.map((q) => ({
        id: q.id, label: q.label, ask: q.ask, doThis: q.doThis,
        xp: q.xp, alwaysDouble: Boolean(q.alwaysDouble), trust: q.trust,
      })),
    })
  }

  // --- the XP ledger --------------------------------------------------------
  // freeq-server already stores every `+freeq.at/event` TAGMSG durably and
  // serves it at /api/v1/channels/{name}/events — but with no CORS header, so a
  // browser cannot read it. This proxies it same-origin and caches briefly.
  //
  // It is a TRANSPORT, not an authority: each completion carries the witness's
  // ed25519 signature and the client verifies it (shared/src/xp.ts), so this
  // route can omit events but cannot invent one. The raw log stays public:
  //   curl 'https://irc.freeq.at/api/v1/channels/%23general/events?type=quest_complete'
  if (path === '/api/xp' || path === '/id/api/xp') {
    const chans = (url.searchParams.get('channels') ?? '#general,#lobby,#dev')
      .split(',').map((c) => c.trim()).filter((c) => c.startsWith('#')).slice(0, 8)
    // Which signed event types to fetch. Defaults to completions alone so every
    // existing caller is unaffected; the world also asks for familiar_hatched.
    const types = (url.searchParams.get('types') ?? QUEST_EVENT)
      .split(',').map((t) => t.trim()).filter((t) => /^[a-z_]{3,32}$/.test(t)).slice(0, 4)
    const key = `${chans.join(',')}|${types.join(',')}`
    const hit = xpCache.get(key)
    if (hit && Date.now() - hit.at < 30_000) return json({ events: hit.events, cached: true })
    const events: unknown[] = []
    await Promise.all(chans.flatMap((ch) => types.map(async (type) => {
      try {
        const r = await fetch(
          `${IRC_HTTP}/api/v1/channels/${encodeURIComponent(ch)}/events` +
            // the server names this param `type` (web.rs api_channel_events)
            `?type=${encodeURIComponent(type)}&limit=500`,
          { signal: AbortSignal.timeout(6000) },
        )
        if (!r.ok) return
        const body = (await r.json()) as { events?: unknown[] }
        for (const e of body.events ?? []) events.push(e)
      } catch {
        /* one unreachable channel must not empty the whole board */
      }
    })))
    xpCache.set(key, { events, at: Date.now() })
    return json({ events })
  }

  // --- one player's standing, computed here ---------------------------------

  // For the witnessing agents, which run under bare node and cannot import TS:
  // rather than restate the ladder in .mjs (the drift that made a design doc
  // claim rekindle needed no silence), they ask the one implementation.
  if (path === '/api/standing' || path === '/id/api/standing') {
    const did = url.searchParams.get('did')
    if (!did) return json({ error: 'did required' }, 400)
    const chans = (url.searchParams.get('channels') ?? '#general,#lobby,#dev')
      .split(',').map((c) => c.trim()).filter((c) => c.startsWith('#')).slice(0, 8)
    const events: RawEvent[] = []
    await Promise.all(chans.flatMap((ch) => [QUEST_EVENT, FAMILIAR_EVENT].map(async (type) => {
      try {
        const r = await fetch(
          `${IRC_HTTP}/api/v1/channels/${encodeURIComponent(ch)}/events?type=${type}&limit=500`,
          { signal: AbortSignal.timeout(6000) },
        )
        if (!r.ok) return
        const body = (await r.json()) as { events?: RawEvent[] }
        for (const e of body.events ?? []) events.push(e)
      } catch { /* a channel being down must not deny somebody their level */ }
    })))
    const completions = await completionsFromEvents(events)
    const mine = standings(completions).find((s) => s.player === did)
    const xp = mine?.xp ?? 0
    const lv = levelFor(xp)
    // an existing hatch, verified the same way a completion is
    const hatched = await verifiedHatch(events, did)
    return json({
      did, xp, level: lv.level, title: lv.title, nextAt: lv.next?.at ?? null,
      runs: mine?.runs ?? 0, familiar: hatched,
    })
  }

  // The engraver for /score/<who>. On pfp.freeq.at nginx serves this from the
  // static root, but the score page is also reachable at /id/score/... and from
  // a local dev server, where the root static handler is the WORLD client and
  // would 404. One explicit route means the page works wherever it is served.
  if (path === '/osmd.js' || path === '/id/osmd.js') {
    try {
      const body = await readFile(join(path.startsWith('/id/') ? PFP_DIST : PFP_DIST_ROOT, 'osmd.js'))
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'public, max-age=604800, immutable',
      })
      res.end(body)
    } catch {
      // the page degrades to "the downloads still work", so say why in the log
      console.warn('[score] osmd.js missing from the pfp build — run vite build pfp')
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('engraver not built')
    }
    return
  }

  // --- shareable identity pages -------------------------------------------
  // /u/<handle> unfurls as that person's character + tune (a static SPA can't:
  // crawlers don't run JS, so its OG tags can never vary per person).
  // Reachable under /id/... on world.freeq.at and at the root on pfp.freeq.at.
  const share = path.startsWith('/id/') ? path.slice('/id'.length) : path
  // An invitation, unfurling as the person who sent it.
  if (share.startsWith('/i/')) {
    const token = decodeURIComponent(share.slice('/i/'.length))
    const view = await inviteView(token)
    if (!view) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end("that invitation isn't one I signed, or it has expired — ask your host for a fresh one.")
      return
    }
    const local = /^(localhost|127\.|\[?::1)/.test(String(req.headers.host ?? ''))
    const origin = local ? `http://${req.headers.host}` : (process.env.SHARE_ORIGIN ?? 'https://pfp.freeq.at')
    const world = local ? `http://${req.headers.host}` : 'https://world.freeq.at'
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' })
    res.end(await invitePage(view, origin, world))
    return
  }

  const shareMatch = /^\/(u|card|theme|stinger|clip|face|score)\/(.+)$/.exec(share)
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
        // Serve the index.html belonging to the build THIS host serves: the
        // two bases produce different asset hashes, so injecting the wrong one
        // points the browser at a bundle that doesn't exist there.
        const atIdBase = path.startsWith('/id/')
        let index: string
        try {
          index = await readFile(join(atIdBase ? PFP_DIST : PFP_DIST_ROOT, 'index.html'), 'utf8')
        } catch {
          // older image without the second build: fall back and rewrite paths
          index = await readFile(join(PFP_DIST, 'index.html'), 'utf8')
        }
        const html = await appPageWithOg(id, base, index, { basePath: atIdBase ? '/id/' : '/' })
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
      if (kind === 'face') {
        // the canonical portrait: a pure function of the DID, so cache it hard
        const variant: FaceVariant = url.searchParams.get('variant') === 'portrait' ? 'portrait' : 'explorer'
        const { png, cid } = await facePng(id.did, variant)
        res.writeHead(200, {
          'content-type': 'image/png',
          'cache-control': 'public, max-age=604800, immutable',
          'content-length': String(png.length),
          // the hash these exact bytes will have as an AT Proto blob
          'x-freeq-cid': cid,
        })
        res.end(req.method === 'HEAD' ? undefined : png)
        return
      }
      // the theme as engraved sheet music, with the downloads under it
      if (kind === 'score') {
        if (/\.png$/i.test(rawWho)) {
          const png = await scoreCardPng(id)
          sendMedia(req, res, png, 'image/png')
          return
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' })
        res.end(await scorePage(id, base))
        return
      }
      if (kind === 'clip') {
        const mp4 = await clipMp4(id)
        sendMedia(req, res, mp4, 'video/mp4')
        return
      }
      // the same theme, as a score you can open in other software
      if (kind === 'theme') {
        const ext = /\.(mid|midi|musicxml|mxl)$/i.exec(rawWho)?.[1]?.toLowerCase()
        if (ext) {
          const { body, type, filename } = await themeScore(
            id, ext === 'mid' || ext === 'midi' ? 'midi' : 'musicxml',
          )
          sendMedia(req, res, body, type, filename, 'attachment')
          return
        }
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
