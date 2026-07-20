// Launch world definition (spec §26) and deterministic tilemap generation.

import type { RoomManifest, WorldObject } from './protocol'
import { seededPrng } from './hkdf'

export const TILE = {
  FLOOR: 0,
  WALL: 1,
  DOOR: 2,
  DECOR: 3, // solid furniture
  RUG: 4, // walkable accent
  GLOW: 5, // walkable emissive accent (vault runes, club lights)
} as const

export interface Tilemap {
  width: number
  height: number
  tiles: Uint8Array
  spawn: [number, number]
  doors: { channel: string; x: number; y: number; direction: string; label: string; remote_server?: string; remote_url?: string }[]
}

function obj(id: string, type: string, x: number, y: number, label: string, capabilities: string[], agentDid?: string): WorldObject {
  return {
    schema: 'freeq.at/world/object/v1',
    id,
    type,
    position: [x, y],
    sprite: type,
    label,
    capabilities,
    binding: agentDid ? { provider: 'agent', agent_did: agentDid } : undefined,
    persistence: 'persistent',
  }
}

export const LAUNCH_ROOMS: RoomManifest[] = [
  {
    schema: 'freeq.at/world/room/v1',
    channel: '#lobby',
    name: 'The Plaza',
    template: 'plaza',
    tileset: 'freeq-city-01',
    width: 40,
    height: 24,
    topic: 'Welcome to FreeqWorld — a real Freeq client that looks like 1992',
    encrypted: false,
    exits: [
      { direction: 'east', channel: '#freeq-dev', label: 'The Workshop' },
      { direction: 'west', channel: '#music', label: 'The Club' },
      { direction: 'north', channel: '#federation', label: 'Federation Station' },
      { direction: 'south', channel: '#archive', label: 'The Library' },
    ],
    zones: [
      { id: 'fountain-circle', label: 'Fountain circle', kind: 'thread-anchor', bounds: [17, 9, 6, 5] },
      { id: 'notice-corner', label: 'Notice corner', kind: 'thread-anchor', bounds: [30, 4, 6, 4] },
    ],
    objects: [
      obj('kiosk', 'directory kiosk', 8, 5, 'Directory kiosk', ['inspect', 'read']),
      obj('how-terminal', 'terminal', 27, 6, 'How this works', ['inspect', 'read']),
      obj('news-board', 'bulletin board', 33, 5, 'News board', ['read', 'pin']),
      obj('help-desk', 'agent console', 12, 16, 'Agent help desk', ['ask']),
      obj('fountain', 'fountain', 19, 11, 'Plaza fountain', ['inspect']),
    ],
    music: { mode: 'adaptive', base_cue: 'plaza_108bpm', bpm: 108, topic_adaptation: true },
  },
  {
    schema: 'freeq.at/world/room/v1',
    channel: '#freeq-dev',
    name: 'The Workshop',
    template: 'workshop',
    tileset: 'freeq-industrial-01',
    width: 32,
    height: 20,
    topic: 'Protocol and implementation discussion',
    encrypted: false,
    exits: [
      { direction: 'west', channel: '#lobby', label: 'Return to the plaza' },
      { direction: 'east', channel: '#agents', label: 'Agent Laboratory' },
    ],
    zones: [{ id: 'rust-table', label: 'Rust table', kind: 'thread-anchor', bounds: [14, 9, 6, 4] }],
    objects: [
      obj('build-monitor', 'build-status monitor', 6, 4, 'Build status', ['inspect', 'subscribe']),
      obj('issue-board', 'issue board', 12, 4, 'Issue board', ['read', 'open']),
      obj('packet-viz', 'packet visualizer', 25, 5, 'Packet visualizer', ['inspect']),
      obj('workbench', 'workbench', 18, 13, 'Rust workbench', ['use']),
      obj('whiteboard', 'whiteboard', 25, 13, 'Whiteboard', ['read', 'edit']),
    ],
    music: { mode: 'adaptive', base_cue: 'workshop_92bpm', bpm: 92, topic_adaptation: true },
  },
  {
    schema: 'freeq.at/world/room/v1',
    channel: '#agents',
    name: 'The Agent Laboratory',
    template: 'laboratory',
    tileset: 'freeq-lab-01',
    width: 30,
    height: 20,
    topic: 'Agents, provenance, structured actions',
    encrypted: false,
    exits: [{ direction: 'west', channel: '#freeq-dev', label: 'The Workshop' }],
    zones: [{ id: 'incubator-bay', label: 'Incubator bay', kind: 'thread-anchor', bounds: [6, 6, 5, 4] }],
    objects: [
      obj('incubator', 'agent incubator', 7, 4, 'Agent incubator', ['inspect']),
      obj('cap-console', 'agent console', 14, 4, 'Capability console', ['inspect', 'ask']),
      obj('prov-tree', 'provenance tree', 22, 5, 'Provenance tree', ['inspect']),
      obj('prompt-term', 'terminal', 14, 13, 'Prompt terminal', ['ask', 'use']),
      obj('action-range', 'sandboxed action range', 22, 14, 'Sandboxed action range', ['use']),
    ],
    music: { mode: 'adaptive', base_cue: 'lab_118bpm', bpm: 118, topic_adaptation: true },
  },
  {
    schema: 'freeq.at/world/room/v1',
    channel: '#music',
    name: 'The Club',
    template: 'club',
    tileset: 'freeq-club-01',
    width: 30,
    height: 20,
    topic: 'Music, listening parties, the adaptive soundtrack',
    encrypted: false,
    exits: [{ direction: 'east', channel: '#lobby', label: 'Back to the plaza' }],
    zones: [{ id: 'listening-booth', label: 'Listening booth', kind: 'thread-anchor', bounds: [4, 13, 5, 4] }],
    objects: [
      obj('stage', 'stage', 14, 4, 'Stage', ['join', 'play']),
      obj('jukebox', 'music player', 5, 5, 'Jukebox', ['play', 'inspect']),
      obj('topic-jam', 'topic jam machine', 22, 5, 'Topic Jam machine', ['play', 'use']),
      obj('visualizer', 'visualizer', 22, 13, 'Visualizer', ['inspect']),
    ],
    music: { mode: 'adaptive', base_cue: 'club_126bpm', bpm: 126, topic_adaptation: true },
  },
  {
    schema: 'freeq.at/world/room/v1',
    channel: '#archive',
    name: 'The Library',
    template: 'library',
    tileset: 'freeq-lib-01',
    width: 32,
    height: 20,
    topic: 'Search, history, documentation',
    encrypted: false,
    exits: [
      { direction: 'north', channel: '#lobby', label: 'Back to the plaza' },
      { direction: 'south', channel: '#private-demo', label: 'The Vault' },
    ],
    zones: [{ id: 'reading-circle', label: 'Reading circle', kind: 'thread-anchor', bounds: [13, 8, 6, 4] }],
    objects: [
      obj('shelves', 'timeline shelves', 6, 4, 'Timeline shelves', ['read']),
      obj('search-term', 'terminal', 14, 4, 'Search terminal', ['use', 'ask']),
      obj('export-desk', 'export desk', 24, 4, 'Export desk', ['download']),
      obj('exhibit', 'signed-event exhibit', 24, 13, 'Signed-event exhibit', ['inspect']),
    ],
    music: { mode: 'adaptive', base_cue: 'library_72bpm', bpm: 72, topic_adaptation: true },
  },
  {
    schema: 'freeq.at/world/room/v1',
    channel: '#private-demo',
    name: 'The Vault',
    template: 'vault',
    tileset: 'freeq-vault-01',
    width: 24,
    height: 16,
    topic: 'Client-side encryption demo — the server only ever sees ciphertext',
    encrypted: true,
    exits: [{ direction: 'north', channel: '#archive', label: 'The Library' }],
    zones: [],
    objects: [
      obj('key-panel', 'key-status panel', 6, 4, 'Key status panel', ['inspect']),
      obj('rotation', 'rotation mechanism', 16, 4, 'Rotation mechanism', ['use', 'inspect']),
    ],
    music: { mode: 'adaptive', base_cue: 'vault_64bpm', bpm: 64, topic_adaptation: false },
  },
  {
    schema: 'freeq.at/world/room/v1',
    channel: '#federation',
    name: 'Federation Station',
    template: 'train car',
    tileset: 'freeq-station-01',
    width: 34,
    height: 18,
    topic: 'Travel between independently operated towns',
    encrypted: false,
    exits: [
      { direction: 'south', channel: '#lobby', label: 'Back to the plaza' },
      { direction: 'north', channel: '#federation', label: 'Portal to the peer town', remote_server: 'peer' },
    ],
    zones: [{ id: 'platform', label: 'Platform', kind: 'thread-anchor', bounds: [14, 7, 7, 4] }],
    objects: [
      obj('route-map', 'map', 6, 4, 'Route map', ['inspect']),
      obj('peer-board', 'peer-status board', 14, 4, 'Peer status board', ['inspect']),
      obj('merge-display', 'merge display', 24, 4, 'Merge display', ['inspect']),
      obj('courier-dock', 'courier dock', 24, 11, 'Packet courier dock', ['inspect']),
    ],
    music: { mode: 'adaptive', base_cue: 'station_112bpm', bpm: 112, topic_adaptation: true },
  },
]

