# FreeqWorld game design

> **Provenance.** The spine of this document is a long design conversation
> between Chad and an earlier agent session that was never written down; the
> handoff note listed its topics but not its conclusions. What follows is that
> skeleton, reconstructed and then grounded in what the protocol can *actually*
> verify today (with file references, so claims are checkable). Sections marked
> **[reconstructed]** need Chad's correction — they are the topics, filled in
> from the code, not a transcript of what he decided.

## The thesis

The world is a renderer; the channels are the territory. Every room is a real
freeq channel, every character is a real DID, every quest is real work witnessed
by a real agent in a real channel. The game is not a metaphor laid over chat — it
is chat, rendered, with the protocol's own guarantees as its rules.

That gives one hard design constraint, which is also the most useful one:

**A mechanic is only allowed if the protocol can verify it.**

Not "if we can imagine it" and not "if we can fake it client-side". If the server
or a witnessing agent cannot tell whether you did the thing, it isn't a quest —
it's a button that lies to you.

## Quest taxonomy, grounded in what is verifiable

The four shipped runs (`scripts/world-agents.mjs`) are each verifiable by a
different protocol feature, which is why they exist:

| run | the work | what verifies it |
|---|---|---|
| `courier` | carry a sealed phrase to another room and say it aloud | the agent is a member of the target channel and witnesses the PRIVMSG |
| `survey` | report a room's topic | checked against the real `LIST` register |
| `rekindle` | speak first in a room gone quiet (>1d) | `CHATHISTORY` timestamps |
| `escort` | greet a newcomer by name **and** draw a reply | two-half witness: the greeting *and* the answer, both on the wire |

The escort run is the model to copy. A single-half version ("say hello to a
newcomer") can be farmed by shouting into an empty room; requiring the *other
person's reply* makes the completion condition something only a real interaction
can produce. **Design rule: prefer completion conditions that need a second
party's voluntary act.**

Runs that were considered and are NOT verifiable today, with the reason:

- *"Visit N rooms"* — the client only receives messages for its current channel,
  so presence elsewhere is unwitnessed unless an agent is in each room.
- *"Unread-as-light"* (rooms glow by unread count) — same limit; it needs
  read-marker support or periodic `CHATHISTORY` probes. This was initially
  thought cheap and is not.
- *Anything timed on the client* — trivially forged.

## Entropy as the antagonist **[reconstructed]**

There is no villain, and inventing one would be a lie about what the world is.
The antagonist is **entropy**: channels go quiet, knowledge is lost, debris
accumulates. The world should *show* this — a dead channel visibly decaying, dust
and darkness gathering in a room nobody has spoken in for a month — and let
players push back against it.

This is attractive because the decay signal is real data (`CHATHISTORY`
recency), the pushback is a real act (speaking, which is what `rekindle` already
rewards), and the aesthetic is already built: the lighting layer in
`client/src/gfx.ts` has a per-template ambient dial, so "this room is dying" is a
number that can drive it.

Open question for Chad: does decay ever become *destructive* (a room that
collapses / is archived), or purely cosmetic? Destruction is more honest about
entropy but risks punishing small channels that are simply private.

## Capabilities as character classes **[reconstructed]**

`freeq.at/act` carries an **open** `act-caps` vocabulary; only `freeq.at/search`
is defined server-side. The game therefore gets to define the rest, and a
capability is a real grant (`agent_capability_grants` has TTL, rate limit and
`requires_approval`), not a label.

So a "class" is the set of capabilities you actually hold — courier, surveyor,
archivist, escort — and levelling means being *granted* more, by an agent or by
another player. Reputation and class are the same object seen from two sides.

Constraint to respect: `act-from` is the browser's device `did:key`, not the
user's `did:plc`, because that's the key that signs and it's locally verifiable
(a browser can't resolve did:plc keys). Any class/reputation design must key on
something durable across devices — the linked did:plc — while still verifying
per-device signatures.

## Reputation as signed work history **[reconstructed]**

Not a score the server hands out: a **log of signed completions**. Each
`complete` is an ed25519-signed act with an id, a capability and a witness. A
player's reputation is the set of those signatures, verifiable by anyone with the
public key that a `did:key` carries in its own name — which is why the quest
board can show "◈ sig VERIFIED" with no lookup.

Consequence worth stating plainly: **there is no server-side act validator or
materialized view today.** Nothing enforces the RFC's transition table; peers
validate optimistically and the signed log is the truth. That is phase one
exactly as the RFC prescribes, but reputation UI must not claim more than
"these signatures verify".

## Guilds as channels with real budgets **[reconstructed]**

A guild is not a new entity — it's a channel with a `channel_budget` and members
who hold capabilities. That reuses policy that already exists server-side
(`channel_budgets`) rather than inventing a parallel social structure, and it
means guild power is *literally* the resource the channel controls.

## Which IRCv3 capabilities are load-bearing

Worth distinguishing, because it decides what the world can promise:

- **Load-bearing:** `TAGMSG` (all act traffic, positions, typing — invisible to
  plain IRC clients, which is what lets the world share channels with real
  users), `CHATHISTORY` (room memory, rekindle, newcomer seeding), `LIST` (the
  world's map is generated from it), SASL + `did:key` (identity), `echo-message`
  (optimistic local echo).
- **Gimmick / cosmetic:** away-notify, typing indicators, reactions — nice
  texture, no mechanic should depend on them.

A mechanic built on a gimmick cap degrades to nothing when a client doesn't
support it. A mechanic built on TAGMSG + CHATHISTORY works for every participant
including ones who never open the game.

## Next build (recommended order, from the handoff)

1. **Familiars as real spawned agents** — the showpiece. Now fully planned in
   [FAMILIARS-PLAN.md](FAMILIARS-PLAN.md) with the protocol facts verified
   against the server source (AGENT SPAWN/MSG/DESPAWN all shipped; children die
   with the parent session; CHATHISTORY needs membership).
2. **Act completion from the agent side**, plus capabilities as classes.
3. **Make the demo-town furniture real** — 24 of 30 objects are scenery. Best
   conversions: issue-board → open handoff offers, help-desk → dispatch your
   familiar, whiteboard → a real pin (the `pins` table exists), build-monitor →
   subscribe to channel state.

## Known limits to design around (verified, not guessed)

- Escort/survey/rekindle only work in the agent's channels (`#general`, `#lobby`,
  `#dev`) because that is where it can witness. Widening means joining more.
- Quests must not litter: automated flows minting channels produced ~100 dead
  `#fimp-e2e-*` channels. Reuse channels, or add a TTL and a reaper.
- The world canvas is **tainted** (gallery-wall images come from
  `irc.freeq.at/api/v1/media`, which sends no CORS header), so `getImageData` /
  `toDataURL` throw. Harmless to players, blocks pixel-readback tests. The real
  fix is CORS headers on that media endpoint.
