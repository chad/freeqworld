import { describe, expect, it } from 'vitest'
import { computeMusicState } from './music'

const NOW = 1_800_000_000_000

function msg(secondsAgo: number, content = 'hello world') {
  return { ts: NOW - secondsAgo * 1000, content }
}

describe('computeMusicState (spec 11.2/11.3)', () => {
  it('returns all five 0..1 parameters plus topic_family', () => {
    const s = computeMusicState({ recentMessages: [], participantCount: 0, now: NOW })
    for (const k of ['energy', 'tension', 'density', 'brightness', 'confidence'] as const) {
      expect(s[k]).toBeGreaterThanOrEqual(0)
      expect(s[k]).toBeLessThanOrEqual(1)
    }
    expect(s.schema).toBe('freeq.at/world/music-state/v1')
  })

  it('quiet empty room is low-energy "quiet" topic', () => {
    const s = computeMusicState({ recentMessages: [], participantCount: 0, now: NOW })
    expect(s.topic_family).toBe('quiet')
    expect(s.energy).toBeLessThan(0.2)
  })

  it('energy and density rise with message rate and participants (spec 33.4)', () => {
    const calm = computeMusicState({ recentMessages: [msg(50)], participantCount: 1, now: NOW })
    const busy = computeMusicState({
      recentMessages: Array.from({ length: 20 }, (_, i) => msg(i * 2)),
      participantCount: 12,
      now: NOW,
    })
    expect(busy.energy).toBeGreaterThan(calm.energy)
    expect(busy.density).toBeGreaterThan(calm.density)
  })

  it('technical vocabulary classifies topic_family as technical', () => {
    const s = computeMusicState({
      recentMessages: [
        msg(5, 'the CRDT merge fails on this signature verification bug'),
        msg(8, 'stack trace says the websocket protocol handshake panics'),
      ],
      participantCount: 3,
      now: NOW,
    })
    expect(s.topic_family).toBe('technical')
  })

  it('argument raises tension (spec 33.4)', () => {
    const friendly = computeMusicState({
      recentMessages: [msg(4, 'nice! love it, thanks so much'), msg(9, 'great work everyone')],
      participantCount: 3,
      now: NOW,
    })
    const heated = computeMusicState({
      recentMessages: [
        msg(2, 'no, you are wrong, that is broken and this disagrees with the spec!'),
        msg(4, 'wrong! never do that, it fails, disagree strongly'),
      ],
      participantCount: 3,
      now: NOW,
    })
    expect(heated.tension).toBeGreaterThan(friendly.tension)
  })

  it('celebration classifies celebratory with high brightness', () => {
    const s = computeMusicState({
      recentMessages: [msg(2, 'congrats on the launch!! 🎉 amazing woohoo'), msg(3, 'yay! awesome!')],
      participantCount: 5,
      now: NOW,
    })
    expect(s.topic_family).toBe('celebratory')
    expect(s.brightness).toBeGreaterThan(0.5)
  })

  it('activity-only mode ignores message content (spec 11.4/24.5)', () => {
    const s = computeMusicState({
      recentMessages: [msg(2, 'congrats!! 🎉'), msg(3, 'yay!')],
      participantCount: 5,
      now: NOW,
      activityOnly: true,
    })
    expect(['quiet', 'social', 'chaotic']).toContain(s.topic_family)
    expect(s.confidence).toBeLessThanOrEqual(0.5)
  })
})