function stringSeed(s: string): Uint8Array {
  // FNV-1a expanded to 16 bytes for the prng
  const out = new Uint8Array(16)
  let h = 0x811c9dc5
  for (let i = 0; i < 4; i++) {
    for (const ch of s + i) {
      h ^= ch.charCodeAt(0)
      h = Math.imul(h, 0x01000193)
    }
    out[i * 4] = h & 0xff
    out[i * 4 + 1] = (h >>> 8) & 0xff
    out[i * 4 + 2] = (h >>> 16) & 0xff
    out[i * 4 + 3] = (h >>> 24) & 0xff
  }
  return out
}

export function generateTilemap(room: RoomManifest): Tilemap {
  const { width: w, height: h } = room
  const tiles = new Uint8Array(w * h).fill(TILE.FLOOR)
  const set = (x: number, y: number, t: number) => { tiles[y * w + x] = t }
  const get = (x: number, y: number) => tiles[y * w + x]

  for (let x = 0; x < w; x++) { set(x, 0, TILE.WALL); set(x, h - 1, TILE.WALL) }
  for (let y = 0; y < h; y++) { set(0, y, TILE.WALL); set(w - 1, y, TILE.WALL) }

  const doors: Tilemap['doors'] = []
  for (const exit of room.exits) {
    let x = Math.floor(w / 2)
    let y = Math.floor(h / 2)
    if (exit.direction === 'north') { y = 0 } else if (exit.direction === 'south') { y = h - 1 } else if (exit.direction === 'west') { x = 0 } else { x = w - 1 }
    if (exit.direction === 'north' || exit.direction === 'south') {
      set(x - 1, y, TILE.DOOR); set(x, y, TILE.DOOR); set(x + 1, y, TILE.DOOR)
    } else {
      set(x, y - 1, TILE.DOOR); set(x, y, TILE.DOOR); set(x, y + 1, TILE.DOOR)
    }
    doors.push({ channel: exit.channel, x, y, direction: exit.direction, label: exit.label, remote_server: exit.remote_server, remote_url: exit.remote_url })
  }

  // furniture from object positions
  for (const o of room.objects) {
    const [x, y] = o.position
    if (x > 0 && x < w - 1 && y > 0 && y < h - 1) set(x, y, TILE.DECOR)
  }

  // rugs under thread-anchor zones
  for (const z of room.zones) {
    const [zx, zy, zw, zh] = z.bounds
    for (let y = zy; y < zy + zh; y++) {
      for (let x = zx; x < zx + zw; x++) {
        if (x > 0 && x < w - 1 && y > 0 && y < h - 1 && get(x, y) === TILE.FLOOR) set(x, y, TILE.RUG)
      }
    }
  }

  // sparse deterministic decor / glow accents by template
  const rng = seededPrng(stringSeed(room.channel + room.template))
  const decorCount = Math.floor((w * h) / 40)
  for (let i = 0; i < decorCount; i++) {
    const x = 2 + Math.floor(rng() * (w - 4))
    const y = 2 + Math.floor(rng() * (h - 4))
    if (get(x, y) === TILE.FLOOR) {
      set(x, y, room.template === 'vault' || room.template === 'club' ? TILE.GLOW : TILE.DECOR)
    }
  }

  // spawn: center-ish, guaranteed walkable
  let sx = Math.floor(w / 2)
  let sy = Math.floor(h * 0.65)
  outer: for (let r = 0; r < Math.max(w, h); r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = sx + dx
        const y = sy + dy
        if (x > 0 && x < w - 1 && y > 0 && y < h - 1) {
          const t = get(x, y)
          if (t === TILE.FLOOR || t === TILE.RUG) { sx = x; sy = y; break outer }
        }
      }
    }
  }

  return { width: w, height: h, tiles, spawn: [sx, sy], doors }
}

export function isWalkable(map: Tilemap, x: number, y: number): boolean {
  const tx = Math.floor(x)
  const ty = Math.floor(y)
  if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) return false
  const t = map.tiles[ty * map.width + tx]
  return t === TILE.FLOOR || t === TILE.RUG || t === TILE.GLOW || t === TILE.DOOR
}
