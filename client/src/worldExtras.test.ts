import { describe, expect, it } from 'vitest'
import { familiarFor, imageUrlsIn, threadsOf } from './worldExtras'

describe('threadsOf: real reply threads become places (spec 9.3)', () => {
  const msg = (id: string, ts: number, root?: string) => ({ id, ts, thread_root: root, sender_name: `u-${id}`, content: `m${id}` })

  it('groups replies under their root and counts participants', () => {
    const log = [msg('a', 1), msg('b', 2, 'a'), msg('c', 3, 'a'), msg('d', 4), msg('e', 5, 'd')]
    const threads = threadsOf(log)
    expect(threads.length).toBe(2)
    const ta = threads.find((t) => t.root === 'a')!
    expect(ta.count).toBe(3) // root + two replies
    expect(ta.lastTs).toBe(3)
  })

  it('ignores unthreaded chatter and replies to unknown roots count too', () => {
    const log = [msg('x', 1), msg('y', 2)]
    expect(threadsOf(log).length).toBe(0)
    const orphan = [msg('r1', 5, 'gone')]
    expect(threadsOf(orphan)[0]!.root).toBe('gone') // the root scrolled out of history — thread still real
  })

  it('is capped to the most recent threads', () => {
    const log: ReturnType<typeof msg>[] = []
    for (let i = 0; i < 30; i++) {
      log.push(msg(`r${i}`, i * 10))
      log.push(msg(`c${i}`, i * 10 + 1, `r${i}`))
    }
    expect(threadsOf(log).length).toBeLessThanOrEqual(6)
  })
})

describe('imageUrlsIn: real channel media hangs on the walls', () => {
  it('finds freeq media links and plain image urls', () => {
    const urls = imageUrlsIn('look https://irc.freeq.at/api/v1/media/Vod2zKTdRkGrMX6YO3X7FQ/image.png and https://example.com/cat.jpg done')
    expect(urls).toEqual([
      'https://irc.freeq.at/api/v1/media/Vod2zKTdRkGrMX6YO3X7FQ/image.png',
      'https://example.com/cat.jpg',
    ])
  })

  it('ignores non-image links', () => {
    expect(imageUrlsIn('see https://github.com/chad/freeq please')).toEqual([])
  })
})

describe('familiarFor: deterministic companions', () => {
  it('gives the same DID the same familiar everywhere, and only some players have one', () => {
    const a = familiarFor('did:plc:ewvi7nmzuoqusbcablsm7c4h')
    const b = familiarFor('did:plc:ewvi7nmzuoqusbcablsm7c4h')
    expect(a).toEqual(b)
    const kinds = new Set<string>()
    let withPet = 0
    for (let i = 0; i < 60; i++) {
      const f = familiarFor(`did:key:z6MkTest${i}`)
      if (f) {
        withPet++
        kinds.add(f.kind)
      }
    }
    expect(withPet).toBeGreaterThan(5)
    expect(withPet).toBeLessThan(45) // a companion is a treat, not a default
    expect(kinds.size).toBeGreaterThan(1)
  })
})
