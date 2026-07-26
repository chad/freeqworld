import { describe, expect, it } from 'vitest'
import { issueDecision, STATELESS_KINDS, type Quest } from '../../scripts/quest.mjs'

// THE REPORTED BUG: "he just sends me the original quest every time no matter
// what i ask for". The ledger holds one run per player and the idempotency check
// ran before the requested kind was looked at, so a pending courier envelope
// answered every request forever.
describe('what a quest request means when you already hold one', () => {
  const courier: Quest = { kind: 'courier', phrase: 'PKT-VC9Y', target: '#lobby' }
  // exactly what the live ledger holds for older entries: no kind field at all
  const legacy = { phrase: 'PKT-0K7S', target: '#lobby' } as Quest

  it('never lets a held run answer a request for a different one', () => {
    for (const want of ['survey', 'rekindle', 'post', 'commit', 'escort']) {
      const d = issueDecision({ held: courier, requested: want })
      expect(d.action, want).toBe('blocked')
      expect(d.holding, want).toBe('courier')
      expect(d.kind, want).toBe(want)
    }
  })

  it('treats a ledger entry with no kind as a courier run', () => {
    expect(issueDecision({ held: legacy, requested: 'face' }).action).toBe('issue')
    expect(issueDecision({ held: legacy, requested: 'survey' })).toMatchObject({ action: 'blocked', holding: 'courier' })
    expect(issueDecision({ held: legacy, requested: 'courier' }).action).toBe('resend')
  })

  it('still re-sends the same kind, so a DM replay cannot invalidate an envelope', () => {
    expect(issueDecision({ held: courier, requested: 'courier' })).toMatchObject({ action: 'resend' })
    expect(issueDecision({ held: { kind: 'post', nonce: 'X', target: '#lobby' }, requested: 'post' }))
      .toMatchObject({ action: 'resend' })
  })

  it('never blocks the runs that keep no slot', () => {
    for (const want of STATELESS_KINDS) {
      expect(issueDecision({ held: courier, requested: want }).action, want).toBe('issue')
    }
  })

  it('issues freely when nothing is held', () => {
    for (const want of ['courier', 'survey', 'post', 'commit', 'face', 'referral']) {
      expect(issueDecision({ held: null, requested: want }).action, want).toBe('issue')
    }
  })
})
