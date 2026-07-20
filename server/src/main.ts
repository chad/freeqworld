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
import type { ClientFrame, DurableEvent } from '../../shared/src/protocol'

const CLIENT_DIST = join(fileURLToPath(new URL('.', import.meta.url)), '../../client/dist')

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
  if (path === '/api/agents') {
    return json(town.getAgents().map((a) => a.member))
  }

  // static client
  let filePath = path === '/' ? '/index.html' : path
  if (!existsSync(join(CLIENT_DIST, filePath))) filePath = '/index.html' // SPA fallback
  const full = join(CLIENT_DIST, filePath)
  if (!full.startsWith(CLIENT_DIST)) {
    res.writeHead(403)
    return res.end()
  }
  try {
    const body = await readFile(full)
    res.writeHead(200, { 'content-type': MIME[extname(full)] ?? 'application/octet-stream' })
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
