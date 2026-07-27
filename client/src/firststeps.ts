// First steps: the only tutorial that is allowed here.
//
// Every item is a REAL thing the world can confirm — a witnessed run in the
// signed ledger, an avatar whose bytes hash to your DID, an identity that isn't
// a throwaway browser key. Nothing is ticked because you clicked something.
// A checklist that congratulates you for nothing is the exact opposite of a
// world whose whole claim is that its rewards are provable.
//
// It shows once, tracks live, and disappears for good when it is done.

import type { Standing } from '../../shared/src/xp'

export interface StepState {
  /** the DID we are judging, or null for a guest */
  did: string | null
  /** true when signed in with an AT Protocol identity */
  real: boolean
  /** verified standing from the signed log */
  standing: Standing | null
  /** are they wearing the portrait their DID derives? */
  wearingFace: boolean
  /** have they heard their theme this session? */
  heardTheme: boolean
}

export interface Step {
  id: string
  label: string
  detail: string
  done: boolean
  /** what to type or press, when there is something to do */
  how?: string
  /** a message the client can send on their behalf — typing an exact phrase is
   *  real friction, especially on a phone */
  say?: string
}

export function steps(s: StepState): Step[] {
  const runs = s.standing?.runs ?? 0
  const ladders = s.standing?.byLadder
  return [
    {
      id: 'identity',
      label: 'Arrive as yourself',
      detail: s.real
        ? 'your character and theme are computed from your DID'
        : 'a guest key works for looking around, but nothing you do can be tied to an identity that outlives this browser',
      done: s.real,
      how: 'sign in with your Bluesky handle',
    },
    {
      id: 'theme',
      label: 'Hear your theme',
      detail: 'three to five notes derived from your identity, and nobody else has them',
      done: s.heardTheme,
      how: 'press ♪ in the header',
    },
    {
      id: 'run',
      label: 'Finish a run someone witnessed',
      detail: runs
        ? `${runs} witnessed run${runs === 1 ? '' : 's'} in the signed ledger`
        : 'the Cartographer watches the room and signs what it sees',
      done: runs > 0,
      how: 'say "cartographer, quest" in the chat',
      say: 'cartographer, quest',
    },
    {
      id: 'face',
      label: 'Wear a face that proves itself',
      detail: s.wearingFace
        ? 'your avatar hashes to the portrait your DID derives'
        : 'set your Bluesky avatar to your derived character — the check compares the hash of the bytes',
      done: s.wearingFace,
      how: 'pfp.freeq.at, then "cartographer, quest face"',
    },
    {
      id: 'herald',
      label: 'Bring somebody in',
      detail: (ladders?.herald ?? 0) > 0
        ? 'you have brought a new identity into the world'
        : 'an invitation carries your name, signed — it pays the most of anything here',
      done: (ladders?.herald ?? 0) > 0,
      how: 'say "cartographer, quest referral"',
      say: 'cartographer, quest referral',
    },
  ]
}

export function progress(list: Step[]): { done: number; total: number; complete: boolean } {
  const done = list.filter((x) => x.done).length
  return { done, total: list.length, complete: done === list.length }
}

const KEY = 'fimp-first-steps-dismissed'

export function dismissed(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export function dismiss(): void {
  try {
    localStorage.setItem(KEY, '1')
  } catch {
    /* private mode: it will come back next load, which is survivable */
  }
}

/**
 * On a phone the full list is taller than the screen and covers the world, so
 * show only what matters: how far along you are, and the next thing to do.
 * (Measured: 914px of panel on a 664px viewport.)
 */
export function renderCompact(list: Step[]): string {
  const { done, total } = progress(list)
  const next = list.find((s) => !s.done)
  if (!next) return ''
  return `<div style="display:flex;justify-content:space-between;align-items:baseline">
      <b style="color:var(--amber)">First steps</b>
      <span style="color:var(--dim);font-size:.78rem">${done} of ${total}</span>
    </div>
    <div style="margin-top:4px">${next.label}</div>
    ${next.say
      ? `<button data-say="${next.say}" style="margin-top:4px;padding:4px 8px;font-size:.78rem;width:100%">ask the Cartographer</button>`
      : `<div style="color:var(--cyan);font-size:.78rem;line-height:1.4">${next.how ?? ''}</div>`}`
}

export function render(list: Step[]): string {
  const { done, total } = progress(list)
  const rows = list
    .map((s) => {
      const mark = s.done ? '◈' : '◇'
      const colour = s.done ? 'var(--green)' : 'var(--dim)'
      const strike = s.done ? 'opacity:.65' : ''
      return `<div style="display:flex;gap:8px;margin-bottom:6px;${strike}">
        <span style="color:${colour}">${mark}</span>
        <div>
          <div style="color:${s.done ? 'var(--dim)' : 'var(--ink)'}">${s.label}</div>
          <div style="color:var(--dim);font-size:.78rem;line-height:1.4">${s.detail}${
            !s.done && s.how && !s.say ? ` — <span style="color:var(--cyan)">${s.how}</span>` : ''
          }</div>${
            !s.done && s.say
              ? `<button data-say="${s.say}" style="margin-top:4px;padding:3px 8px;font-size:.76rem">ask the Cartographer</button>`
              : ''
          }
        </div>
      </div>`
    })
    .join('')
  return `<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
      <b style="color:var(--amber)">First steps</b>
      <span style="color:var(--dim);font-size:.78rem">${done} of ${total}</span>
    </div>${rows}
    <div style="color:var(--dim);font-size:.74rem;margin-top:6px;line-height:1.45">
      Nothing here ticks because you clicked it — each one is read back from the
      signed ledger or from your own repo.
    </div>`
}
