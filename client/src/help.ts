// The help page. Built from the same constants that run the game, so it cannot
// drift: quest payouts come from the scoring table, the ladder from LEVELS, the
// keys from the list onKeyDown actually reads. A help page that lies is worse
// than none — we already shipped a design doc claiming rekindle needed a day of
// silence when nothing checked for it.

import { LADDERS, LEVELS, QUEST_KINDS, levelFor } from '../../shared/src/xp'

export interface HelpContext {
  /** the visitor's channel, so examples name a room they're standing in */
  channel: string
  xp: number
  runs: number
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const KEYS: [string, string][] = [
  ['W A S D / arrows', 'walk'],
  ['click the floor', 'walk there'],
  ['E', 'use whatever you are standing next to — boards, the obelisk, a lectern, a person'],
  ['space', 'jump'],
  ['Enter', 'jump to the message box; Enter again sends'],
  ['C', 'chat-only view / back'],
  ['G', 'the channel directory — every room in the town'],
  ['M', 'town map'],
  ['B', 'your spark book'],
  ['R', 'react 👍 to the last message'],
  ['Esc', 'close whatever is open'],
  ['?', 'this page'],
]

function section(title: string, body: string): string {
  return `<h3 style="margin:16px 0 6px;font-size:.92rem;color:var(--amber)">${title}</h3>${body}`
}

const dim = (s: string): string => `<div style="color:var(--dim);font-size:.84rem;line-height:1.55">${s}</div>`

export function helpHtml(ctx: HelpContext): string {
  const lv = levelFor(ctx.xp)
  const out: string[] = []

  out.push(dim(
    `You are in a real IRC channel. Every room is a channel on <code>irc.freeq.at</code>, ` +
    `every person is a real identity, and people using ordinary IRC clients are in here with you — ` +
    `they see your words and none of the game. Your face and your theme tune are both computed from ` +
    `your DID, so they are yours everywhere, forever, and nothing was uploaded.`,
  ))

  // ---- moving about --------------------------------------------------------
  out.push(section('Getting around', `
    <table style="width:100%;font-size:.86rem;border-collapse:collapse">
      ${KEYS.map(([k, v]) => `<tr>
        <td style="padding:2px 8px 2px 0;color:var(--cyan);white-space:nowrap;vertical-align:top">${esc(k)}</td>
        <td style="padding:2px 0;color:var(--ink)">${esc(v)}</td></tr>`).join('')}
    </table>
    ${dim('Doors are the gaps in the walls. Walk into one and you change channel — the room you arrive in is the channel you just joined.')}`))

  // ---- the work ------------------------------------------------------------
  out.push(section('Work, and how it is witnessed', `
    ${dim(
      `Say <b>cartographer, quest</b> in a channel the Cartographer watches ` +
      `(<code>#general</code>, <code>#lobby</code>, <code>#dev</code>) and it will DM you a run. ` +
      `Nothing is awarded for talking — every run has to be confirmed by a witness or by the register, ` +
      `which is what keeps this from turning real channels into a grind.`,
    )}
    <div style="margin-top:8px">
      ${QUEST_KINDS.map((q) => `
        <div style="border-left:2px solid var(--border);padding:4px 0 4px 8px;margin-bottom:8px">
          <div><b>${esc(q.label)}</b> <span style="color:var(--amber)">${q.xp}${q.alwaysDouble ? ' × 2' : ''} XP</span>
            <span style="color:var(--dim);font-size:.78rem">${
              q.trust === 'oracle' ? '· trusts an oracle'
                : q.trust === 'self-signed' ? '· needs no third party'
                : '· witnessed in-channel'
            }</span></div>
          <div style="font-size:.84rem;margin-top:2px"><code>${esc(q.ask)}</code></div>
          <div style="color:var(--dim);font-size:.84rem">${esc(q.doThis)}</div>
          <div style="color:var(--dim);font-size:.8rem;font-style:italic">${esc(q.witnessedBy)}</div>
        </div>`).join('')}
    </div>
    ${dim(
      `A courier run pays double into a room that has been quiet for hours. Repeating the same kind of ` +
      `run in the same room on the same day pays 100%, then 50%, then 25%, then nothing — so spread out, ` +
      `and take the work that is actually scarce.`,
    )}`))

  // ---- levels --------------------------------------------------------------
  const shown = LEVELS.filter((l) => l.unlock)
  out.push(section('Levels', `
    ${dim(
      `Your level is not a number anyone keeps for you. Every completed run is signed by the witness and ` +
      `stored on a public log; your XP is a <b>computation over that log</b>, and anyone can recompute it:<br>` +
      `<code>irc.freeq.at/api/v1/channels/%23general/events?type=quest_complete</code>`,
    )}
    <div style="margin-top:8px;font-size:.86rem">
      ${shown.map((l) => `<div style="display:flex;gap:8px${l.level === lv.level ? ';color:var(--amber)' : ''}">
        <span style="color:var(--dim);width:3.6em">L${l.level}</span>
        <span style="width:6.5em">${esc(l.title)}</span>
        <span style="flex:1">${esc(l.unlock ?? '')}</span>
        <span style="color:var(--dim)">${l.at}</span></div>`).join('')}
    </div>
    ${dim(
      `Levels hand you <b>verbs</b>, not bigger numbers: reading the register, waking dead rooms, vouching ` +
      `for newcomers, dispatching a familiar of your own, founding a guild, and finally countersigning ` +
      `other people's work. ` +
      (ctx.runs
        ? `You are level ${lv.level} (${esc(lv.title)}) on ${ctx.xp} XP from ${ctx.runs} witnessed run${ctx.runs === 1 ? '' : 's'}.`
        : `You have no witnessed work yet — that is what the quest board is for.`),
    )}`))

  // ---- boards --------------------------------------------------------------
  out.push(section('Standing', `
    ${dim(`Press E at the <b>Obelisk of standing</b> in any room. There are ${LADDERS.length} separate boards, ` +
      `so leading one does not require beating everybody at everything:`)}
    <div style="margin-top:6px;font-size:.86rem">
      ${LADDERS.map((l) => `<div><span style="color:var(--cyan)">${esc(l.label)}</span>
        <span style="color:var(--dim)"> — ${esc(l.blurb)}</span></div>`).join('')}
    </div>`))

  // ---- the rest ------------------------------------------------------------
  out.push(section('Sound', dim(
    `The <b>♪</b> button in the header sets how much music you want: <i>off</i>, <i>moments</i> (only around ` +
    `arrivals and mentions), <i>breathing</i> (swells when the room is alive, rests when it goes quiet), or ` +
    `<i>always</i>. The <b>▾</b> beside it has separate levels for room music, identity motifs and effects. ` +
    `Every room has its own cue, and each person has a three-to-five note motif derived from their DID: you ` +
    `hear theirs when they arrive or call your name, and a ♪ appears over whoever is sounding.`,
  )))

  out.push(section('Proving any of this', dim(
    `Switch to <b>Dev</b> mode in the header to watch the raw protocol as you play — signed events, ` +
    `presence, the act offers behind the quest board, and the signature check on each one. Nothing in the ` +
    `world is decoration over a database: <code>/api/debug/log/%23lobby</code> is the store itself.`,
  )))

  return out.join('')
}
