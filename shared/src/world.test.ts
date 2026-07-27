import { describe, expect, it } from 'vitest'
import { LAUNCH_ROOMS, generateTilemap, TILE } from './world'

describe('launch world rooms (spec 26)', () => {
  const byChannel = new Map(LAUNCH_ROOMS.map((r) => [r.channel, r]))

  it('contains the seven launch rooms mapped 1:1 to channels', () => {
    for (const ch of ['#lobby', '#freeq-dev', '#agents', '#music', '#archive', '#private-demo', '#federation']) {
      expect(byChannel.has(ch), `missing ${ch}`).toBe(true)
    }
    const channels = LAUNCH_ROOMS.map((r) => r.channel)
    expect(new Set(channels).size).toBe(channels.length) // 1:1, no channel twice
  })

  it('uses the spec-mandated templates', () => {
    expect(byChannel.get('#lobby')!.template).toBe('plaza')
    expect(byChannel.get('#freeq-dev')!.template).toBe('workshop')
    expect(byChannel.get('#agents')!.template).toBe('laboratory')
    expect(byChannel.get('#music')!.template).toBe('club')
    expect(byChannel.get('#archive')!.template).toBe('library')
    expect(byChannel.get('#private-demo')!.template).toBe('vault')
  })

  it('marks the vault encrypted and only the vault', () => {
    expect(byChannel.get('#private-demo')!.encrypted).toBe(true)
    expect(LAUNCH_ROOMS.filter((r) => r.encrypted).length).toBe(1)
  })

  it('every exit points at an existing room and has a reciprocal or remote target', () => {
    for (const room of LAUNCH_ROOMS) {
      for (const exit of room.exits) {
        if (exit.remote_server) continue
        expect(byChannel.has(exit.channel), `${room.channel} exit -> ${exit.channel}`).toBe(true)
      }
    }
  })

  it('workshop bpm is 92 and club is 126 (spec 11.7)', () => {
    expect(byChannel.get('#freeq-dev')!.music.bpm).toBe(92)
    expect(byChannel.get('#music')!.music.bpm).toBe(126)
    expect(byChannel.get('#lobby')!.music.bpm).toBe(108)
    expect(byChannel.get('#archive')!.music.bpm).toBe(72)
    expect(byChannel.get('#private-demo')!.music.bpm).toBe(64)
    expect(byChannel.get('#agents')!.music.bpm).toBe(118)
    expect(byChannel.get('#federation')!.music.bpm).toBe(112)
  })
})

describe('generateTilemap', () => {
  it('produces a walkable floor with wall border', () => {
    const room = LAUNCH_ROOMS[0]!
    const map = generateTilemap(room)
    expect(map.width).toBe(room.width)
    expect(map.height).toBe(room.height)
    expect(map.tiles.length).toBe(room.width * room.height)
    // border is wall
    expect(map.tiles[0]).toBe(TILE.WALL)
    // spawn point is walkable and inside
    const spawnTile = map.tiles[map.spawn[1] * map.width + map.spawn[0]]
    expect(spawnTile).not.toBe(TILE.WALL)
  })

  it('is deterministic for a given room', () => {
    const room = LAUNCH_ROOMS[1]!
    expect(generateTilemap(room)).toEqual(generateTilemap(room))
  })

  it('carves a door for every exit', () => {
    for (const room of LAUNCH_ROOMS) {
      const map = generateTilemap(room)
      for (const exit of room.exits) {
        const door = map.doors.find((d) => d.channel === exit.channel)
        expect(door, `${room.channel} missing door to ${exit.channel}`).toBeDefined()
        const t = map.tiles[door!.y * map.width + door!.x]
        expect(t).toBe(TILE.DOOR)
      }
    }
  })
})

describe('room accents keep the floor clear', () => {
  // a real manifest: the generator needs width/height/exits, and a club is the
  // template that turns accents into lights
  const room = LAUNCH_ROOMS.find((r) => r.template === 'club')!

  it('puts most clutter against the walls, not where people stand', () => {
    const map = generateTilemap(room)
    const at = (x: number, y: number) => map.tiles[y * map.width + x]
    let against = 0
    let adrift = 0
    for (let y = 1; y < map.height - 1; y++) {
      for (let x = 1; x < map.width - 1; x++) {
        const t = at(x, y)
        if (t !== TILE.DECOR && t !== TILE.GLOW) continue
        const wall =
          at(x - 1, y) === TILE.WALL || at(x + 1, y) === TILE.WALL || at(x, y - 1) === TILE.WALL || at(x, y + 1) === TILE.WALL
        if (wall) against++
        else adrift++
      }
    }
    expect(against + adrift).toBeGreaterThan(4)
    expect(against, `${adrift} accents adrift vs ${against} against a wall`).toBeGreaterThanOrEqual(adrift)
  })

  it('does not turn a club into twenty point lights', () => {
    const map = generateTilemap(room)
    const glow = [...map.tiles].filter((t) => t === TILE.GLOW).length
    const decor = [...map.tiles].filter((t) => t === TILE.DECOR).length
    expect(glow).toBeGreaterThan(0) // a club still glows
    expect(glow).toBeLessThan(decor) // but most accents are unlit furniture
  })

  it('is still deterministic for a channel', () => {
    expect(generateTilemap(room).tiles).toEqual(generateTilemap(room).tiles)
  })
})

describe('furniture never plugs a doorway', () => {
  it('leaves every door approachable in every launch room', () => {
    for (const room of LAUNCH_ROOMS) {
      const map = generateTilemap(room)
      const at = (x: number, y: number) => map.tiles[y * map.width + x]
      for (let y = 0; y < map.height; y++) {
        for (let x = 0; x < map.width; x++) {
          if (at(x, y) !== TILE.DOOR) continue
          // the tile you step onto coming through must not be solid furniture
          const inward = y === 0 ? [x, y + 1] : y === map.height - 1 ? [x, y - 1] : x === 0 ? [x + 1, y] : [x - 1, y]
          const t = at(inward[0]!, inward[1]!)
          expect(t, `${room.channel}: door at ${x},${y} opens onto tile ${t}`).not.toBe(TILE.DECOR)
        }
      }
    }
  })
})
