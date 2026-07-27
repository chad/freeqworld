# Familiars — implementation plan

> For a sub-agent picking this up cold. Everything in "Protocol facts" was
> verified against the freeq server source (paths given) on 2026-07-27, not
> remembered. Read `AGENTS.md` at the repo root first — deploy discipline,
> frozen files, and testing gotchas all apply. Repo: `~/src/freeqworld/fimp`.

## What a familiar is

At level 12 (Handler) — an unlock the shipped ladder **already promises**
(`shared/src/xp.ts`: `{ level: 12, ..., unlock: 'dispatch a familiar — a real
spawned agent' }`) — a player hatches a familiar: a small creature derived from
their DID, which is a **real spawned agent on the freeq server**, not a
client-side decoration.

You can dispatch it to another room. It *visibly joins that channel* — every
IRC client in the room, including ones that have never heard of the game, sees
`wisp-mira JOIN #music` tagged `+freeq.at/actor-class=agent;
+freeq.at/parent=<your-nick>`. While dispatched it watches; when you recall it
(or visit it), it reports what happened — real lines, from real history. Other
world players in that room see a little creature standing there, labeled as
yours.

That's the pitch: a pet that is literally a scoped child agent with a row in
`spawned_agents` and provenance tags on the wire. The feature demos freeq's
agent infrastructure while looking like a Tamagotchi.

## Protocol facts (verified — design against these, don't rediscover them)

Server source: `~/src/freeq/freeq-server/src/`.

1. **`AGENT SPAWN #channel :nick=name;capabilities=a,b;ttl=300;task=id`**
   (`connection/mod.rs` ~line 2209). Creates a *virtual* child presence:
   derived `child_did`, row in `spawned_agents` (`db.rs` ~497: child_did,
   parent_did, parent_session, nick, channel, capabilities_json, ttl_seconds,
   task_ref, spawned_at, despawned_at), broadcasts a JOIN to the channel with
   `+freeq.at/actor-class=agent;+freeq.at/parent=<parent>` tags. Nick must be
   free — collision is rejected, so handle it.
2. **`AGENT MSG <childNick> <channel> :text`** (~line 2656) — the child speaks,
   attributed with parent tag. **v1 familiars never use this in public
   channels** (litter policy below), but it exists.
3. **`AGENT DESPAWN <nick>`** (~line 2576). TTL also auto-despawns.
4. **Children die when the parent session ends** (`connection/mod.rs` ~3899:
   on cleanup, all children of the session get QUIT "Parent disconnected" and
   `record_despawn`). **A familiar cannot watch while the player is offline.**
   This is the hard constraint the whole UX must be honest about.
5. **`CHATHISTORY` requires channel membership** (`messaging.rs`,
   `resolve_history_target`: `ch.members.contains(session_id)` → FAIL
   otherwise). So the *parent client* must stay joined to the watched channel
   to read what happened there. The SDK connection can hold many channels; the
   world just renders one at a time.
6. **SDK surface already exists** (`~/src/freeq/freeq-sdk-js/src/client.ts`):
   `spawnAgent(channel, nick, capabilities, ttlSeconds?, taskRef?)`,
   `despawnAgent(nick)`, `sendAsChild(childNick, channel, text)`, and inbound
   events `agentSpawned` / `agentDespawned` (parsed from the tagged JOIN/QUIT,
   hostmask `*!spawn@freeq/spawn/*`). Check `client/src/freeqBackend.ts` for
   which of these are re-exported to the app; add thin wrappers where missing.

## Honesty constraints (these are design decisions, not suggestions)

- **Never claim the familiar watched while you were offline.** It despawned
  the moment you disconnected (fact 4). On reconnect the client re-dispatches
  and may fetch CHATHISTORY since the player's departure — present that as
  "your familiar read the room's chronicle on waking", never as "it saw".
  The data is real either way; the words must match the mechanism.
- **The hatch is ledger-backed.** The server doesn't know about XP, so L12 is
  enforced by the witness: the player says `cartographer, hatch familiar`; the
  Cartographer computes their standing from the same public event log everyone
  reads (`shared/src/xp.ts` is already imported by `scripts/world-agents.mjs`),
  and either attests a `+freeq.at/event=familiar_hatched` TAGMSG (payload:
  player DID, familiar name, ed25519 witness sig — same shape as
  `quest_complete`) or refuses naming their actual level and the XP still
  needed. The client renders a familiar **only if the hatch event verifies**.
  No client-side "trust me I'm level 12".
- **No XP for dispatching.** Dispatch is repeatable and free → farmable →
  forbidden as a score source. Hatching itself is the reward (and is one-time).
  If a quest is wanted later, it must follow the escort model (a second party's
  voluntary act), not mere dispatch.
- **Litter policy: the familiar is silent in public channels in v1.** Its JOIN
  and QUIT are already visible; that's enough presence. Reports go to the
  owner's UI only. (`sendAsChild` stays unused until there's a mechanic that
  justifies speech.)
- **One familiar per player. Public channels only** — never dispatch into a
  channel the player couldn't freely join.

## Derivation (`shared/src/familiar.ts` — new file)

`shared/src/avatar.ts` and `shared/src/leitmotif.ts` are **FROZEN** (conformance
fixtures) — do not touch them. Create a new module with the same HKDF pattern
and a **new info string** (e.g. `freeq-familiar-v1`), deriving from the
player's DID:

- **species** — pick 4–6 that read at 8×8px: wisp, moth, cat, crow, salamander,
  snail. One accent color from the same palette family as the owner's avatar.
