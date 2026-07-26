import { describe, expect, it } from 'vitest'
// the agents run under bare node, so the courier bookkeeping is plain ESM —
// same arrangement as scripts/act.mjs (see shared/src/act.test.ts)
import {
  courierRoot, deliveryOutcome, existingEnvelope, phrasesIn, sameCourier,
  type Ledger,
} from '../../scripts/quest.mjs'

const ledgerOf = (entries: [string, Record<string, unknown>][]): Ledger =>
  new Map(entries as unknown as [string, never][]) as Ledger

describe('who is behind a nick', () => {
  // every one of these pairs is the same human in /tmp/agents-svc.log
  it('sees through the sign-in mode a session used', () => {
    expect(courierRoot('chadfowler-4qsyxmns')).toBe('chadfowler')
    expect(courierRoot('chadfowler-z6mkmrgt')).toBe('chadfowler')
    expect(courierRoot('chadfowler.com')).toBe('chadfowler')
    expect(courierRoot('nandi.uk')).toBe('nandi')
    expect(courierRoot('nandi')).toBe('nandi')
    expect(sameCourier('chadfowler.com', 'chadfowler-4qsyxmns')).toBe(true)
    expect(sameCourier('nandi', 'nandi.uk')).toBe(true)
  })

  it('does not collapse different people', () => {
    expect(sameCourier('nandi.uk', 'chadfowler.com')).toBe(false)
    expect(sameCourier('evan', 'evanescent')).toBe(false)
    expect(sameCourier('', 'chadfowler')).toBe(false)
    // a short trailing token is a name, not a device suffix
    expect(courierRoot('mary-jo')).toBe('mary-jo')
  })

  it('finds sealed phrases in a line however it was typed', () => {
    expect(phrasesIn('PKT-VC9Y')).toEqual(['PKT-VC9Y'])
    expect(phrasesIn('here: pkt-vc9y!')).toEqual(['PKT-VC9Y'])
    expect(phrasesIn('nothing sealed here')).toEqual([])
  })
})

describe('THE REPORTED BUG: told to go to the room he was standing in', () => {
  // Reconstructed from the live log:
  //   quest issued (courier): chadfowler.com        -> #lobby (PKT-VC9Y)
  //   quest issued (courier): chadfowler-4qsyxmns   -> #lobby (PKT-I7CJ)
  // He said one of them in #lobby and was told "that envelope goes to #lobby".
  const ledger = ledgerOf([
    ['chadfowler.com', { kind: 'courier', target: '#lobby', phrase: 'PKT-VC9Y', bonus: true }],
    ['chadfowler-4qsyxmns', { kind: 'courier', target: '#lobby', phrase: 'PKT-I7CJ', bonus: true }],
  ])

  it('completes the run when he says the envelope from his other session', () => {
    const out = deliveryOutcome({
      ledger, from: 'chadfowler-4qsyxmns', channel: '#lobby', text: 'PKT-VC9Y',
    })
    expect(out.kind).toBe('complete')
    if (out.kind !== 'complete') return
    // credited under the nick he's speaking as, and the older seal is named so
    // the agent can retire it too instead of leaving it to confuse him again
    expect(out.key).toBe('chadfowler-4qsyxmns')
    expect(out.stale?.key).toBe('chadfowler.com')
    expect(out.viaStale).toBe(true)
  })

  it('still completes normally when he says his own envelope', () => {
    const out = deliveryOutcome({
      ledger, from: 'chadfowler-4qsyxmns', channel: '#lobby', text: 'delivering PKT-I7CJ',
    })
    expect(out.kind).toBe('complete')
    if (out.kind !== 'complete') return
    expect(out.viaStale).toBeUndefined()
  })

  it('completes even when the run under his current nick is gone', () => {
    const only = ledgerOf([
      ['chadfowler.com', { kind: 'courier', target: '#lobby', phrase: 'PKT-VC9Y' }],
    ])
    const out = deliveryOutcome({ ledger: only, from: 'chadfowler-z6mkmrgt', channel: '#lobby', text: 'PKT-VC9Y' })
    expect(out.kind).toBe('complete')
    if (out.kind !== 'complete') return
    expect(out.key).toBe('chadfowler.com')
  })
})

