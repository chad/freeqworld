// Wire protocol and schema types (spec §7, §10.2, §23).

export interface TownProfile {
  schema: 'freeq.at/world/server-profile/v1'
  server: string
  name: string
  theme: string
  spawn_room: string
  palette: string
  music_pack: string
  peers: { server: string; url: string }[]
  /** live ranked channel directory — the portal-directory strategy (spec §7.5) */
  directory?: { channel: string; topic: string; users: number }[]
}

export type RoomTemplate =
  | 'plaza' | 'workshop' | 'club' | 'library' | 'laboratory' | 'office' | 'classroom'
  | 'lounge' | 'vault' | 'theater' | 'garden' | 'train car' | 'dungeon chamber' | 'empty tile grid'

export interface RoomExit {
  direction: 'north' | 'south' | 'east' | 'west'
  channel: string
  label: string
  /** present when the exit crosses to another town (federation travel, spec §14.2) */
  remote_server?: string
  remote_url?: string
}

export interface RoomZone {
  id: string
  label: string
  kind: 'thread-anchor'
  bounds: [number, number, number, number]
}

export interface WorldObject {
  schema: 'freeq.at/world/object/v1'
  id: string
  type: string
  position: [number, number]
  sprite: string
  label: string
  capabilities: string[]
  binding?: { provider: string; agent_did?: string }
  persistence: 'persistent' | 'ephemeral'
}

export interface RoomManifest {
  schema: 'freeq.at/world/room/v1'
  channel: string
  name: string
  template: RoomTemplate
  tileset: string
  width: number
  height: number
  topic: string
  encrypted: boolean
  exits: RoomExit[]
  zones: RoomZone[]
  objects: WorldObject[]
  music: { mode: 'adaptive'; base_cue: string; bpm: number; topic_adaptation: boolean }
}

export type EditState = 'none' | 'author-edited' | 'author-deleted' | 'moderator-removed' | 'locally-hidden' | 'invalid-signature'

export interface ChatMessage {
  id: string
  channel: string
  sender: string
  sender_name: string
  content: string
  /** ciphertext envelope for encrypted channels — server never sees plaintext */
  enc?: { alg: 'aes-gcm'; iv: string; ct: string }
  type: 'text' | 'code' | 'link' | 'file' | 'structured' | 'system'
  ts: number
  edit_state: EditState
  origin_server: string
  provenance?: { spawned_by: string; agent_chain: string[] }
  signature: string
}

export interface Reaction {
  id: string
  channel: string
  actor: string
  target_message: string
  reaction: string
  ts: number
  origin_server: string
  signature: string
}

export interface StructuredAction {
  type: 'freeq.at/act/world/v1'
  id: string
  action: string
  actor: string
  channel: string
  target?: string
  arguments: Record<string, unknown>
  ts: number
  origin_server: string
  provenance?: { spawned_by: string; agent_chain: string[] }
  signature: string
}

export type DurableEvent =
  | { kind: 'message'; event: ChatMessage }
  | { kind: 'reaction'; event: Reaction }
  | { kind: 'action'; event: StructuredAction }

export interface WorldPosition {
  type: 'freeq.at/presence/world-position/v1'
  channel: string
  did: string
  x: number
  y: number
  facing: 'north' | 'south' | 'east' | 'west'
  animation: 'idle' | 'walk' | 'react'
  client_instance: string
  sequence: number
  expires_at: number
}

export interface MemberInfo {
  did: string
  handle: string
  display_name: string
  verification_status: 'verified' | 'unverified'
  is_agent: boolean
  /** when a linked identity (e.g. a Bluesky did:plc) anchors the avatar (spec §8.2) */
  avatar_did?: string
  appearance_form?: string
  agent_chain?: string[]
  capabilities?: string[]
  autonomy_mode?: 'autonomous' | 'suggested' | 'human-approved'
}

// ---- client -> server ----
export type ClientFrame =
  | { t: 'hello'; did: string; handle: string; display_name: string; channel: string; client_instance: string; avatar_did?: string; spectator?: boolean }
  | { t: 'join'; channel: string }
  | { t: 'msg'; event: Omit<ChatMessage, 'origin_server' | 'edit_state' | 'sender_name'> & { sender_name?: string } }
  | { t: 'react'; event: Omit<Reaction, 'origin_server'> }
  | { t: 'act'; event: Omit<StructuredAction, 'origin_server'> }
  | { t: 'pos'; pos: WorldPosition }

// ---- server -> client ----
export type ServerFrame =
  | { t: 'welcome'; town: TownProfile; rooms: RoomManifest[]; history: DurableEvent[]; members: MemberInfo[]; channel: string }
  | { t: 'joined'; channel: string; history: DurableEvent[]; members: MemberInfo[] }
  | { t: 'event'; channel: string; durable: DurableEvent }
  | { t: 'presence'; channel: string; positions: WorldPosition[] }
  | { t: 'member'; channel: string; member: MemberInfo; online: boolean }
  | { t: 'music'; channel: string; state: import('./music').MusicState }
  | { t: 'error'; message: string }
