#!/usr/bin/env node
// The launch NPCs as REAL freeq clients: stable did:key identities, SASL
// crypto auth, registered as agents with the server, wandering the rooms via
// the same ephemeral world-pos TAGMSGs the browser client uses, and replying
// (rate-limited) when mentioned. No server-side fiction — anyone on any
// client sees them in the member list; the world client sees them walk.
//
//   node scripts/world-agents.mjs [serverWsUrl] [#chan1,#chan2,...]
//
// Seeds persist in .agents/ so each agent keeps its DID (and thus its face).

import { FreeqClient } from '@freeq/sdk'
import nacl from 'tweetnacl'
import { hkdfSync, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SERVER = process.argv[2] ?? 'wss://irc.freeq.at/irc'
const CHANNELS = (process.argv[3] ?? '#general,#lobby,#dev').split(',')

const SEED_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '.agents')
mkdirSync(SEED_DIR, { recursive: true })

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const b58 = (bytes) => {
  const d = [0]
  for (const byte of bytes) {
    let c = byte
    for (let i = 0; i < d.length; i++) { c += d[i] << 8; d[i] = c % 58; c = (c / 58) | 0 }
    while (c) { d.push(c % 58); c = (c / 58) | 0 }
  }
  let out = ''
  for (let i = d.length - 1; i >= 0; i--) out += B58[d[i]]
  return out
}
const b64url = (bytes) => Buffer.from(bytes).toString('base64url')

function identityFor(name) {
  const seedPath = join(SEED_DIR, `${name}.seed`)
  let seed
  if (existsSync(seedPath)) {
    seed = new Uint8Array(readFileSync(seedPath))
  } else {
    seed = new Uint8Array(randomBytes(32))
    writeFileSync(seedPath, seed)
  }
  const kp = nacl.sign.keyPair.fromSeed(seed)
  const did = `did:key:z${b58(new Uint8Array([0xed, 0x01, ...kp.publicKey]))}`
  return { kp, did }
}

const POS_TAG = '+freeq.at/world-pos'

const AGENTS = [
  {
    nick: 'archivist',
    persona: 'The Archivist',
    brain: (ctx) => {
      const m = /(?:search|history)\s+(.+)$/i.exec(ctx.text)
      if (m) {
        const term = m[1].trim().toLowerCase()
        const hits = ctx.history.filter((h) => h.text.toLowerCase().includes(term) && !/archivist/i.test(h.from)).slice(-3)
        if (!hits.length) return `nothing in my stacks for "${m[1].trim()}" — yet. everything said here is durable; it will be remembered.`
        return `from the channel history: ${hits.map((h) => `${h.from} said "${h.text.slice(0, 80)}"`).join(' · ')}`
      }
      return `i remember what this channel says — CHATHISTORY is my library. mention me with "search <term>" and i will quote it.`
    },
  },
  {
    nick: 'cartographer',
    persona: 'The Cartographer',
    brain: (ctx) => {
      const top = ctx.directory.slice(0, 6).map((d) => `${d.name} (${d.count})`).join(', ')
      return `every room in the world is a real channel on this server. the liveliest right now: ${top}. the world client at freeqworld renders LIST as a town.`
    },
  },
]

for (const [i, agent] of AGENTS.entries()) {
  const { kp, did } = identityFor(agent.nick)
  const history = new Map(CHANNELS.map((c) => [c, []]))
  const directory = []

  const client = new FreeqClient({
    url: SERVER,
    nick: agent.nick,
    channels: CHANNELS,
    onNickCollision: 'random-suffix',
    sasl: {
      method: 'crypto',
      did,
      token: '',
      pdsUrl: '',
      signer: async (challenge) => b64url(nacl.sign.detached(challenge, kp.secretKey)),
    },
  })

  client.on('authenticated', (d) => console.log(`[${agent.nick}] authenticated as ${d}`))
  client.on('ready', () => {
    console.log(`[${agent.nick}] ready as ${client.nick}, channels: ${CHANNELS.join(', ')}`)
    try {
      client.registerAgent('agent')
    } catch (e) {
      console.log(`[${agent.nick}] registerAgent unsupported:`, String(e).slice(0, 80))
    }
    client.raw('LIST')
    for (const ch of CHANNELS) client.requestHistory(ch)
  })
  client.on('channelListEntry', (e) => directory.push(e))
  client.on('channelListEnd', () => directory.sort((a, b) => b.count - a.count))
  client.on('historyBatch', (ch, messages) => {
    const buf = history.get(ch)
    if (buf) buf.push(...messages.filter((m) => !m.isSystem && m.text))
  })

  const lastReply = new Map()
  client.on('message', (ch, msg) => {
    if (!CHANNELS.includes(ch) || msg.isSelf || !msg.text) return
    const buf = history.get(ch)
    if (buf) {
      buf.push(msg)
      if (buf.length > 300) buf.shift()
    }
    if (!msg.text.toLowerCase().includes(agent.nick)) return
    const last = lastReply.get(ch) ?? 0
    if (Date.now() - last < 10_000) return
    lastReply.set(ch, Date.now())
    const reply = agent.brain({ text: msg.text, from: msg.from, history: history.get(ch) ?? [], directory })
    setTimeout(() => client.sendMessage(ch, reply), 900 + Math.random() * 900)
  })

  // wander: slow deterministic drift, one ephemeral TAGMSG every ~2.5s
  let seq = 0
  setInterval(() => {
    const t = Date.now() / 6000 + i * 2.1
    const x = 12 + Math.cos(t) * 5 + i * 3
    const y = 8 + Math.sin(t * 0.8) * 3
    const facing = Math.abs(Math.sin(t)) > 0.5 ? (Math.sin(t) < 0 ? 'east' : 'west') : 'south'
    for (const ch of CHANNELS) {
      try {
        client.sendTagmsg(ch, { [POS_TAG]: `${x.toFixed(2)},${y.toFixed(2)},${facing},walk,${++seq}` })
      } catch {
        /* not connected yet */
      }
    }
  }, 2500)

  client.connect()
}

console.log(`world-agents up against ${SERVER} — ctrl-c to stop`)
