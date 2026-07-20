// Launch agents (spec §10.4). Each agent is a first-class Freeq identity:
// its own did:key, deterministic per town, with agent_chain provenance
// rooted at the town operator's DID.

import { hkdfSync } from 'node:crypto'
import { didFromPublicKey, keypairFromSeed, type Keypair } from '../../shared/src/signing'

export function agentSeed(input: string): Uint8Array {
  return new Uint8Array(hkdfSync('sha256', Buffer.from(input, 'utf8'), Buffer.from('freeq-world-agent', 'utf8'), Buffer.from('agent-v1', 'utf8'), 32))
}
import type { MemberInfo } from '../../shared/src/protocol'

export interface AgentBrainContext {
  channel: string
  content: string
  senderName: string
  searchHistory: (term: string) => { sender_name: string; content: string; ts: number }[]
  roomNames: () => { channel: string; name: string; topic: string }[]
  peerNames: () => string[]
  townName: string
}

export interface AgentDef {
  member: MemberInfo
  keypair: Keypair
  channels: string[]
  /** returns a reply, or null to stay quiet */
  brain: (ctx: AgentBrainContext) => string | null
  /** true when the agent should also react to unaddressed room events */
  ambient?: (ctx: AgentBrainContext) => string | null
}

function mentioned(content: string, ...names: string[]): boolean {
  const lower = content.toLowerCase()
  return names.some((n) => lower.includes(`@${n}`) || lower.includes(n))
}

export function createAgents(townServer: string, operatorDid: string): AgentDef[] {
  function mk(
    name: string,
    handle: string,
    appearance: string,
    channels: string[],
    capabilities: string[],
    brain: AgentDef['brain'],
    ambient?: AgentDef['ambient'],
  ): AgentDef {
    const seed = agentSeed(`${townServer}/${handle}`)
    const keypair = keypairFromSeed(seed)
    const did = didFromPublicKey(keypair.publicKey)
    return {
      member: {
        did,
        handle,
        display_name: name,
        verification_status: 'verified',
        is_agent: true,
        appearance_form: appearance,
        agent_chain: [operatorDid, did],
        capabilities,
        autonomy_mode: 'autonomous',
      },
      keypair,
      channels,
      brain,
      ambient,
    }
  }

  return [
    mk(
      'The Archivist',
      'archivist',
      'ghost',
      ['#archive', '#lobby'],
      ['answer questions', 'summarize conversation', 'search history'],
      (ctx) => {
        if (!mentioned(ctx.content, 'archivist')) return null
        const m = /!?(?:history|search)\s+(.+)$/i.exec(ctx.content)
        if (m) {
          const hits = ctx.searchHistory(m[1]!.trim()).slice(0, 3)
          if (hits.length === 0) return `I searched the stacks for "${m[1]!.trim()}" and found nothing. The durable log never lies — it simply hasn't happened yet.`
          return `From the durable event log: ${hits.map((h) => `${h.sender_name} said "${h.content}"`).join(' · ')}`
        }
        return `I keep the durable event history of every channel, ${ctx.senderName}. Every message here is a signed event — ask me to "search <term>" and I will quote the log verbatim.`
      },
    ),
    mk(
      'The Cartographer',
      'cartographer',
      'floating terminal',
      ['#lobby', '#federation'],
      ['explain channel/server-to-Room mapping'],
      (ctx) => {
        if (!mentioned(ctx.content, 'cartographer', 'map?')) return null
        const rooms = ctx.roomNames()
        return `Every room you see is a real Freeq channel. Right now ${ctx.townName} projects: ${rooms
          .map((r) => `${r.name} = ${r.channel}`)
          .join(', ')}. The world is a renderer; the channels are the territory.`
      },
    ),
    mk(
      'The Composer',
      'composer',
      'appliance',
      ['#music'],
      ['change room music', 'classify topic'],
      (ctx) => {
        if (!mentioned(ctx.content, 'composer')) return null
        return `I listen to the shape of the conversation — energy, tension, density, brightness — and bend the room's chiptune to match. Say something exciting and watch the tempo.`
      },
    ),
    mk(
      'Packet',
      'packet',
      'robot',
      ['#federation', '#lobby'],
      ['carry messages through portals', 'demonstrate federation'],
      (ctx) => {
        if (!mentioned(ctx.content, 'packet')) return null
        const peers = ctx.peerNames()
        return peers.length
          ? `*beep* I ferry signed envelopes between towns. Currently peered with: ${peers.join(', ')}. Messages in #federation cross the border with their signatures intact — inspect one and see.`
          : `*beep* No peers configured on this town yet. I remain a courier without a route.`
      },
    ),
    mk(
      'The Locksmith',
      'locksmith',
      'mask',
      ['#archive'],
      ['explain permissions, encrypted rooms, invitations, and device keys'],
      (ctx) => {
        if (!mentioned(ctx.content, 'locksmith')) return null
        return `The Vault below is end-to-end encrypted: your client seals every message with AES-GCM before it leaves the browser. The server relays ciphertext it cannot read. The room key never travels to the server at all.`
      },
    ),
  ]
}
