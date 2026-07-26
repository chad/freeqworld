// Courier-run bookkeeping, kept pure so it can be tested away from the wire.
//
// Extracted after a real failure: Chad was told "that envelope goes to #lobby"
// while standing in #lobby. The hint assumed the only possible mismatch was the
// ROOM, so whenever the phrase was the thing that didn't match, it sent people
// back to where they already were.
//
// The phrase didn't match because the ledger is keyed by IRC NICK, and a
// player's nick changes with how they signed in. The live log has one human as
// `chadfowler.com`, `chadfowler-4qsyxmns` and `chadfowler-z6mkmrgt`; each got
// its own envelope for the same room, so he held two sealed phrases and only
// one of them could ever be confirmed.

/** Strip a nick down to the person behind it.
 *
 *  The client names a did:key session `<display>-<did-suffix>` and an OAuth
 *  session `<handle>`, so one human shows up as `chadfowler-4qsyxmns` and
 *  `chadfowler.com` (and `nandi` / `nandi.uk` in the same log). Normalising both
 *  to `chadfowler` lets someone finish a run they started in another session.
 *
 *  Deliberately conservative: it is only ever used together with an exact
 *  target-room match, so the worst case of two people sharing a root is that one
 *  completes a run for a room they were also sent to. */
export function courierRoot(nick) {
  let s = String(nick ?? '').toLowerCase().trim()
  s = s.replace(/^[@+~&%]/, '') // IRC status prefixes
  s = s.replace(/-[a-z0-9]{6,}$/, '') // device suffix: -4qsyxmns, -z6mkmrgt
  s = s.replace(/\.[a-z]{2,}(\.[a-z]{2,})*$/, '') // handle domain: chadfowler.com
  return s
}

export function sameCourier(a, b) {
  const ra = courierRoot(a)
  return ra.length > 0 && ra === courierRoot(b)
}

export function phrasesIn(text) {
  return String(text ?? '').toUpperCase().match(/PKT-[A-Z0-9]{4}/g) ?? []
}

/**
 * What a spoken line means for a courier run. `ledger` is the live Map
 * (nick-key -> quest). Returns exactly one of:
 *   complete       confirm it; `stale` names an envelope from an older session
 *                  of the same person that should be retired with it
 *   wrong-room     they hold this envelope, but not here
 *   stale-phrase   right room, but the phrase isn't one we can account for
 *   unknown-phrase a sealed phrase nobody issued (or a lost ledger)
 *   none           nothing courier-shaped happened
 */
export function deliveryOutcome({ ledger, from, channel, text }) {
  const said = phrasesIn(text)
  const key = String(from ?? '').toLowerCase()
  const mine = ledger.get(key)
  const isCourier = Boolean(mine && mine.kind !== 'rekindle' && mine.phrase)

  if (isCourier && channel === mine.target && said.includes(mine.phrase.toUpperCase())) {
    return { kind: 'complete', key, quest: mine } // their own envelope, its room
  }
  if (said.length === 0) return { kind: 'none' }

  // an envelope the same person was issued in another session
  let stale = null
  for (const [k, q] of ledger) {
    if (!q || !q.phrase || k === key) continue
    if (!said.includes(q.phrase.toUpperCase())) continue
    if (!sameCourier(k, from)) continue
    stale = { key: k, quest: q }
    break
  }

  if (isCourier && channel === mine.target && stale) {
    // right room, right person, an older seal: the work was done
    return { kind: 'complete', key, quest: mine, stale, viaStale: true }
  }
  if (stale && channel === stale.quest.target) {
    // no run under this nick, but they carried that one to its room
    return { kind: 'complete', key: stale.key, quest: stale.quest, stale, viaStale: true }
  }
  if (isCourier && said.includes(mine.phrase.toUpperCase())) {
    return { kind: 'wrong-room', quest: mine }
  }
  if (isCourier && channel === mine.target) {
    return { kind: 'stale-phrase', quest: mine, said }
  }
  return { kind: 'unknown-phrase', quest: isCourier ? mine : null, said }
}

/** At issue time: an envelope this person already holds for the same room, from
 *  any of their sessions. Re-sealing one run per nick is what left people
 *  holding two phrases for the same room. */
export function existingEnvelope(ledger, nick, target) {
  for (const [k, q] of ledger) {
    if (!q || !q.phrase || q.target !== target) continue
    if (!sameCourier(k, nick)) continue
    return { key: k, quest: q }
  }
  return null
}

// --- witnessed completions, for the XP ledger -------------------------------
//
// The agent is the witness: it signs a completion naming the player, and emits
// it as a `+freeq.at/event=quest_complete` TAGMSG. freeq-server stores those
// durably (coordination_events) and serves them over HTTP, so levels and
// leaderboards are a computation over a signed public log rather than a score
// the server keeps. Plain IRC clients see nothing — TAGMSG only, and
// deliberately NOT the SDK's emitEvent(), which also sends a companion PRIVMSG.

/** JCS over a flat string map. Mirrored byte-for-byte in shared/src/xp.ts;
 *  shared/src/xp.test.ts signs with this and verifies with that. */
export function questCanonical(payload) {
  const keys = Object.keys(payload).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(String(payload[k]))}`).join(',')}}`
}

/** The payload a witness signs. Flat strings only, so the canonical is stable. */
export function completionPayload({ player, kind, channel, bonus, ts, witness }) {
  return {
    player: String(player),
    kind: String(kind),
    channel: String(channel),
    bonus: bonus ? '1' : '0',
    ts: String(ts ?? Math.floor(Date.now() / 1000)),
    witness: String(witness),
  }
}
