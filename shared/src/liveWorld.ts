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
  /** true when this came from the user's own recent conversations (CHATHISTORY TARGETS), not the public LIST */
  personal?: boolean
  /** true for the server's home channel when LIST hides it (secret mode) */
  unlisted?: boolean
}

export interface LiveWorld {
  rooms: RoomManifest[]
  spawn: string
  directory: DirectoryEntry[]
  /** how many development/test channels were filtered out of the town */
  hidden: number
}

export interface WorldOptions {
  /** the server's own name (e.g. 'freeq' for irc.freeq.at) — its channel gets the spawn bonus */
  home?: string
  /** the user's recent channels (real, personal) to merge in even when LIST hides them */
  extraChannels?: string[]
}

/** Development/test debris — real channels, but not part of the town.
 *  Patterns derived from what actually litters irc.freeq.at. */
export function isDebris(name: string): boolean {
  const n = name.toLowerCase()
  if (/(test|e2e|debug|probe|repro|verify|demo(?![a-z]))/.test(n)) return true
  if (/^#(pw|rev|rb|fqpilot|freeqpilot|webui|chadmac|scrprobe|oblivion|boxd)([-.]|$)/.test(n)) return true
  if (/\d{3,}/.test(n)) return true // timestamps / run numbers
  const tail = n.split('-').pop() ?? ''
  if (n.includes('-') && tail.length >= 4 && /\d/.test(tail) && /[a-z]/.test(tail)) return true // random suffixes
  return false
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
 *  Conventional gathering-place names — and the server's own home channel —
 *  get a bonus so the spawn lands where the people are. */
function rank(c: ChannelEntry, home?: string): number {
  const gathering = /^#(general|lobby|welcome|plaza|main)$/.test(c.name) ? 200 : 0
  // the server's own channel is where its conversation lives — spawn there
  // when the user can see it, unless some other channel is far busier
  const homeBonus = home && c.name === `#${home}` ? 1200 : 0
  return c.count * 100 + gathering + homeBonus + (c.topic ? 40 : 0) - Math.min(30, c.name.length)
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

export function worldFromChannels(entries: ChannelEntry[], opts: WorldOptions = {}): LiveWorld {
  const wellFormed = entries.filter((e) => e.name.startsWith('#'))
  const channels = wellFormed.filter((e) => !isDebris(e.name))
  const hidden = wellFormed.length - channels.length
  const personal = new Set<string>()
  const unlisted = new Set<string>()
  for (const name of opts.extraChannels ?? []) {
    if (!name.startsWith('#') || isDebris(name)) continue
    if (!channels.some((c) => c.name === name)) {
      channels.push({ name, topic: '', count: 1 })
      personal.add(name)
    }
  }
  // the server's home channel belongs in the world even when LIST hides it
  if (opts.home) {
    const homeCh = `#${opts.home}`
    if (!channels.some((c) => c.name === homeCh)) {
      channels.push({ name: homeCh, topic: '', count: 0 })
      unlisted.add(homeCh)
    }
  }
  if (channels.length === 0) {
    channels.push({ name: '#lobby', topic: '', count: 0 })
  }
  const sorted = [...channels].sort((a, b) => rank(b, opts.home) - rank(a, opts.home) || a.name.localeCompare(b.name))
  const spawn = sorted[0]!.name

  // districts: same-template channels form east/west rings
  const templateOf = new Map<string, RoomTemplate>()
  for (const c of sorted) {
    templateOf.set(c.name, c.name === spawn ? 'plaza' : templateFor(c.name, c.topic))
  }
  const districts = new Map<RoomTemplate, string[]>()
  for (const c of sorted) {
    if (c.name === spawn) continue
    const t = templateOf.get(c.name)!
    const list = districts.get(t) ?? []
    list.push(c.name)
    districts.set(t, list)
  }

  const countOf = new Map(sorted.map((c) => [c.name, c.count]))
  const doorLabel = (name: string) => {
    const n = countOf.get(name) ?? 0
    return unlisted.has(name) ? name : `${name} (${n})`
  }

  const rooms: RoomManifest[] = sorted.map((c) => {
    const isPlaza = c.name === spawn
    const template = templateOf.get(c.name)!
    // secret home channels report no count — don't shrink the main hall for it
    const sizeCount = unlisted.has(c.name) ? 6 : isPlaza ? Math.max(c.count, 6) : c.count
    const width = Math.min(44, 18 + sizeCount * 4)
    const height = Math.min(26, 12 + sizeCount * 2)
    const exits: RoomManifest['exits'] = []
    if (isPlaza) {
      // the portal station: ranked arches along the north wall (spec §7.5) —
      // only as many as the wall can carry without labels colliding
      const arches = Math.max(2, Math.min(6, Math.floor((width - 6) / 7)))
      for (const target of sorted.slice(1, 1 + arches).map((s) => s.name)) {
        exits.push({ direction: 'north', channel: target, label: doorLabel(target) })
      }
    } else {
      exits.push({ direction: 'south', channel: spawn, label: `Back to ${spawn}` })
      const district = districts.get(template)!
      if (district.length > 1) {
        const idx = district.indexOf(c.name)
        const next = district[(idx + 1) % district.length]!
        const prev = district[(idx - 1 + district.length) % district.length]!
        if (next !== c.name) exits.push({ direction: 'east', channel: next, label: doorLabel(next) })
        if (prev !== c.name && prev !== next) exits.push({ direction: 'west', channel: prev, label: doorLabel(prev) })
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
    directory: sorted.map((c) => ({
      channel: c.name,
      topic: c.topic,
      users: c.count,
      personal: personal.has(c.name) || undefined,
      unlisted: unlisted.has(c.name) || undefined,
    })),
    hidden,
  }
}