- **name** — two syllables, pronounceable, deterministic (e.g. `mira`, `toki`);
  IRC nick is `wisp-mira` / `moth-toki` style: `<species>-<name>`. On nick
  collision at spawn time, retry with `-2`, `-3` suffix (the *derived* name is
  stable; the wire nick tolerates suffixing).
- Write a conformance test with fixed expected outputs for 3 known DIDs (same
  style as avatar/leitmotif fixtures) and then treat the file as frozen too.

## Client work (`client/src/familiar.ts` — new module, plus render hooks)

State machine, kept as a pure-ish class so it's testable:

```
none → (hatch event verified) → perched
perched → follow (walks behind owner, lerp, sits on shoulder when idle)
follow → dispatched(#channel)   [player action]
dispatched → returning → perched  [recall, or owner walks into that room]
any → asleep                     [disconnect; server killed the child]
asleep → perched (+ catch-up report offered)  [reconnect + re-spawn]
```

- **Dispatch UX**: press E on the familiar → door list (same data as the door
  labels), or type `familiar, watch #music`. On dispatch: client calls
  `join(#target)` (parent membership — fact 5), then `spawnAgent('#target',
  wireNick, ['observe'], 900, hatchEventId)`; renew TTL every 5 minutes while
  dispatched (belt and braces — the session tie already reaps orphans). The
  sprite walks to the door and vanishes through it; the JOIN appears in the
  target room.
- **Report**: on recall/visit, render a scroll UI (reuse the quest-board panel
  style): N messages, who spoke (top 3), any `quest_complete` events witnessed
  there, first/last line — all from CHATHISTORY since dispatch, which the
  client can read because the parent stayed joined. A "go there" button.
- **Everyone else sees it**: members whose hostmask matches
  `*!spawn@freeq/spawn/*` (or who arrive via the `agentSpawned` event) render
  as the small creature sprite, not a person, labeled `✧ <parent>'s familiar`
  through the existing tag allocator (`drawTag`). Derive the sprite from the
  *parent's* DID so it looks the same to everyone. This is the virality
  surface — do not skip it.
- **Persistence**: `localStorage` remembers dispatch target; on reconnect,
  re-join + re-spawn and offer the catch-up report (honesty wording above).
- The wisp/bird that currently follows players decoratively: keep for
  sub-L12 players; the hatch replaces it with the real thing.

## Cartographer work (`scripts/world-agents.mjs`)

- Intent `hatch familiar` (and "hatch my familiar", etc. — follow the existing
  intent-matching style): compute level from the ledger; if ≥ 12 → attest
  `familiar_hatched` (once — refuse a second hatch pointing at the first
  event); else refuse with current level, XP needed, and one concrete way to
  earn it. Every refusal states its reason (house rule: every failure path
  surfaces what happened).
- The Cartographer should also **verify the spawn is real** when it can: it
  will see the familiar's tagged JOIN in channels it inhabits (#general,
  #lobby, #dev). Nice-to-have: greet a newly arrived familiar by its owner's
  name. One line, big charm.

## Server-side / infra

None required — that's the point. Everything uses shipped protocol. If the
`agentSpawned` event isn't surfaced through `client/src/freeqBackend.ts`, add
the pass-through (SDK already emits it).

## Tests (rules from AGENTS.md: never pipe vitest through `tail`)

1. `shared/src/familiar.test.ts` — derivation fixtures for 3 DIDs;
   determinism; nick shape is IRC-legal.
2. `client/src/familiar.test.ts` — state machine transitions, incl.
   disconnect→asleep→catch-up; report summarizer as a pure function over a
   fake message log (counts, top speakers, empty-room case).
3. Witness logic: unit-test the hatch decision (level gate, double-hatch
   refusal) the way `shared/src/quest.test.ts` tests courier decisions.
4. e2e, two browser contexts against the local server (`FIMP_START=1
   PORT_A=8797 PORT_B=8798 npx vite-node server/src/main.ts`): player A
   hatches (seed A's ledger standing or stub the witness), dispatches to
   #room2 where player B stands; assert B *renders* the creature sprite and
   the label, A gets a report containing a line B actually said. Assert the
   plain-IRC view too if a raw client harness exists (the JOIN/QUIT lines).
5. The existing suite must stay green: `npx tsc --noEmit && npx vitest run`.

## Acceptance criteria

- [ ] A level-12 player can hatch exactly one familiar; the hatch is a signed,
      publicly-verifiable ledger event; below L12 the refusal names the gap.
- [ ] Dispatch puts a real row in `spawned_agents` and a visible tagged JOIN
      in the target channel; recall/disconnect produces the QUIT.
- [ ] The owner gets a report built from real CHATHISTORY; wording never
      claims observation during offline periods.
- [ ] Other world players see the creature (correct sprite, owner label);
      plain IRC clients see only JOIN/QUIT/tags — zero message litter.
- [ ] No new XP source. No channel is ever left with an orphaned presence
      (TTL + session-tie both verified in an e2e).
- [ ] `npx tsc --noEmit` clean; full vitest green; deployed per AGENTS.md
      (commit before `miren deploy`; push before restarting agents on boxd;
      both pfp targets together if pfp is touched).

## Open questions for Chad (don't block on these; defaults chosen)

1. Should a familiar be hatchable by did:key guests who grind to L12, or
   require did:plc/did:web like inviting does? **Default: L12 only, any DID** —
   the grind itself is the gate.
2. Species set and whether the owner gets any choice. **Default: fully
   derived, no choice** — consistent with "everything is computed from who you
   are".
3. May the familiar ever speak (e.g. one arrival chirp)? **Default: silent.**

## Effort estimate

Derivation + fixtures ~0.5d · client module + rendering ~1.5d · witness logic
~0.5d · e2e + polish ~1d. **~3.5 days.**
