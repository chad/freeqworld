import { describe, expect, it } from 'vitest'
import { worldFromChannels } from './liveWorld'

const REAL_SAMPLE = [
  { name: '#general', topic: 'General discussion — anything goes', count: 5 },
  { name: '#dev', topic: 'freeq development — server, clients, protocol, SDK', count: 5 },
  { name: '#music', topic: '', count: 5 },
  { name: '#crypto', topic: '', count: 5 },
  { name: '#lobby', topic: 'Nothing happens here', count: 3 },
  { name: '#atproto', topic: 'All things atproto and beyond', count: 2 },
  { name: '#gaming', topic: '', count: 2 },
  { name: '#bots', topic: '', count: 4 },
  { name: '#random', topic: '', count: 1 },
  { name: '#e2e-claude-53w889', topic: '', count: 0 },
  { name: '#pw-mndv3khq-47', topic: 'behavioral test topic', count: 0 },
  { name: 'yokota', topic: '', count: 2 }, // malformed, no '#'
  { name: '#alexandria', topic: 'https://getalexandria.ai', count: 3 },
]

describe('worldFromChannels (spec 7.5: dynamic world from real channels)', () => {
  it('creates a room for every well-formed channel — nothing invented, nothing dropped', () => {
    const world = worldFromChannels(REAL_SAMPLE)
    const channels = world.rooms.map((r) => r.channel)
    expect(channels).toContain('#general')
    expect(channels).toContain('#e2e-claude-53w889') // debris is still real
    expect(channels).not.toContain('yokota') // malformed entries are not channels
    expect(new Set(channels).size).toBe(channels.length)
    for (const room of world.rooms) {
      expect(room.schema).toBe('freeq.at/world/room/v1')
      expect(room.topic).toBe(REAL_SAMPLE.find((c) => c.name === room.channel)!.topic || `Freeq channel ${room.channel}`)
    }
  })

  it('picks the busiest topical channel as the plaza/spawn', () => {
    const world = worldFromChannels(REAL_SAMPLE)
    expect(world.spawn).toBe('#general')
    const plaza = world.rooms.find((r) => r.channel === world.spawn)!
    expect(plaza.template).toBe('plaza')
  })

  it("gives the plaza doors to the liveliest real channels, not to fictional ones", () => {
    const world = worldFromChannels(REAL_SAMPLE)
    const plaza = world.rooms.find((r) => r.channel === world.spawn)!
    expect(plaza.exits.length).toBeGreaterThanOrEqual(3)
    for (const exit of plaza.exits) {
      expect(world.rooms.some((r) => r.channel === exit.channel)).toBe(true)
    }
    const doorChannels = plaza.exits.map((e) => e.channel)
    expect(doorChannels).toContain('#dev') // 5 users + topic beats debris
    expect(doorChannels).not.toContain('#e2e-claude-53w889')
  })

  it('every non-plaza room has a door back toward the plaza', () => {
    const world = worldFromChannels(REAL_SAMPLE)
    for (const room of world.rooms) {
      if (room.channel === world.spawn) continue
      expect(room.exits.some((e) => e.channel === world.spawn), `${room.channel} lacks a way home`).toBe(true)
    }
  })

  it('derives templates from real channel character', () => {
    const world = worldFromChannels(REAL_SAMPLE)
    const byChannel = new Map(world.rooms.map((r) => [r.channel, r]))
    expect(byChannel.get('#dev')!.template).toBe('workshop')
    expect(byChannel.get('#music')!.template).toBe('club')
    expect(byChannel.get('#bots')!.template).toBe('laboratory')
  })

  it('sizes rooms by real population', () => {
    const world = worldFromChannels(REAL_SAMPLE)
    const busy = world.rooms.find((r) => r.channel === '#general')!
    const empty = world.rooms.find((r) => r.channel === '#e2e-claude-53w889')!
    expect(busy.width).toBeGreaterThan(empty.width)
  })

  it('is deterministic', () => {
    expect(worldFromChannels(REAL_SAMPLE)).toEqual(worldFromChannels(REAL_SAMPLE))
  })

  it('marks no room encrypted from LIST data alone (that requires evidence)', () => {
    const world = worldFromChannels(REAL_SAMPLE)
    expect(world.rooms.every((r) => !r.encrypted)).toBe(true)
  })

  it('exposes a ranked directory of all real channels', () => {
    const world = worldFromChannels(REAL_SAMPLE)
    expect(world.directory.length).toBe(world.rooms.length)
    expect(world.directory[0]!.channel).toBe('#general')
    const dev = world.directory.find((d) => d.channel === '#dev')!
    expect(dev.users).toBe(5)
    expect(dev.topic).toContain('freeq development')
  })

  it('handles an empty list without exploding', () => {
    const world = worldFromChannels([])
    expect(world.rooms.length).toBe(1) // a lone plaza so there is somewhere to stand
    expect(world.spawn).toBe('#lobby')
  })
})
