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
    onDm: (ctx) => ctx.agent.brain({ ...ctx, history: ctx.allHistory }),
  },
  {
    nick: 'cartographer',
    persona: 'The Cartographer',
    brain: (ctx) => {
      if (/quest/i.test(ctx.text)) {
        ctx.issueQuest(ctx.from)
        return `i've sent you a sealed envelope, ${ctx.from}. check your DMs.`
      }
      const top = ctx.directory.slice(0, 6).map((d) => `${d.name} (${d.count})`).join(', ')
      return `every room in the world is a real channel on this server. the liveliest right now: ${top}. say "quest" and i will put you to work.`
    },
    onDm: (ctx) => {
      if (/quest/i.test(ctx.text)) return ctx.issueQuest(ctx.from, true)
      return `i map channels into rooms. say "quest" for a courier run — real work, verified in the real channel.`
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

  // courier quests: issued over DM, completed by saying the phrase in the
  // real target channel — the agent is a member there and verifies for real.
  // Pending quests persist to disk so an agent restart never eats a delivery.
  const questPath = join(SEED_DIR, `quests-${agent.nick}.json`)
  const quests = new Map() // nickLower -> { phrase, target, bonus }
  try {
    if (existsSync(questPath)) {
      for (const [k, v] of Object.entries(JSON.parse(readFileSync(questPath, 'utf8')))) quests.set(k, v)
      if (quests.size) console.log(`[${agent.nick}] restored ${quests.size} pending quest(s)`)
    }
  } catch { /* fresh ledger */ }
  const saveQuests = () => {
    try { writeFileSync(questPath, JSON.stringify(Object.fromEntries(quests))) } catch { /* disk hiccup */ }
  }
  const AGENT_NICKS = AGENTS.map((a) => a.nick)
  const issueQuest = (nick, viaDm = false) => {
    // quieter rooms pay double — couriers carry life where there is none
    const ranked = CHANNELS.filter((c) => c !== '#general').sort((x, y) => (history.get(x)?.length ?? 0) - (history.get(y)?.length ?? 0))
    const target = ranked[0] ?? CHANNELS[0]
    const bonus = (history.get(target)?.length ?? 0) < 5
    const phrase = `PKT-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
    quests.set(nick.toLowerCase(), { phrase, target, bonus })
    saveQuests()
    console.log(`[${agent.nick}] quest issued: ${nick} -> ${target} (${phrase}${bonus ? ', x2' : ''})`)
    const brief = `COURIER RUN for ${nick}: carry this sealed phrase to ${target} and say it aloud: ${phrase} — i keep a post there and will confirm the delivery myself.${bonus ? ' that room is quiet; the run pays double.' : ''}`
    if (!viaDm) client.sendMessage(nick, brief)
    return brief
  }
  const ctxFor = (msg, ch) => ({
    agent,
    text: msg.text,
    from: msg.from,
    history: history.get(ch) ?? [],
    allHistory: [...history.values()].flat(),
    directory,
    issueQuest,
  })

  const lastReply = new Map()
  client.on('message', (ch, msg) => {
    if (msg.isSelf || !msg.text || AGENT_NICKS.some((n) => msg.from.toLowerCase().startsWith(n))) return

    // direct message → the agent's DM brain
    if (!ch.startsWith('#') && !ch.startsWith('&')) {
      if (!agent.onDm || ch === 'server') return
      const last = lastReply.get(`dm:${msg.from}`) ?? 0
      if (Date.now() - last < 5_000) return
      lastReply.set(`dm:${msg.from}`, Date.now())
      const reply = agent.onDm(ctxFor(msg, ch))
      if (reply) setTimeout(() => client.sendMessage(msg.from, reply), 600 + Math.random() * 600)
      return
    }

    if (!CHANNELS.includes(ch)) return
    const buf = history.get(ch)
    if (buf) {
      buf.push(msg)
      if (buf.length > 300) buf.shift()
    }

    // quest completion: the right courier says the right phrase in the right room
    const quest = quests.get(msg.from.toLowerCase())
    if (quest && ch === quest.target && msg.text.toUpperCase().includes(quest.phrase.toUpperCase())) {
      quests.delete(msg.from.toLowerCase())
      saveQuests()
      console.log(`[${agent.nick}] quest complete: ${msg.from} delivered ${quest.phrase} in ${ch}`)
      const stars = quest.bonus ? '⭐⭐' : '⭐'
      setTimeout(() => {
        client.sendMessage(ch, `${stars} delivery confirmed — ${msg.from} carried ${quest.phrase} across the network${quest.bonus ? ' into a quiet room' : ''}. the courier run is complete; the channel bore witness.`)
        client.sendMessage(msg.from, `quest complete, ${msg.from}. ${stars} say "quest" whenever you want another run.`)
      }, 700)
      return
    }
    // a sealed phrase with no matching ledger entry (wrong room, or issued
    // before a restart in the days before the ledger persisted): own it
    if (agent.nick === 'cartographer' && /PKT-[A-Z0-9]{4}/i.test(msg.text)) {
      const pending = quests.get(msg.from.toLowerCase())
      const last = lastReply.get(`lost:${msg.from}`) ?? 0
      if (Date.now() - last > 30_000) {
        lastReply.set(`lost:${msg.from}`, Date.now())
        const hint = pending
          ? `that envelope goes to ${pending.target}, ${msg.from} — say ${pending.phrase} there and i will confirm it.`
          : `that envelope isn't in my ledger, ${msg.from} — my fault, not yours. say "quest" and i will cut you a fresh one.`
        setTimeout(() => client.sendMessage(ch, hint), 700)
      }
      return
    }

    if (!msg.text.toLowerCase().includes(agent.nick)) return
    const last = lastReply.get(ch) ?? 0
    if (Date.now() - last < 10_000) return
    lastReply.set(ch, Date.now())
    const reply = agent.brain(ctxFor(msg, ch))
    if (reply) setTimeout(() => client.sendMessage(ch, reply), 900 + Math.random() * 900)
  })

  // quiet mode: an NPC only wanders (and beacons position TAGMSGs) in a
  // channel where a world client is actually present — detected by having
  // seen someone else's world-pos TAGMSG there recently. Plain IRC users
  // never receive NPC movement noise.
  const watchers = new Map() // channel -> last world-pos seen (ms)
  client.on('raw', (_line, parsed) => {
    if (parsed.command !== 'TAGMSG') return
    const from = (parsed.prefix ?? '').split('!')[0] ?? ''
    if (!from || AGENT_NICKS.some((n) => from.toLowerCase().startsWith(n))) return
    if (parsed.tags[POS_TAG] ?? parsed.tags[POS_TAG.slice(1)]) {
      const target = parsed.params?.[0]
      if (target) watchers.set(target, Date.now())
    }
  })

  let seq = 0
  setInterval(() => {
    const t = Date.now() / 6000 + i * 2.1
    const x = 12 + Math.cos(t) * 5 + i * 3
    const y = 8 + Math.sin(t * 0.8) * 3
    const facing = Math.abs(Math.sin(t)) > 0.5 ? (Math.sin(t) < 0 ? 'east' : 'west') : 'south'
    for (const ch of CHANNELS) {
      if (Date.now() - (watchers.get(ch) ?? 0) > 60_000) continue // nobody watching — stand still, stay silent
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
