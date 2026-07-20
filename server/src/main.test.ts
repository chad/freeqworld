import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { dialPeer, startTown, type RunningTown } from './main'
import { Town } from './town'
import { didFromPublicKey, generateKeypair, signEvent } from '../../shared/src/signing'
import type { ServerFrame } from '../../shared/src/protocol'

const PORT_A = 18787
const PORT_B = 18788

let a: RunningTown
let b: RunningTown

beforeAll(async () => {
  const townA = new Town({ server: 'town-a', name: 'A', theme: '', palette: '', peers: [{ server: 'town-b', url: `http://localhost:${PORT_B}` }] }, { agentDelayMs: 10 })
  const townB = new Town({ server: 'town-b', name: 'B', theme: '', palette: '', peers: [{ server: 'town-a', url: `http://localhost:${PORT_A}` }] }, { agentDelayMs: 10 })
  a = startTown(townA, PORT_A)
  b = startTown(townB, PORT_B)
  dialPeer(townA, 'town-b', `http://localhost:${PORT_B}`)
  await new Promise((r) => setTimeout(r, 300))
})

afterAll(() => {
  a.close()
  b.close()
})

function wsClient(port: number): Promise<{ ws: WebSocket; frames: ServerFrame[]; waitFor: (pred: (f: ServerFrame) => boolean, ms?: number) => Promise<ServerFrame> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`)
    const frames: ServerFrame[] = []
    const waiters: { pred: (f: ServerFrame) => boolean; resolve: (f: ServerFrame) => void }[] = []
    ws.on('message', (data) => {
      const frame = JSON.parse(String(data)) as ServerFrame
      frames.push(frame)
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i]!.pred(frame)) {
          waiters[i]!.resolve(frame)
          waiters.splice(i, 1)
        }
      }
    })
    ws.on('open', () =>
      resolve({
        ws,
        frames,
        waitFor: (pred, ms = 3000) =>
          new Promise((res, rej) => {
            const hit = frames.find(pred)
            if (hit) return res(hit)
            waiters.push({ pred, resolve: res })
            setTimeout(() => rej(new Error('timeout waiting for frame')), ms)
          }),
      }),
    )
    ws.on('error', reject)
  })
}

describe('socket shell integration', () => {
  it('serves town profile and rooms over HTTP', async () => {
    const town = await fetch(`http://localhost:${PORT_A}/api/town`).then((r) => r.json())
    expect(town.server).toBe('town-a')
    const rooms = await fetch(`http://localhost:${PORT_A}/api/rooms`).then((r) => r.json())
    expect(rooms.length).toBeGreaterThanOrEqual(7)
  })

  it('full round trip: hello, signed message, broadcast to a second socket', async () => {
    const c1 = await wsClient(PORT_A)
    const c2 = await wsClient(PORT_A)
    const kp = generateKeypair()
    const did = didFromPublicKey(kp.publicKey)
    c1.ws.send(JSON.stringify({ t: 'hello', did, handle: 'ada.test', display_name: 'ada', channel: '#lobby', client_instance: 'ci-1' }))
    const kp2 = generateKeypair()
    c2.ws.send(JSON.stringify({ t: 'hello', did: didFromPublicKey(kp2.publicKey), handle: 'g.test', display_name: 'grace', channel: '#lobby', client_instance: 'ci-2' }))
    await c1.waitFor((f) => f.t === 'welcome')
    await c2.waitFor((f) => f.t === 'welcome')
    const base = { id: crypto.randomUUID(), channel: '#lobby', sender: did, content: 'over the wire', type: 'text' as const, ts: Date.now() }
    c1.ws.send(JSON.stringify({ t: 'msg', event: { ...base, signature: signEvent(base, kp.secretKey) } }))
    const got = await c2.waitFor((f) => f.t === 'event' && f.durable.kind === 'message' && f.durable.event.content === 'over the wire')
    expect(got.t).toBe('event')
    c1.ws.close()
    c2.ws.close()
  })

  it('federates #federation messages across two real servers', async () => {
    const onA = await wsClient(PORT_A)
    const onB = await wsClient(PORT_B)
    const kp = generateKeypair()
    const did = didFromPublicKey(kp.publicKey)
    onA.ws.send(JSON.stringify({ t: 'hello', did, handle: 'ada.test', display_name: 'ada', channel: '#federation', client_instance: 'ci-3' }))
    const kpB = generateKeypair()
    onB.ws.send(JSON.stringify({ t: 'hello', did: didFromPublicKey(kpB.publicKey), handle: 'bob.test', display_name: 'bob', channel: '#federation', client_instance: 'ci-4' }))
    await onA.waitFor((f) => f.t === 'welcome')
    await onB.waitFor((f) => f.t === 'welcome')
    const base = { id: crypto.randomUUID(), channel: '#federation', sender: did, content: 'crossing the border', type: 'text' as const, ts: Date.now() }
    onA.ws.send(JSON.stringify({ t: 'msg', event: { ...base, signature: signEvent(base, kp.secretKey) } }))
    const got = await onB.waitFor((f) => f.t === 'event' && f.durable.kind === 'message' && f.durable.event.content === 'crossing the border')
    if (got.t !== 'event' || got.durable.kind !== 'message') throw new Error('bad')
    expect(got.durable.event.origin_server).toBe('town-a')
    onA.ws.close()
    onB.ws.close()
  })
})
