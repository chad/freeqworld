// Shared musical parameters (spec §11.2/11.3, schema freeq.at/world/music-state/v1).
// Pure function of recent activity; classifier outputs control values only —
// no private labels are retained (spec §24.5). activityOnly mode never reads
// message content (spec §11.4).

export type TopicFamily =
  | 'technical' | 'social' | 'reflective' | 'argumentative' | 'celebratory'
  | 'creative' | 'urgent' | 'quiet' | 'chaotic' | 'musical'

export interface MusicState {
  schema: 'freeq.at/world/music-state/v1'
  energy: number
  tension: number
  density: number
  brightness: number
  topic_family: TopicFamily
  confidence: number
}

export interface MusicInput {
  recentMessages: { ts: number; content: string }[]
  participantCount: number
  now: number
  activityOnly?: boolean
}

const clamp = (x: number) => Math.max(0, Math.min(1, x))

const LEXICON: Partial<Record<TopicFamily, string[]>> = {
  technical: ['crdt', 'merge', 'signature', 'verification', 'bug', 'stack', 'trace', 'websocket', 'protocol', 'handshake', 'panic', 'compile', 'server', 'code', 'api', 'commit', 'deploy', 'test', 'schema', 'did:'],
  argumentative: ['wrong', 'disagree', 'never', 'broken', 'no,', 'actually', 'terrible', 'bad idea'],
  celebratory: ['congrats', 'congratulations', 'yay', 'woohoo', '🎉', 'amazing', 'awesome', 'shipped', 'launch', 'party'],
  reflective: ['wonder', 'perhaps', 'maybe', 'feel like', 'thinking about', 'remember'],
  creative: ['draw', 'design', 'compose', 'paint', 'sketch', 'build a', 'make a', 'idea:'],
  urgent: ['urgent', 'asap', 'now!', 'emergency', 'down!', 'outage', 'help!'],
  musical: ['song', 'music', 'chord', 'melody', 'jam', 'beat', 'album', 'track'],
}

export function computeMusicState(input: MusicInput): MusicState {
  const windowMs = 120_000
  const recent = input.recentMessages.filter((m) => input.now - m.ts <= windowMs)
  const perMinute = recent.length / (windowMs / 60_000)

  const density = clamp(perMinute / 10)
  const energy = clamp(perMinute / 12 + input.participantCount / 30)

  if (input.activityOnly || recent.length === 0) {
    const topic: TopicFamily = recent.length === 0 ? 'quiet' : perMinute > 8 ? 'chaotic' : 'social'
    return {
      schema: 'freeq.at/world/music-state/v1',
      energy,
      tension: clamp(perMinute / 20),
      density,
      brightness: clamp(0.3 + input.participantCount / 20),
      topic_family: topic,
      confidence: recent.length === 0 ? 0.5 : 0.4,
    }
  }

  const text = recent.map((m) => m.content.toLowerCase()).join(' ')
  const scores = new Map<TopicFamily, number>()
  for (const [family, words] of Object.entries(LEXICON) as [TopicFamily, string[]][]) {
    let n = 0
    for (const w of words) {
      let i = -1
      while ((i = text.indexOf(w, i + 1)) !== -1) n++
    }
    if (n > 0) scores.set(family, n)
  }
  const exclaims = (text.match(/!/g) ?? []).length
  if (exclaims >= 2) scores.set('argumentative', (scores.get('argumentative') ?? 0) + exclaims * 0.5)
  // celebration outshouts argument when both are loud
  if ((scores.get('celebratory') ?? 0) >= 2) {
    scores.set('argumentative', Math.max(0, (scores.get('argumentative') ?? 0) - exclaims * 0.5))
  }

  let topic: TopicFamily = perMinute > 8 ? 'chaotic' : 'social'
  let best = 1.5 // require real signal to leave the default
  for (const [family, score] of scores) {
    if (score > best) { best = score; topic = family }
  }

  const positives = (scores.get('celebratory') ?? 0)
  const negatives = (scores.get('argumentative') ?? 0) + (scores.get('urgent') ?? 0)
  const tension = clamp(negatives / 5 + (topic === 'argumentative' ? 0.3 : 0) + perMinute / 40)
  const brightness = clamp(0.4 + positives / 4 - negatives / 6 + (topic === 'celebratory' ? 0.2 : 0))
  const confidence = clamp(best / 6 + 0.3)

  return { schema: 'freeq.at/world/music-state/v1', energy, tension, density, brightness, topic_family: topic, confidence }
}
