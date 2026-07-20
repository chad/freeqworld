// The world derived from a real server's channel list (spec §7.5).
// Nothing here is invented: every room is a real channel, the plaza is the
// busiest topical channel, doors rank by real population, and everything
// else is reachable through the directory (portal-directory strategy).

import type { RoomManifest, RoomTemplate } from './protocol'

export interface ChannelEntry {
  name: string
  topic: string
  count: number
}

export interface DirectoryEntry {
  channel: string
  topic: string
  users: number
}

export interface LiveWorld {
  rooms: RoomManifest[]
  spawn: string
  directory: DirectoryEntry[]
}

const TEMPLATE_KEYWORDS: [RegExp, RoomTemplate][] = [
  [/dev|code|typescript|javascript|rust|python|nix|debian|linux|obsidian|build|phoenix|swift/i, 'workshop'],
  [/music|jazz|track|handpan|dj|audio/i, 'club'],
  [/bot|agent|swarm|claude|claw|eliza|pilot/i, 'laboratory'],
  [/archive|library|alexandria|book|doc/i, 'library'],
  [/game|gaming|arcade|play/i, 'theater'],
  [/random|lobby|hello|general|chat/i, 'plaza'],
  [/garden|nature|olive/i, 'garden'],
  [/crypto|sekret|secret|vault|private/i, 'office'],
]

function templateFor(name: string, topic: string): RoomTemplate {
  const hay = `${name} ${topic}`
  for (const [pattern, template] of TEMPLATE_KEYWORDS) {
    if (pattern.test(hay)) return template
  }
  // deterministic spread for everything else
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) | 0
  const rest: RoomTemplate[] = ['lounge', 'office', 'classroom', 'garden', 'train car']
  return rest[Math.abs(h) % rest.length]!
}

/** Liveliness rank: population first, then having a real topic, then brevity.
 *  Conventional gathering-place names get a bonus so the spawn lands there. */
function rank(c: ChannelEntry): number {
  const gathering = /^#(general|lobby|welcome|plaza|main)$/.test(c.name) ? 200 : 0
  return c.count * 100 + gathering + (c.topic ? 40 : 0) - Math.min(30, c.name.length)
}

const BPM_BY_TEMPLATE: Partial<Record<RoomTemplate, number>> = {
  plaza: 108,
  workshop: 92,
  club: 126,
  laboratory: 118,
  library: 72,
  theater: 116,
  garden: 84,
  office: 96,
}

export function worldFromChannels(entries: ChannelEntry[]): LiveWorld {
  const channels = entries.filter((e) => e.name.startsWith('#'))
  if (channels.length === 0) {
    channels.push({ name: '#lobby', topic: '', count: 0 })
  }
  const sorted = [...channels].sort((a, b) => rank(b) - rank(a) || a.name.localeCompare(b.name))
  const spawn = sorted[0]!.name
  const doorTargets = sorted.slice(1, 5).map((c) => c.name)

  const rooms: RoomManifest[] = sorted.map((c) => {
    const isPlaza = c.name === spawn
    const template = isPlaza ? 'plaza' : templateFor(c.name, c.topic)
    const width = Math.min(44, 18 + c.count * 4)
    const height = Math.min(26, 12 + c.count * 2)
    const exits: RoomManifest['exits'] = []
    if (isPlaza) {
      const dirs = ['north', 'east', 'south', 'west'] as const
      doorTargets.forEach((target, i) => {
        exits.push({ direction: dirs[i % 4]!, channel: target, label: target })
      })
    } else {
      exits.push({ direction: 'south', channel: spawn, label: `Back to ${spawn}` })
      // a second door to the next-ranked sibling makes the town walkable as a ring
      const idx = sorted.findIndex((s) => s.name === c.name)
      const next = sorted[(idx + 1) % sorted.length]!
      if (next.name !== c.name && next.name !== spawn) {
        exits.push({ direction: 'east', channel: next.name, label: next.name })
      }
    }
    const objects: RoomManifest['objects'] = []
    if (isPlaza) {
      objects.push({
        schema: 'freeq.at/world/object/v1',
        id: 'directory',
        type: 'directory kiosk',
        position: [Math.floor(width / 2) - 4, 4],
        sprite: 'directory kiosk',
        label: 'Channel directory',
        capabilities: ['inspect', 'read', 'join'],
        persistence: 'persistent',
      })
    }
    return {
      schema: 'freeq.at/world/room/v1',
      channel: c.name,
      name: c.name.replace(/^#/, ''),
      template,
      tileset: `live-${template}`,
      width,
      height,
      topic: c.topic || `Freeq channel ${c.name}`,
      encrypted: false, // only claimed with evidence (encrypted payloads seen)
      exits,
      zones: [],
      objects,
      music: { mode: 'adaptive', base_cue: `${template}_live`, bpm: BPM_BY_TEMPLATE[template] ?? 100, topic_adaptation: true },
    }
  })

  return {
    rooms,
    spawn,
    directory: sorted.map((c) => ({ channel: c.name, topic: c.topic, users: c.count })),
  }
}