describe('the other outcomes stay distinguishable', () => {
  const ledger = ledgerOf([
    ['ayla', { kind: 'courier', target: '#lobby', phrase: 'PKT-AAAA' }],
    ['bex', { kind: 'courier', target: '#dev', phrase: 'PKT-BBBB' }],
    ['cass', { kind: 'rekindle', target: '#lobby' }],
  ])

  it('only says "wrong room" when the room is actually wrong', () => {
    const out = deliveryOutcome({ ledger, from: 'ayla', channel: '#dev', text: 'PKT-AAAA' })
    expect(out.kind).toBe('wrong-room')
  })

  it('distinguishes a phrase it cannot account for from a wrong room', () => {
    const out = deliveryOutcome({ ledger, from: 'ayla', channel: '#lobby', text: 'PKT-ZZZZ' })
    expect(out.kind).toBe('stale-phrase') // right room — never claim otherwise
  })

  it('will not let a bystander finish somebody else\u2019s run', () => {
    const out = deliveryOutcome({ ledger, from: 'bex', channel: '#lobby', text: 'PKT-AAAA' })
    expect(out.kind).not.toBe('complete')
    expect(out.kind).toBe('unknown-phrase')
    // and ayla's envelope is untouched
    expect(ledger.get('ayla')).toBeTruthy()
  })

  it('ignores ordinary conversation and rekindle runs', () => {
    expect(deliveryOutcome({ ledger, from: 'ayla', channel: '#lobby', text: 'hello' }).kind).toBe('none')
    expect(deliveryOutcome({ ledger, from: 'cass', channel: '#lobby', text: 'a real sentence here' }).kind).toBe('none')
  })

  it('names the unknown case when there is no run at all', () => {
    const out = deliveryOutcome({ ledger, from: 'nobody', channel: '#lobby', text: 'PKT-QQQQ' })
    expect(out.kind).toBe('unknown-phrase')
    if (out.kind !== 'unknown-phrase') return
    expect(out.quest).toBeNull()
  })
})

describe('not minting a second envelope for the same room', () => {
  it('finds the run this person already holds, whatever nick they used', () => {
    const ledger = ledgerOf([
      ['chadfowler.com', { kind: 'courier', target: '#lobby', phrase: 'PKT-VC9Y' }],
    ])
    const held = existingEnvelope(ledger, 'chadfowler-4qsyxmns', '#lobby')
    expect(held?.quest.phrase).toBe('PKT-VC9Y')
  })

  it('does not reuse an envelope for a different room or person', () => {
    const ledger = ledgerOf([
      ['chadfowler.com', { kind: 'courier', target: '#lobby', phrase: 'PKT-VC9Y' }],
    ])
    expect(existingEnvelope(ledger, 'chadfowler.com', '#dev')).toBeNull()
    expect(existingEnvelope(ledger, 'nandi.uk', '#lobby')).toBeNull()
  })
})

// The nick that started all of this. freeq-server accepts "IRC + AT handles"
// and rejects only control chars, space, NUL, CR, LF and , * ? ! @ # & :
// (connection/mod.rs). The world client was stripping dots too, so an OAuth
// session had to ask for 'chadfowler' instead of 'chadfowler.com'; that nick was
// already bound to another DID, so the server derived 'chadfowler-4qsyxmns'
// (bind_identity_with_fallback: base + first 8 alphanumerics of the DID tail).
describe('a handle survives becoming a nick', () => {
  // mirrors client/src/freeqBackend.ts ircNick
  const ircNick = (name: string): string => {
    const clean = name.replace(/[^A-Za-z0-9_.\-\[\]{}^`|]/g, '').slice(0, 48)
    return /^[A-Za-z]/.test(clean) ? clean : `w${clean}`
  }
  const serverRejects = (nick: string): boolean =>
    nick.length === 0 || nick.length > 64 ||
    [...nick].some((c) => c <= ' ' || ',*?!@#&:'.includes(c))

  it('keeps a full AT handle intact', () => {
    expect(ircNick('chadfowler.com')).toBe('chadfowler.com')
    expect(ircNick('nandi.uk')).toBe('nandi.uk')
    expect(ircNick('alice.bsky.social')).toBe('alice.bsky.social')
  })

  it('still produces something the server will accept', () => {
    for (const name of ['chadfowler.com', 'alice.bsky.social', 'Ayla', 'wanderer-123', '@weird name!']) {
      expect(serverRejects(ircNick(name)), name).toBe(false)
    }
  })

  it('and the handle-derived nick needs no cross-session rescue at all', () => {
    // the whole courier confusion came from the nick changing between sessions
    expect(sameCourier(ircNick('chadfowler.com'), ircNick('chadfowler.com'))).toBe(true)
    expect(courierRoot(ircNick('chadfowler.com'))).toBe('chadfowler')
  })
})
