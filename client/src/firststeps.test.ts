import { describe, expect, it } from 'vitest'
import { progress, steps, type StepState } from './firststeps'

const guest: StepState = { did: 'did:key:z6MkGuest', real: false, standing: null, wearingFace: false, heardTheme: false }
const standing = (over: Record<string, unknown> = {}) => ({
  player: 'did:plc:x', xp: 10, level: 1, title: 'Wanderer', runs: 1, lastAt: 0,
  byLadder: { courier: 1, cartographer: 0, kindler: 0, welcomer: 0, herald: 0, witness: 0 },
  ...over,
}) as StepState['standing']

describe('first steps are earned, not clicked', () => {
  it('starts a guest at zero and tells them what a guest cannot do', () => {
    const list = steps(guest)
    expect(progress(list)).toMatchObject({ done: 0, total: 5 })
    expect(list[0]!.detail).toMatch(/outlives this browser/)
  })

  it('ticks identity only for a real AT Protocol account', () => {
    expect(steps({ ...guest, real: false })[0]!.done).toBe(false)
    expect(steps({ ...guest, real: true })[0]!.done).toBe(true)
  })

  it('ticks the run only when the signed ledger has one', () => {
    expect(steps(guest)[2]!.done).toBe(false)
    expect(steps({ ...guest, standing: standing() })[2]!.done).toBe(true)
    // zero runs must not count, even with a standing object present
    expect(steps({ ...guest, standing: standing({ runs: 0 }) })[2]!.done).toBe(false)
  })

  it('ticks the face only when the hash actually matched', () => {
    expect(steps({ ...guest, wearingFace: false })[3]!.done).toBe(false)
    expect(steps({ ...guest, wearingFace: true })[3]!.done).toBe(true)
  })

  it('ticks the herald only when somebody was actually brought in', () => {
    const withHerald = standing({ byLadder: { courier: 0, cartographer: 0, kindler: 0, welcomer: 0, herald: 1, witness: 0 } })
    expect(steps({ ...guest, standing: standing() })[4]!.done).toBe(false)
    expect(steps({ ...guest, standing: withHerald })[4]!.done).toBe(true)
  })

  it('completes only when every item is genuinely true', () => {
    const all: StepState = {
      did: 'did:plc:x', real: true, wearingFace: true, heardTheme: true,
      standing: standing({ runs: 3, byLadder: { courier: 1, cartographer: 0, kindler: 0, welcomer: 0, herald: 1, witness: 0 } }),
    }
    expect(progress(steps(all)).complete).toBe(true)
  })

  it('always tells you how to do the next thing', () => {
    for (const s of steps(guest)) expect(s.how, s.id).toBeTruthy()
  })
})
