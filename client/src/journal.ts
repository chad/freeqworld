// The journal: everything you've done in the world, grounded in real events.
// Stamps = channels genuinely visited; stars = courier runs an agent verified
// in a real channel; rekindles = you broke >24h of silence (checkable via
// CHATHISTORY); introductions = two people first-touched while standing with
// you. All local to this browser, like a paper journal in your pocket.

export interface Stamp {
  channel: string
  ts: number
}

interface JournalData {
  stamps: Stamp[]
  stars: number
  rekindled: string[]
  intros: string[]
}

const STORE_KEY = 'freeqworld-journal-v1'

export class Journal {
  private data: JournalData = { stamps: [], stars: 0, rekindled: [], intros: [] }

  constructor() {
    try {
      const raw = localStorage.getItem(STORE_KEY)
      if (raw) this.data = { ...this.data, ...(JSON.parse(raw) as Partial<JournalData>) }
    } catch {
      /* fresh journal */
    }
  }

  private save(): void {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(this.data))
    } catch {
      /* fine */
    }
  }

  /** returns true when this is a NEW place */
  stamp(channel: string, ts: number): boolean {
    if (this.data.stamps.some((s) => s.channel === channel)) return false
    this.data.stamps.push({ channel, ts })
    this.save()
    return true
  }

  stampCount(): number {
    return this.data.stamps.length
  }

  stamps(): Stamp[] {
    return [...this.data.stamps].sort((a, b) => b.ts - a.ts)
  }

  addStars(n: number): void {
    this.data.stars += n
    this.save()
  }

  stars(): number {
    return this.data.stars
  }

  rekindle(channel: string): boolean {
    if (this.data.rekindled.includes(channel)) return false
    this.data.rekindled.push(channel)
    this.save()
    return true
  }

  rekindled(): number {
    return this.data.rekindled.length
  }

  introduce(didA: string, didB: string): boolean {
    const key = [didA, didB].sort().join('|')
    if (this.data.intros.includes(key)) return false
    this.data.intros.push(key)
    this.save()
    return true
  }

  introductions(): number {
    return this.data.intros.length
  }
}

const DAY_MS = 24 * 3600 * 1000

/** Breaking more than a day of silence counts as rekindling the room. */
export function shouldRekindle(myTs: number, prevTs: number | null): boolean {
  if (prevTs === null) return false
  return myTs - prevTs > DAY_MS
}

const EXPLORER: [number, string][] = [
  [30, "Cartographer's Friend"],
  [15, 'Pathfinder'],
  [8, 'Wayfarer'],
  [3, 'Tourist'],
  [0, 'Homebody'],
]

export function explorerTitle(places: number): string {
  for (const [min, title] of EXPLORER) if (places >= min) return title
  return 'Homebody'
}
