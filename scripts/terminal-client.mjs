#!/usr/bin/env node
// A conventional Freeq client in ~80 lines of terminal. It joins the same
// channel the RPG renders — proof that the world is a projection, not a silo.
//
//   node scripts/terminal-client.mjs [#channel] [name] [serverUrl]

import { WebSocket } from 'ws'
import { createInterface } from 'node:readline'
import nacl from 'tweetnacl'

const channel = process.argv[2] ?? '#lobby'
const name = process.argv[3] ?? `term-${Math.floor(Math.random() * 1000)}`
const server = (process.argv[4] ?? 'http://localhost:8787').replace(/^http/, 'ws')

// same signing scheme as the browser client: ed25519 → did:key
const kp = nacl.sign.keyPair()
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const b58 = (bytes) => {
  const d = [0]
  for (const byte of bytes) {
    let c = byte
    for (let i = 0; i < d.length; i++) { c += d[i] << 8; d[i] = c % 58; c = (c / 58) | 0 }
    while (c) { d.push(c % 58); c = (c / 58) | 0 }
  }
  let out = ''
  for (const byte of bytes) { if (byte === 0) out += B58[0]; else break }
  for (let i = d.length - 1; i >= 0; i--) out += B58[d[i]]
  return out
}
const did = `did:key:z${b58(new Uint8Array([0xed, 0x01, ...kp.publicKey]))}`
const canonical = (v) => JSON.stringify(sort(v))
const sort = (v) => Array.isArray(v) ? v.map(sort) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v

const ws = new WebSocket(`${server}/ws`)
const dim = (s) => `\x1b[2m${s}\x1b[0m`
const cyan = (s) => `\x1b[36m${s}\x1b[0m`
const amber = (s) => `\x1b[33m${s}\x1b[0m`

ws.on('open', () => {
  ws.send(JSON.stringify({ t: 'hello', did, handle: `${name}.term`, display_name: name, channel, client_instance: 'terminal' }))
})

ws.on('message', (data) => {
  const f = JSON.parse(String(data))
  if (f.t === 'welcome') {
    console.log(dim(`connected to ${f.town.name} (${f.town.server}) · ${channel} · you are ${did.slice(0, 24)}…`))
    for (const e of f.history.slice(-20)) print(e)
    console.log(dim('type to talk · ctrl-c to leave'))
  } else if (f.t === 'event') {
    print(f.durable)
  } else if (f.t === 'member' && f.online) {
    console.log(dim(`· ${f.member.display_name} arrived`))
  } else if (f.t === 'error') {
    console.log(amber(`! ${f.message}`))
  }
})

function print(e) {
  if (e.kind !== 'message') return
  const m = e.event
  const who = m.provenance ? amber(`${m.sender_name}⚙`) : cyan(m.sender_name)
  console.log(`${who} ${m.enc ? dim('✉ [encrypted]') : m.content}`)
}

const queued = []
const say = (content) => {
  const base = { id: crypto.randomUUID(), channel, sender: did, content, type: 'text', ts: Date.now() }
  const sig = b58(nacl.sign.detached(new TextEncoder().encode(canonical(base)), kp.secretKey))
  ws.send(JSON.stringify({ t: 'msg', event: { ...base, signature: sig } }))
}
ws.on('open', () => queued.splice(0).forEach(say))

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const content = line.trim()
  if (!content) return
  if (ws.readyState === WebSocket.OPEN) say(content)
  else queued.push(content)
})

rl.on('close', () => setTimeout(() => process.exit(0), 800)) // piped stdin: flush then leave
ws.on('close', () => process.exit(0))
