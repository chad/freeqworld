import { describe, expect, it } from 'vitest'
import { LEVELS, QUEST_KINDS } from './xp'

// The help page is generated from these, so a payout can never be described
// wrongly — the whole reason this file exists is that a design doc once claimed
// rekindle required a day of silence when nothing checked for it.
describe('the quest catalogue the help page renders', () => {
  it('describes every run the witness can actually confirm', () => {
    expect(QUEST_KINDS.map((q) => q.id)).toEqual(['courier', 'survey', 'rekindle', 'escort'])
  })

  it('reads its XP from the scoring table rather than restating it', () => {
    // if someone retunes the weights, these move with them
    const courier = QUEST_KINDS.find((q) => q.id === 'courier')!
    const escort = QUEST_KINDS.find((q) => q.id === 'escort')!
    expect(escort.xp).toBeGreaterThan(courier.xp)
    for (const q of QUEST_KINDS) expect(q.xp).toBeGreaterThan(0)
  })

  it('tells the player exactly what to type and what to do', () => {
    for (const q of QUEST_KINDS) {
      expect(q.ask).toMatch(/^cartographer, quest/)
      expect(q.doThis.length).toBeGreaterThan(20)
      expect(q.witnessedBy.length).toBeGreaterThan(20)
    }
  })

  it('claims a witness for each run, and no unwitnessable work', () => {
    const claims = QUEST_KINDS.map((q) => q.witnessedBy.toLowerCase()).join(' ')
    expect(claims).toMatch(/member of that channel|register|timestamps|both halves/)
    // nothing may claim to be verified "automatically" or by the client
    expect(claims).not.toMatch(/client-side|trust me|automatic/)
  })

  it('only promises unlocks that the ladder actually contains', () => {
    const unlocks = LEVELS.filter((l) => l.unlock)
    expect(unlocks.length).toBeGreaterThanOrEqual(8)
    // the help page prints these verbatim; they must name real capabilities
    expect(unlocks.map((l) => l.unlock).join(' ')).toMatch(/survey|rekindle|escort|familiar|guild|countersign/)
  })
})
