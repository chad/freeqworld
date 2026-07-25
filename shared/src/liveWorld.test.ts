import { describe, expect, it } from 'vitest'
import { isDebris, worldFromChannels } from './liveWorld'

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

describe('isDebris: development/test channels are not part of the town', () => {
  it('flags the real debris patterns from irc.freeq.at', () => {
    for (const name of [
      '#e2e-claude-53w889', '#pw-mndv3khq-47', '#avtest-20260523171225', '#naptest1115',
      '#chadmac-sweeptest', '#fimp-e2e-420489', '#rev-persist-d4y6', '#fqpilot-5eaf',
      '#test', '#test104', '#test1234', '#claude-test', '#didtest', '#chadtest',
      '#oblivion-debug', '#scrprobe-0703', '#repro', '#del3verify', '#p0verify',
      '#pilotdemo', '#chadsweep-demo', '#delegation-demo', '#naptest-e2ee', '#freeqpilot.',
      '#zapnap-swarm-test', '#alexandria-test', '#ada-debug', '#revtest-qi7r',
    ]) {
      expect(isDebris(name), `${name} should be debris`).toBe(true)
    }
  })

  it('keeps real channels', () => {
    for (const name of [
      '#general', '#dev', '#lobby', '#music', '#crypto', '#atproto', '#gaming',
      '#bots', '#random', '#alexandria', '#freeq', '#hypercerts', '#all-the-claws',
      '#dmrg', '#nixos', '#obsidian', '#mechanical-keyboards', '#hello', '#crew',
      '#comicchat', '#null-island', '#f1', '#dxos', '#chad-dev',
    ]) {
      expect(isDebris(name), `${name} should be real`).toBe(false)
    }
  })
})

describe('worldFromChannels (spec 7.5: dynamic world from real channels)', () => {
  it('creates a room for every real channel and drops development debris', () => {
    const world = worldFromChannels(REAL_SAMPLE)
    const channels = world.rooms.map((r) => r.channel)
    expect(channels).toContain('#general')
    expect(channels).not.toContain('#e2e-claude-53w889') // debris hidden from the town
    expect(channels).not.toContain('yokota') // malformed entries are not channels
    expect(world.hidden).toBe(2) // the two debris channels in the sample
    expect(new Set(channels).size).toBe(channels.length)
    for (const room of world.rooms) {
      expect(room.schema).toBe('freeq.at/world/room/v1')
      expect(room.topic).toBe(REAL_SAMPLE.find((c) => c.name === room.channel)!.topic || `Freeq channel ${room.channel}`)
    }
  })

  it('gives the server home channel the spawn when it is present', () => {
    const world = worldFromChannels(
      [...REAL_SAMPLE, { name: '#freeq', topic: 'the freeq channel', count: 2 }],
      { home: 'freeq' },
    )
    expect(world.spawn).toBe('#freeq')
  })

  it('inserts the home channel even when LIST hides it (secret channels)', () => {
    const world = worldFromChannels(REAL_SAMPLE, { home: 'freeq' })
    const entry = world.directory.find((d) => d.channel === '#freeq')!
    expect(entry.unlisted).toBe(true)
    const room = world.rooms.find((r) => r.channel === '#freeq')!
    expect(room.width).toBeGreaterThan(20) // the home room is not a closet just because LIST hides its count
    // ...but a hidden, empty room is not somewhere to *arrive*: the spawn goes
    // to the liveliest public channel instead (see the regression test below)
    expect(world.spawn).toBe('#general')
  })

  it('turns the spawn room into a portal station: ranked arches on the north wall with live counts', () => {
    const world = worldFromChannels(REAL_SAMPLE, { home: 'freeq' })
    const plaza = world.rooms.find((r) => r.channel === world.spawn)!
    const north = plaza.exits.filter((e) => e.direction === 'north')
    expect(north.length).toBeGreaterThanOrEqual(4)
    expect(north.length).toBeLessThanOrEqual(8)
    // ranked: the first arch is the liveliest real channel other than the
    // spawn itself (the spawn is #general, so #dev leads the arches)
    expect(world.spawn).toBe('#general')
    expect(north[0]!.channel).toBe('#dev')
    expect(north[0]!.label).toContain('#dev')
    expect(north[0]!.label).toContain('5') // live population in the label
  })

  it('links rooms into districts: same-template channels connect east/west', () => {
    const world = worldFromChannels(
      [
        { name: '#general', topic: 'talk', count: 5 },
        { name: '#dev', topic: 'freeq development', count: 5 },
        { name: '#typescript', topic: '', count: 2 },
        { name: '#nixos', topic: 'nix fixes this', count: 1 },
        { name: '#music', topic: '', count: 3 },
      ],
      { home: 'freeq' },
    )
    const dev = world.rooms.find((r) => r.channel === '#dev')!
    expect(dev.template).toBe('workshop')
    const sideDoors = dev.exits.filter((e) => e.direction === 'east' || e.direction === 'west')
    expect(sideDoors.length).toBeGreaterThanOrEqual(1) // #typescript/#nixos are its district
    for (const door of sideDoors) {
      const target = world.rooms.find((r) => r.channel === door.channel)!
      expect(target.template).toBe('workshop') // district neighbors share a character
    }
    // and every room still has a door home
    for (const room of world.rooms) {
      if (room.channel === world.spawn) continue
      expect(room.exits.some((e) => e.channel === world.spawn)).toBe(true)
    }
  })

  it('merges the user’s personal recent channels even when LIST hides them', () => {
    const world = worldFromChannels(REAL_SAMPLE, { extraChannels: ['#freeq', '#sekret-hq'] })
    const channels = world.rooms.map((r) => r.channel)
    expect(channels).toContain('#freeq')
    expect(channels).toContain('#sekret-hq')
    const entry = world.directory.find((d) => d.channel === '#freeq')!
    expect(entry.personal).toBe(true)
  })

  it('does not resurrect debris via personal targets', () => {
    const world = worldFromChannels(REAL_SAMPLE, { extraChannels: ['#e2e-claude-53w889'] })
    expect(world.rooms.some((r) => r.channel === '#e2e-claude-53w889')).toBe(false)
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
    const quiet = world.rooms.find((r) => r.channel === '#random')!
    expect(busy.width).toBeGreaterThan(quiet.width)
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

  // Regression: on irc.freeq.at the home channel #freeq is private (absent from
  // LIST, nobody in it). A flat home bonus handed it the spawn, so every single
  // visitor was dropped alone into a policy-gated room. You must never spawn
  // somewhere empty.
  it('never spawns into the home channel when it is hidden and empty', () => {
    const world = worldFromChannels(
      [
        { name: '#general', topic: 'General discussion', count: 8 },
        { name: '#lobby', topic: 'Nothing happens here', count: 7 },
      ],
      { home: 'freeq' },
    )
    expect(world.spawn).toBe('#general')
    // it still belongs in the world (there's a door to it), just not the spawn
    expect(world.directory.some((d) => d.channel === '#freeq')).toBe(true)
  })

  it('still spawns in the home channel when it is public and lively', () => {
    const world = worldFromChannels(
      [
        { name: '#freeq', topic: 'the home channel', count: 9 },
        { name: '#general', topic: 'General discussion', count: 8 },
      ],
      { home: 'freeq' },
    )
    expect(world.spawn).toBe('#freeq')
  })

  it("never spawns into a user's personal channel just because LIST hides it", () => {
    const world = worldFromChannels([{ name: '#general', topic: 'General discussion', count: 8 }], {
      extraChannels: ['#my-private-notes'],
    })
    expect(world.spawn).toBe('#general')
  })
})
