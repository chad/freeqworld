import { afterEach, describe, expect, it, vi } from 'vitest'
import { login, uploadBlob, setAvatar, postAboutIt, type Session } from './atproto'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const BLOB = { $type: 'blob' as const, ref: { $link: 'bafyblob' }, mimeType: 'image/png', size: 42 }
const SESSION: Session = { did: 'did:plc:test123', handle: 'alice.test', pds: 'https://pds.example', accessJwt: 'JWT' }

function mockFetch(handlers: (url: string, init?: RequestInit) => Response | undefined) {
  const calls: Array<{ url: string; init?: RequestInit; body?: any }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: any, init?: RequestInit) => {
      const url = input.toString()
      let body: any
      if (init?.body && typeof init.body === 'string') {
        try { body = JSON.parse(init.body) } catch { body = init.body }
      }
      calls.push({ url, init, body })
      const res = handlers(url, init)
      return res ?? new Response('{}', { status: 404 })
    }),
  )
  return calls
}

afterEach(() => vi.unstubAllGlobals())

describe('atproto app-password writer', () => {
  it('login: handle → DID → PDS → createSession', async () => {
    const calls = mockFetch((url) => {
      if (url.includes('resolveHandle')) return json({ did: 'did:plc:test123' })
      if (url.includes('plc.directory'))
        return json({ service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://pds.example' }] })
      if (url.endsWith('createSession')) return json({ did: 'did:plc:test123', handle: 'alice.test', accessJwt: 'JWT' })
      return undefined
    })
    const s = await login('alice.test', 'app-pass-1234')
    expect(s).toEqual(SESSION)
    // createSession must go to the resolved PDS and identify by DID
    const cs = calls.find((c) => c.url.endsWith('createSession'))!
    expect(cs.url).toBe('https://pds.example/xrpc/com.atproto.server.createSession')
    expect(cs.body).toEqual({ identifier: 'did:plc:test123', password: 'app-pass-1234' })
  })

  it('setAvatar preserves existing profile fields and only swaps avatar', async () => {
    const calls = mockFetch((url) => {
      if (url.includes('getRecord'))
        return json({ value: { $type: 'app.bsky.actor.profile', displayName: 'Alice', description: 'hi there', banner: { $type: 'blob' } } })
      if (url.endsWith('putRecord')) return json({ uri: 'at://x', cid: 'y' })
      return undefined
    })
    await setAvatar(SESSION, BLOB)
    const put = calls.find((c) => c.url.endsWith('putRecord'))!
    expect(put.body.collection).toBe('app.bsky.actor.profile')
    expect(put.body.rkey).toBe('self')
    expect(put.body.record.displayName).toBe('Alice')
    expect(put.body.record.description).toBe('hi there')
    expect(put.body.record.banner).toEqual({ $type: 'blob' })
    expect(put.body.record.avatar).toEqual(BLOB)
  })

  it('setAvatar works when the user has no profile record yet', async () => {
    const calls = mockFetch((url) => {
      if (url.includes('getRecord')) return json({ error: 'RecordNotFound' }, 400)
      if (url.endsWith('putRecord')) return json({ uri: 'at://x', cid: 'y' })
      return undefined
    })
    await setAvatar(SESSION, BLOB)
    const put = calls.find((c) => c.url.endsWith('putRecord'))!
    expect(put.body.record.$type).toBe('app.bsky.actor.profile')
    expect(put.body.record.avatar).toEqual(BLOB)
  })

  it('postAboutIt: link facet byte offsets land exactly on the URL (multibyte-safe)', async () => {
    const calls = mockFetch((url) => (url.endsWith('createRecord') ? json({ uri: 'at://x', cid: 'y' }) : undefined))
    await postAboutIt(SESSION, BLOB)
    const rec = calls.find((c) => c.url.endsWith('createRecord'))!.body.record
    expect(rec.$type).toBe('app.bsky.feed.post')
    expect(rec.embed.images[0].image).toEqual(BLOB)
    const facet = rec.facets[0]
    const bytes = new TextEncoder().encode(rec.text)
    const sliced = new TextDecoder().decode(bytes.slice(facet.index.byteStart, facet.index.byteEnd))
    expect(sliced).toBe('pfp.freeq.at')
    expect(facet.features[0].uri).toBe('https://pfp.freeq.at')
  })

  it('uploadBlob posts bytes with the right content-type and returns the blob', async () => {
    const calls = mockFetch((url) => (url.endsWith('uploadBlob') ? json({ blob: BLOB }) : undefined))
    const blob = await uploadBlob(SESSION, new Uint8Array([1, 2, 3]), 'image/png')
    expect(blob).toEqual(BLOB)
    const up = calls.find((c) => c.url.endsWith('uploadBlob'))!
    expect((up.init!.headers as any)['content-type']).toBe('image/png')
    expect((up.init!.headers as any).authorization).toBe('Bearer JWT')
  })
})
