#!/usr/bin/env node
// Read-only channel audit: which channels on irc.freeq.at are test debris, and
// — the part that matters — which ones LOOK like debris but are actually in use.
//
//   ssh chad@tech.blueyard.com 'cd /home/chad/src/freeq && sqlite3 -readonly -separator "|" irc.db "
//     select c.name,
//            (select count(*) from messages m where m.channel=c.name),
//            (select count(distinct coalesce(m.sender_did,m.sender)) from messages m where m.channel=c.name),
//            coalesce((select max(m.timestamp) from messages m where m.channel=c.name),0),
//            (select count(*) from user_channels u where u.channel=c.name)
//     from channels c order by c.name;"' > /tmp/chan-stats.txt
//   node scripts/channel-audit.mjs /tmp/chan-stats.txt
//
// Deletion is deliberately NOT automated. It needs the server stopped, a backup,
// and a human looking at the list — see docs/DEPLOYMENT.md.

import { readFileSync } from 'node:fs'
import { isDebris } from '../shared/src/liveWorld.ts'

const NOW = Math.floor(Date.now() / 1000)
const DAY = 86400

/** Never deleted, whatever the name patterns say: the town's own rooms, the
 *  busy channels, and anything a human would notice losing. */
export const KEEP = new Set([
  '#general', '#lobby', '#dev', '#freeq', '#freeq-dev', '#music', '#archive',
  '#agents', '#private-demo', '#federation', '#alexandria', '#random', '#help',
  '#meta', '#announce', '#offtopic',
])

/** Evidence that PEOPLE used a channel.
 *
 *  Recency alone is not evidence: an e2e run leaves a channel with one message
 *  from one sender, and dozens of those looked "active 6 days ago". Real use
 *  means more than one voice, or enough traffic to be a conversation, or enough
 *  members to be a room. */
export function useEvidence(r) {
  if (KEEP.has(r.name)) return 'allowlisted'
  if (r.senders >= 3) return `${r.senders} distinct senders`
  if (r.msgs >= 40) return `${r.msgs} messages`
  if (r.members >= 4) return `${r.members} members`
  const age = r.last ? Math.round((NOW - r.last) / DAY) : Infinity
  if (r.msgs >= 5 && age <= 14) return `${r.msgs} msgs, active ${age}d ago`
  return null
}

export function classify(rows) {
  const debris = []
  const spared = []
  const notDebris = []
  for (const r of rows) {
    if (!isDebris(r.name)) {
      notDebris.push(r)
      continue
    }
    const use = useEvidence(r)
    if (use) spared.push({ ...r, use })
    else debris.push(r)
  }
  return { debris, spared, notDebris }
}

export function parseStats(text) {
  return text.trim().split('\n').filter(Boolean).map((line) => {
    const [name, msgs, senders, last, members] = line.split('|')
    return { name, msgs: +msgs, senders: +senders, last: +last, members: +members }
  })
}

if (process.argv[1] && process.argv[1].endsWith('channel-audit.mjs')) {
  const path = process.argv[2] ?? '/tmp/chan-stats.txt'
  const rows = parseStats(readFileSync(path, 'utf8'))
  const { debris, spared, notDebris } = classify(rows)
  const age = (r) => (r.last ? `${Math.round((NOW - r.last) / DAY)}d` : 'never')

  console.log(`${rows.length} channels: ${notDebris.length} ordinary · ${spared.length} spared by evidence · ${debris.length} debris`)
  console.log('\nSPARED despite a debris-shaped name — this is the safety net:')
  for (const r of spared.sort((a, b) => b.senders - a.senders)) {
    console.log(`  ${r.name.padEnd(26)} ${String(r.msgs).padStart(5)}m ${String(r.senders).padStart(3)}s ${age(r).padStart(6)} ${String(r.members).padStart(2)}mem -> ${r.use}`)
  }
  console.log(`\nDEBRIS (${debris.length} channels, ${debris.reduce((a, r) => a + r.msgs, 0)} messages):`)
  for (const r of debris) console.log(`  ${r.name}`)
}
