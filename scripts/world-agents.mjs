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
import { actTags, actKid, signAct, ulid, ACT_SIG_TAG } from './act.mjs'
import {
  deliveryOutcome, existingEnvelope, questCanonical, completionPayload,
  invitePayload, inviteCanonical, encodeInvite,
} from './quest.mjs'
import nacl from 'tweetnacl'
import { hkdfSync, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SERVER = process.argv[2] ?? 'wss://irc.freeq.at/irc'
const CHANNELS = (process.argv[3] ?? '#general,#lobby,#dev').split(',')

/** A room counts as gone quiet after a day of silence; a courier run into a
 *  room quiet for six hours pays double. Both are measured against real message
 *  timestamps (CHATHISTORY + live traffic), not a session buffer. */
const REKINDLE_SILENCE_MS = 24 * 3600 * 1000
const COURIER_BONUS_QUIET_MS = 6 * 3600 * 1000

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

/** Which run the courier asked for. Defaults to the classic courier run. */
function questKind(text) {
  const m = /quest\s+(survey|rekindle|escort|referral|invite)/i.exec(text)
  const kind = m ? m[1].toLowerCase() : 'courier'
  return kind === 'invite' ? 'referral' : kind
}

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
      if (/remember|on this day|oldest|first thing/i.test(ctx.text)) {
        const old = ctx.history.filter((h) => h.text && !/archivist|cartographer/i.test(h.from))[0]
        if (!old) return `my stacks for this room are still empty — give me something to remember.`
        const age = old.timestamp ? Math.round((Date.now() - old.timestamp.getTime()) / 3600000) : null
        return `the earliest thing in my stacks here${age ? ` (${age}h ago)` : ''}: ${old.from} said "${old.text.slice(0, 100)}" — the durable log does not forget.`
      }
      return `i remember what this channel says — CHATHISTORY is my library. mention me with "search <term>", or ask what i "remember".`
    },
    onDm: (ctx) => ctx.agent.brain({ ...ctx, history: ctx.allHistory }),
  },
  {
    nick: 'cartographer',
    persona: 'The Cartographer',
    brain: (ctx) => {
      if (/quest/i.test(ctx.text)) {
        // issueQuest returns the brief it sent — or a refusal, when there is no
        // room quiet enough to rekindle or nobody new to escort. Announcing an
        // envelope that was never sealed is the interface lying about the world.
        const result = ctx.issueQuest(ctx.from, false, questKind(ctx.text))
        const refused = typeof result === 'string' && !/^(COURIER RUN|SURVEY|REKINDLE|ESCORT|your envelope)/.test(result)
        return refused
          ? result
          : `i've sent you a sealed envelope, ${ctx.from}. check your DMs.`
      }
      const top = ctx.directory.slice(0, 6).map((d) => `${d.name} (${d.count})`).join(', ')
      return `every room in the world is a real channel on this server. the liveliest right now: ${top}. say "quest" and i will put you to work.`
    },
    onDm: (ctx) => {
      // a survey answer is a plain DM naming the topic — check it before
      // treating the message as a new request
      const surveyed = ctx.trySurvey(ctx.from, ctx.text)
      if (surveyed) return surveyed
      if (/quest/i.test(ctx.text)) return ctx.issueQuest(ctx.from, true, questKind(ctx.text))
      return `i map channels into rooms. say "quest" for a courier run, "quest survey" to chart a room, "quest rekindle" to wake a quiet one, "quest escort" to make a newcomer welcome, or "quest referral" for an invite that carries your name — real work, verified in the real channel.`
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
  /** channel -> ms epoch of the most recent real message we know of. Seeded from
   *  CHATHISTORY, so it survives a restart and means what it says. */
  const lastMsgAt = new Map()
  const noteActivity = (ch, when) => {
    const ms = when instanceof Date ? when.getTime() : Number(when) || Date.now()
    if (ms > (lastMsgAt.get(ch) ?? 0)) lastMsgAt.set(ch, ms)
  }
  const quietForMs = (ch) => Date.now() - (lastMsgAt.get(ch) ?? 0)

  client.on('coordinationEvent', (ev) => {
    // a newcomer redeeming an invite. This rides the same durable event log as
    // everything else, so the redemption is auditable after the fact.
    if (ev?.eventType !== 'invite_redeem') return
    const token = ev.payload?.token
    if (typeof token === 'string' && ev.from) onInviteRedeem(ev.from, token)
  })

  client.on('historyBatch', (ch, messages) => {
    // everyone already in the logs is a regular, not a newcomer
    for (const m of messages) if (m.from) seen.add(m.from.toLowerCase())
    saveSeen()
    const buf = history.get(ch)
    if (buf) buf.push(...messages.filter((m) => !m.isSystem && m.text))
    for (const m of messages) if (m.text && !m.isSystem) noteActivity(ch, m.timestamp)
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
  // Who has spoken here before. Seeded from CHATHISTORY so long-time regulars
  // are never mistaken for newcomers, and persisted so a restart doesn't make
  // the whole channel "new" again.
  const seenPath = join(SEED_DIR, `seen-${agent.nick}.json`)
  let seen = new Set()
  try {
    if (existsSync(seenPath)) seen = new Set(JSON.parse(readFileSync(seenPath, 'utf8')))
  } catch { /* fresh */ }
  const saveSeen = () => {
    try { writeFileSync(seenPath, JSON.stringify([...seen].slice(-800))) } catch { /* disk hiccup */ }
  }
  /** nickLower -> { nick, channel, ts } for first-timers seen in the last day */
  const newcomers = new Map()

  const questBrief = (nick, q) => {
    if (q.kind === 'survey')
      return `SURVEY for ${nick}: travel to ${q.target}, read what the room says it is, and DM me its topic. i will check your report against the register.`
    if (q.kind === 'rekindle')
      return `REKINDLE for ${nick}: ${q.target} has been silent${q.quietHours ? ` for ${q.quietHours > 47 ? `${Math.floor(q.quietHours / 24)} days` : `${q.quietHours} hours`}` : ''}. go there and say something worth answering — i keep a post there and will witness it. waking a dead room pays double.`
    if (q.kind === 'escort')
      return `ESCORT for ${nick}: ${q.newcomer} is new here and turned up in ${q.target}. greet them BY NAME and draw a reply out of them — the run completes when they answer. a stranger made welcome is worth double.`
    return `COURIER RUN for ${nick}: carry this sealed phrase to ${q.target} and say it aloud: ${q.phrase} — i keep a post there and will confirm the delivery myself.${q.bonus ? ' that room is quiet; the run pays double.' : ''}`
  }

  const issueQuest = (nick, viaDm = false, kind = 'courier') => {
    // quieter rooms pay double — couriers carry life where there is none
    const ranked = CHANNELS.filter((c) => c !== '#general').sort((x, y) => (history.get(x)?.length ?? 0) - (history.get(y)?.length ?? 0))
    const quietest = ranked[0] ?? CHANNELS[0]
    // Idempotent: a pending run is re-sent, never replaced — DM replays on
    // reconnect (or an impatient courier) must not invalidate the envelope.
    // That now includes a run sealed for them under a DIFFERENT nick: a player
    // whose nick changed between sessions was getting a second phrase for the
    // same room and could only ever confirm one of them.
    const existing = quests.get(nick.toLowerCase())
      ?? (kind === 'courier' ? existingEnvelope(quests, nick, quietest)?.quest : null)
    if (existing) {
      const reminder = `your envelope is still sealed, ${nick}. ${questBrief(nick, existing)}`
      if (!viaDm) client.sendMessage(nick, reminder)
      return reminder
    }
    let q
    if (kind === 'survey') {
      // only ask about rooms whose topic we can actually check
      const known = directory.filter((d) => CHANNELS.includes(d.name) && (d.topic ?? '').trim().length > 8)
      const pick = known[Math.floor(Math.random() * known.length)]
      if (!pick) return `nothing needs charting right now, ${nick} — say "quest" for a courier run instead.`
      q = { kind: 'survey', target: pick.name, bonus: false }
    } else if (kind === 'rekindle') {
      // Only a room that has genuinely gone quiet can be rekindled. Before this
      // gate the run paid double for typing one sentence in whichever channel
      // happened to have the fewest messages in this session's buffer — the
      // cheapest XP in the game, and it rewarded talking, which the ledger is
      // supposed to never do.
      const stale = CHANNELS
        .filter((c) => quietForMs(c) >= REKINDLE_SILENCE_MS)
        .sort((x, y) => quietForMs(y) - quietForMs(x))[0]
      if (!stale) {
        return `every room i watch has been spoken in today, ${nick} — nothing to rekindle. say "quest" for a courier run, or come back when somewhere has gone quiet.`
      }
      q = { kind: 'rekindle', target: stale, bonus: true, quietHours: Math.floor(quietForMs(stale) / 3600_000) }
    } else if (kind === 'referral') {
      // no quest ledger entry: the signed token is the record, so an agent
      // restart can never invalidate an invite already in someone's hands
      return mintInvite(nick)
    } else if (kind === 'escort') {
      const day = Date.now() - 24 * 3600 * 1000
      const fresh = [...newcomers.values()]
        .filter((n) => n.ts > day && n.nick.toLowerCase() !== nick.toLowerCase())
        .sort((a, b) => a.ts - b.ts)
      const pick = fresh[0]
      if (!pick) return `nobody new has turned up lately, ${nick} — say "quest" for a courier run and i'll send word when someone arrives.`
      q = { kind: 'escort', target: pick.channel, newcomer: pick.nick, courier: nick, bonus: true }
    } else {
      // double pay for carrying word into a room that has actually been quiet
      q = { kind: 'courier', phrase: `PKT-${Math.random().toString(36).slice(2, 6).toUpperCase()}`, target: quietest, bonus: quietForMs(quietest) >= COURIER_BONUS_QUIET_MS }
    }
    quests.set(nick.toLowerCase(), q)
    saveQuests()
    console.log(`[${agent.nick}] quest issued (${q.kind}): ${nick} -> ${q.target}${q.phrase ? ` (${q.phrase})` : ''}${q.bonus ? ', x2' : ''}`)
    const brief = questBrief(nick, q)
    if (!viaDm) client.sendMessage(nick, brief)
    return brief
  }


  /** Attest a completed run to the durable event log (spec: coordination_events).
   *
   *  The witness signs; the player is named in the payload. Only this agent can
   *  write a completion, and the signature is checked against the public key
   *  inside its own did:key, so nothing between here and a leaderboard can
   *  invent one. TAGMSG only — a plain IRC client sees nothing, and this is
   *  deliberately not the SDK's emitEvent(), which also sends a PRIVMSG. */
  /** Attest for a DID we already hold (referrals know the inviter's DID). */
  const attestCompletionForDid = (playerDid, kind, channel, bonus) => {
    if (!playerDid) return
    try {
      const payload = completionPayload({
        player: playerDid, kind, channel, bonus: Boolean(bonus), witness: did,
      })
      const sig = `ed25519:${actKid(kp.publicKey)}:${b64url(
        nacl.sign.detached(new TextEncoder().encode(questCanonical(payload)), kp.secretKey),
      )}`
      client.sendTagmsg(channel, {
        msgid: ulid(),
        '+freeq.at/event': 'quest_complete',
        '+freeq.at/payload': JSON.stringify(payload).replace(/;/g, '%3B').replace(/ /g, '%20'),
        '+freeq.at/sig': sig,
      })
      console.log(`[${agent.nick}] attested ${kind} for ${playerDid.slice(0, 24)}… in ${channel}${bonus ? ' (x2)' : ''}`)
    } catch (e) {
      console.log(`[${agent.nick}] attest failed:`, String(e).slice(0, 120))
    }
  }

  const attestCompletion = (nick, kind, channel, bonus, retry = true) => {
    // XP belongs to the DID, not the nick — a player's nick changes with how
    // they signed in (see scripts/quest.mjs), and a level must survive that.
    const playerDid = client.getDidForNick?.(nick)
    if (!playerDid) {
      if (retry) {
        // ask, then try once more; never drop the credit silently
        try { client.whois(nick) } catch { /* not connected */ }
        setTimeout(() => attestCompletion(nick, kind, channel, bonus, false), 2500)
        return
      }
      console.log(`[${agent.nick}] cannot attest ${kind} for ${nick}: no DID known`)
      return
    }
    attestCompletionForDid(playerDid, kind, channel, bonus)
  }


  const INVITE_REASON_TEXT = {
    malformed: "that invite link isn't readable — ask for a fresh one",
    'bad-signature': "that invite wasn't signed by me, so i can't honour it",
    expired: 'that invite has expired — ask your host for a new one',
    'self-referral': "that's your own invite; someone else has to use it",
    'not-an-account': 'referrals only count for a real AT Protocol identity — sign in with your Bluesky handle and the credit will land',
    'already-known': 'that identity has spoken here before, so it is not a new arrival',
  }

  /** Verify one of OUR invites. We signed it, so we check it with our own key —
   *  no key resolution, no lookup, no trust in the bearer. */
  const checkInviteToken = (token, redeemer) => {
    const parts = String(token ?? '').split('.')
    if (parts.length !== 2) return { ok: false, reason: 'malformed' }
    let payload
    try {
      payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString())
    } catch {
      return { ok: false, reason: 'malformed' }
    }
    if (payload?.k !== 'invite' || !payload.inviter || !payload.witness) return { ok: false, reason: 'malformed' }
    if (payload.witness !== did) return { ok: false, reason: 'bad-signature' }
    const ok = nacl.sign.detached.verify(
      new TextEncoder().encode(inviteCanonical(payload)),
      Buffer.from(parts[1], 'base64url'),
      kp.publicKey,
    )
    if (!ok) return { ok: false, reason: 'bad-signature' }
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return { ok: false, reason: 'expired', payload }
    if (!redeemer) return { ok: false, reason: 'not-an-account', payload }
    if (redeemer === payload.inviter) return { ok: false, reason: 'self-referral', payload }
    if (!redeemer.startsWith('did:plc:') && !redeemer.startsWith('did:web:')) {
      return { ok: false, reason: 'not-an-account', payload }
    }
    if (seen.has(String(redeemer).toLowerCase())) return { ok: false, reason: 'already-known', payload }
    return { ok: true, payload }
  }

  // ── Referrals ─────────────────────────────────────────────────────────────
  //
  // "X invited me" is unverifiable, so it can never pay. Instead we mint a token
  // bound to the inviter and sign it; the newcomer's client redeems it as a
  // `+freeq.at/event=invite_redeem` TAGMSG, which lands in the same public log
  // as everything else. Credit is attested only once they actually SPEAK, and
  // only for a real AT Protocol identity — a throwaway browser key is free to
  // mint, so allowing it would make self-referral free.
  const invitePath = join(SEED_DIR, `invites-${agent.nick}.json`)
  /** redeemerDid -> { inviter, id, at } — waiting for the newcomer to speak */
  const pendingReferrals = new Map()
  /** "inviter|redeemer" pairs already credited, so a referral pays exactly once */
  const creditedReferrals = new Set()
  try {
    if (existsSync(invitePath)) {
      const saved = JSON.parse(readFileSync(invitePath, 'utf8'))
      for (const [k, v] of Object.entries(saved.pending ?? {})) pendingReferrals.set(k, v)
      for (const k of saved.credited ?? []) creditedReferrals.add(k)
    }
  } catch { /* fresh */ }
  const saveInvites = () => {
    try {
      writeFileSync(invitePath, JSON.stringify({
        pending: Object.fromEntries(pendingReferrals),
        credited: [...creditedReferrals].slice(-2000),
      }))
    } catch { /* disk hiccup */ }
  }

  const REFERRALS_PER_DAY = 5
  const mintInvite = (nick) => {
    const inviter = client.getDidForNick?.(nick)
    if (!inviter) {
      try { client.whois(nick) } catch { /* not connected */ }
      return `i need to know your DID before i can put your name on an invite, ${nick} — try again in a moment.`
    }
    const today = new Date().toISOString().slice(0, 10)
    const usedToday = [...creditedReferrals].filter((k) => k.startsWith(`${inviter}|`) && k.endsWith(`|${today}`)).length
    if (usedToday >= REFERRALS_PER_DAY) {
      return `you've brought ${usedToday} people in today, ${nick} — that's enough for one day. come back tomorrow.`
    }
    const payload = invitePayload({ inviter, witness: did, id: ulid() })
    const sig = nacl.sign.detached(new TextEncoder().encode(inviteCanonical(payload)), kp.secretKey)
    const token = encodeInvite(payload, sig)
    console.log(`[${agent.nick}] invite minted for ${nick} (${inviter.slice(0, 24)}…)`)
    return `REFERRAL for ${nick}: give this to someone who has never been here — https://world.freeq.at/?invite=${token} — the run completes when they arrive with a real Bluesky identity and say something. it pays double, and i will name you as their host.`
  }

  /** A newcomer redeemed an invite: hold it until they speak. */
  const onInviteRedeem = (redeemerNick, token) => {
    const redeemer = client.getDidForNick?.(redeemerNick)
    const check = checkInviteToken(token, redeemer)
    if (!check.ok) {
      console.log(`[${agent.nick}] invite refused (${check.reason}) from ${redeemerNick}`)
      const say = INVITE_REASON_TEXT[check.reason] ?? 'that invite cannot be honoured'
      try { client.sendMessage(redeemerNick, `${say}.`) } catch { /* offline */ }
      return
    }
    if (pendingReferrals.has(redeemer)) return
    pendingReferrals.set(redeemer, { inviter: check.payload.inviter, id: check.payload.id, at: Date.now() })
    saveInvites()
    console.log(`[${agent.nick}] invite redeemed by ${redeemerNick} (host ${check.payload.inviter.slice(0, 24)}…) — awaiting first words`)
    try {
      client.sendMessage(redeemerNick, `welcome — you arrived on an invite. say something in the room and your host gets the credit.`)
    } catch { /* offline */ }
  }

  /** Their first real sentence completes their host's run. */
  const creditReferralIfSpoken = (speakerNick, ch, text) => {
    const speaker = client.getDidForNick?.(speakerNick)
    if (!speaker) return
    const pend = pendingReferrals.get(speaker)
    if (!pend || text.trim().length < 12) return
    const today = new Date().toISOString().slice(0, 10)
    const key = `${pend.inviter}|${speaker}|${today}`
    if (creditedReferrals.has(key)) return
    creditedReferrals.add(key)
    pendingReferrals.delete(speaker)
    saveInvites()
    console.log(`[${agent.nick}] referral complete: ${pend.inviter.slice(0, 24)}… brought ${speaker.slice(0, 24)}…`)
    attestCompletionForDid(pend.inviter, 'referral', ch, true)
    setTimeout(() => {
      client.sendMessage(ch, `⭐⭐ ${speakerNick} arrived on an invite and spoke — a new identity in the world. their host's referral is complete, and the channel bore witness.`)
    }, 700)
  }

  /** A survey is completed over DM: the courier reports the topic they read. */
  const trySurvey = (nick, text) => {
    const q = quests.get(nick.toLowerCase())
    if (!q || q.kind !== 'survey') return null
    const entry = directory.find((d) => d.name === q.target)
    const topic = (entry?.topic ?? '').toLowerCase()
    if (!topic) return null
    // accept a report that carries the distinctive words of the real topic
    const words = topic.split(/\W+/).filter((w) => w.length > 3)
    const said = text.toLowerCase()
    const hits = words.filter((w) => said.includes(w)).length
    if (hits < Math.min(2, words.length)) return null
    quests.delete(nick.toLowerCase())
    saveQuests()
    console.log(`[${agent.nick}] quest complete (survey): ${nick} charted ${q.target}`)
    attestCompletion(nick, 'survey', q.target, Boolean(q.bonus))
    setTimeout(() => client.sendMessage(q.target, `⭐ ${nick} charted this room and the register agrees. the map is truer than it was.`), 700)
    return `that matches the register, ${nick}. ⭐ ${q.target} is charted. say "quest" whenever you want another run.`
  }
  const ctxFor = (msg, ch) => ({
    agent,
    text: msg.text,
    from: msg.from,
    history: history.get(ch) ?? [],
    allHistory: [...history.values()].flat(),
    directory,
    issueQuest,
    trySurvey,
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
    // record real activity AFTER the quest checks below have read it, so a
    // rekindle is judged on the silence that existed before this line
    const noteThisMessage = () => noteActivity(ch, msg.timestamp ?? Date.now())
    setTimeout(noteThisMessage, 0)

    const fromKey = msg.from.toLowerCase()
    // a voice never heard here before — someone worth welcoming
    if (!seen.has(fromKey)) {
      seen.add(fromKey)
      saveSeen()
      newcomers.set(fromKey, { nick: msg.from, channel: ch, ts: Date.now() })
      console.log(`[${agent.nick}] newcomer: ${msg.from} in ${ch}`)
    }

    // a newcomer who arrived on an invite: their first real sentence completes
    // their host's referral
    creditReferralIfSpoken(msg.from, ch, msg.text)

    // ESCORT, half one: the courier greets the newcomer by name
    const mine = quests.get(fromKey)
    if (mine?.kind === 'escort' && ch === mine.target && !mine.greeted && msg.text.toLowerCase().includes(mine.newcomer.toLowerCase())) {
      mine.greeted = Date.now()
      saveQuests()
      console.log(`[${agent.nick}] escort greeted: ${msg.from} -> ${mine.newcomer}`)
    }
    // ESCORT, half two: the newcomer answers. Only then is anyone welcomed —
    // this is why the run can't be farmed by shouting hello at an empty room.
    for (const [courierKey, q] of [...quests]) {
      if (q.kind !== 'escort' || !q.greeted || ch !== q.target) continue
      // live events arrive in order, so anything here is after the greeting
      if (fromKey !== q.newcomer.toLowerCase()) continue
      quests.delete(courierKey)
      saveQuests()
      console.log(`[${agent.nick}] quest complete (escort): ${q.courier} welcomed ${q.newcomer}`)
      attestCompletion(q.courier, 'escort', ch, true)
      setTimeout(() => {
        client.sendMessage(ch, `⭐⭐ ${q.newcomer} was greeted by ${q.courier} — and answered. a stranger is a stranger only once; the channel bore witness.`)
        client.sendMessage(q.courier, `quest complete, ${q.courier}. ⭐⭐ you made ${q.newcomer} welcome. say "quest" whenever you want another run.`)
      }, 700)
      return
    }

    // quest completion. The courier decision lives in scripts/quest.mjs so it can
    // be tested off the wire (shared/src/quest.test.ts) — it was silently wrong
    // for anyone whose nick changed between sessions.
    const quest = quests.get(msg.from.toLowerCase())
    const delivery = deliveryOutcome({ ledger: quests, from: msg.from, channel: ch, text: msg.text })
    // a rekindle is witnessed, not spoken: any real sentence in the quiet room
    const isRekindle = quest?.kind === 'rekindle' && ch === quest.target && msg.text.trim().length >= 12
    if (delivery.kind === 'complete' || isRekindle) {
      const done = isRekindle ? quest : delivery.quest
      quests.delete(isRekindle ? msg.from.toLowerCase() : delivery.key)
      // retire the envelope from their other session too, or it will confuse
      // them again the next time they say it
      if (delivery.kind === 'complete' && delivery.stale) quests.delete(delivery.stale.key)
      saveQuests()
      console.log(
        `[${agent.nick}] quest complete (${done.kind}): ${msg.from} in ${ch}` +
          (delivery.viaStale ? ` (carried ${delivery.stale.quest.phrase}, sealed for ${delivery.stale.key})` : ''),
      )
      attestCompletion(msg.from, done.kind, ch, done.bonus)
      const stars = done.bonus ? '⭐⭐' : '⭐'
      setTimeout(() => {
        client.sendMessage(
          ch,
          isRekindle
            ? `${stars} this room was silent, and ${msg.from} spoke first. rekindled — the channel bore witness.`
            : `${stars} delivery confirmed — ${msg.from} carried ${delivery.viaStale ? delivery.stale.quest.phrase : done.phrase} across the network${done.bonus ? ' into a quiet room' : ''}. the courier run is complete; the channel bore witness.`,
        )
        client.sendMessage(msg.from, `quest complete, ${msg.from}. ${stars} say "quest" whenever you want another run.`)
      }, 700)
      return
    }
    // A sealed phrase we could not confirm. This used to answer every case with
    // "that envelope goes to <target>" — including when the courier was ALREADY
    // STANDING IN <target> and the phrase was the thing that did not match, so
    // it sent people back to the room they were in. Say what actually happened.
    if (agent.nick === 'cartographer' && delivery.kind !== 'none') {
      console.log(
        `[${agent.nick}] delivery refused (${delivery.kind}): ${msg.from} in ${ch}` +
          ` said ${(delivery.said ?? []).join(',') || '-'}` +
          ` expected ${delivery.quest ? `${delivery.quest.phrase} in ${delivery.quest.target}` : 'nothing on file'}`,
      )
      const last = lastReply.get(`lost:${msg.from}`) ?? 0
      if (Date.now() - last > 30_000) {
        lastReply.set(`lost:${msg.from}`, Date.now())
        const q = delivery.quest
        const hint = delivery.kind === 'wrong-room'
          ? `right phrase, wrong room, ${msg.from} — that envelope goes to ${q.target}. say ${q.phrase} there and i will confirm it.`
          : delivery.kind === 'stale-phrase'
            ? `you're in the right room, ${msg.from}, but that isn't the seal i cut for you — yours is ${q.phrase}. say that here and it's done.`
            : q
              ? `that seal isn't the one in my ledger, ${msg.from} — yours is ${q.phrase} for ${q.target}.`
              : `that envelope isn't in my ledger, ${msg.from} — my fault, not yours. say "quest" and i will cut you a fresh one.`
        setTimeout(() => client.sendMessage(ch, hint), 700)
      }
      return
    }

    if (!msg.text.toLowerCase().includes(agent.nick)) return

    // A quest request must never be swallowed by the ambient-chatter cooldown.
    // The per-channel 10s gate below is right for keeping the room calm, but in
    // a crowded #lobby (say, a launch) it would silently drop everyone who asks
    // for a quest within 10s of the last reply — the "cartographer isn't
    // responding" bug. Quest issuance is idempotent and delivered by DM, so we
    // gate it PER USER instead: every courier who asks gets their envelope.
    if (agent.nick === 'cartographer' && /quest/i.test(msg.text)) {
      const qkey = `quest:${msg.from.toLowerCase()}`
      if (Date.now() - (lastReply.get(qkey) ?? 0) < 8_000) return
      lastReply.set(qkey, Date.now())
      const reply = agent.brain(ctxFor(msg, ch))
      if (reply) setTimeout(() => client.sendMessage(ch, reply), 500 + Math.random() * 500)
      return
    }

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

  // ── Open work, posted as real `freeq.at/act` handoffs ────────────────────
  //
  // Reuse, not reinvent: a courier run IS a handoff — a unit of work offered,
  // claimed, and completed. So these are `act=handoff` with the RFC's own verb
  // set, signed with the agent's ed25519 key over the same canonical the Rust
  // implementation uses. An open offer carries no `act-to`: unassigned is the
  // natural encoding of unassigned, and the channel it lands in is the queue.
  //
  // They ride TAGMSG, so a conventional IRC client sees nothing at all.
  const OPEN_RUNS = [
    { caps: 'freeq.at/courier', title: 'Courier run — carry a sealed phrase to another room' },
    { caps: 'freeq.at/survey', title: 'Survey — chart a room and report its topic' },
    { caps: 'freeq.at/rekindle', title: 'Rekindle — speak first in a room gone quiet' },
    { caps: 'freeq.at/escort', title: 'Escort — make a newcomer welcome' },
  ]
  const openOffers = new Map() // caps -> act-id, so the board sees stable ids

  const postOpenOffers = () => {
    if (agent.nick !== 'cartographer') return
    for (const run of OPEN_RUNS) {
      const id = openOffers.get(run.caps) ?? ulid()
      openOffers.set(run.caps, id)
      const tags = actTags({
        kind: 'handoff',
        verb: 'offer',
        id,
        from: did,
        title: run.title,
        caps: run.caps,
      })
      tags[ACT_SIG_TAG] = signAct(tags, kp.secretKey, kp.publicKey)
      for (const ch of CHANNELS) {
        try {
          client.sendTagmsg(ch, tags)
        } catch { /* not connected yet */ }
      }
    }
  }

  // Re-post periodically: TAGMSGs are ephemeral and never enter CHATHISTORY,
  // so a client that just arrived has to hear the offers fresh.
  client.on('ready', () => setTimeout(postOpenOffers, 3000))
  setInterval(postOpenOffers, 90_000)

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
