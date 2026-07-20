// Spatial presence over IRCv3 client tags: a vendored TAGMSG tag carrying
// x,y,facing,animation,sequence. TAGMSG is relayed to channel members but
// never stored in CHATHISTORY — the protocol-native realization of the
// spec's ephemeral WorldPosition (§7.4).

export const POS_TAG = '+freeq.at/world-pos'

const FACINGS = ['north', 'south', 'east', 'west'] as const
const ANIMS = ['idle', 'walk', 'react'] as const

export interface PosTagValue {
  x: number
  y: number
  facing: (typeof FACINGS)[number]
  animation: (typeof ANIMS)[number]
  sequence: number
}

export function encodePosTag(p: PosTagValue): string {
  return `${p.x.toFixed(2)},${p.y.toFixed(2)},${p.facing},${p.animation},${p.sequence}`
}

export function decodePosTag(value: string): PosTagValue | null {
  const parts = value.split(',')
  if (parts.length !== 5) return null
  const x = Number(parts[0])
  const y = Number(parts[1])
  const facing = parts[2] as PosTagValue['facing']
  const animation = parts[3] as PosTagValue['animation']
  const sequence = Number(parts[4])
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(sequence)) return null
  if (!FACINGS.includes(facing) || !ANIMS.includes(animation)) return null
  return { x, y, facing, animation, sequence }
}
