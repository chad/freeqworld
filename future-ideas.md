# Future ideas — making FreeqWorld a buzz-generator for freeq

> Written 2026-07-27, after the onboarding + visual-legibility passes. The trust
> spine (signed ledger, verifiable quests, derived identity) is done; what's
> missing are the loops that turn "neat demo" into "place people return to and
> drag friends into". Ranked by leverage. Every idea here respects the house
> rule: **a mechanic is only allowed if the protocol can verify it**, and the
> anti-goal at the bottom is load-bearing.

## 1. Duets — viral by construction (highest leverage, build first)

Everything shareable today is about **one person**; nobody's card mentions
anybody else. But `music/src/mint.ts` derives a theme from a DID — it can derive
a **duet from two DIDs**: your motif and theirs in counterpoint, key reconciled,
deterministic. `/duo/alice.com/bob.com` → card + WAV + clip of both characters
performing it.

Why it's different in kind from every other share: a duet share names two
people, and the other person *wasn't the sharer*. That's a Bluesky notification,
a "wait, we have a song?", and their followers seeing it. Referral asks a
favor; a duet is a **gift**. Zero new trust machinery (pure computation), reuses
the whole pipeline (mint → wav → clip → OG unfurl). ~2 days.

Implementation sketch: order-independent (sort DIDs before seeding so
`/duo/a/b` = `/duo/b/a`), reconcile keys via circle-of-fifths distance, A plays
melody over B's bassline for 8 bars then swap, both leitmotifs quoted in the
outro. Card shows both characters facing each other on the stage.

## 2. Appointment time — solve the dead-mall problem

The #1 death of every small virtual world: visitor arrives, room is empty,
leaves forever, tells nobody. With a small population you cannot fix this with
features — you fix it with **concentration in time**. Thirty people spread over
a week is a ghost town; thirty people at the same hour is a *scene*, and scenes
get screenshotted.

Concrete: a weekly listening party (say Friday, fixed hour) where the room's
engine weaves the attendees' leitmotifs together live — the music engine already
composes; this is a scheduling problem, not a music problem. Everyone present
gets a witnessed `attended` event in the ledger (the Cartographer is in the
room; presence during the event window is verifiable by it). The event is
announced by the chronicle account (idea 3) with who attended last week.

## 3. The world should post — a chronicle account on Bluesky

The signed event log is a newspaper nobody prints. Give the town its own
Bluesky account that posts a weekly chronicle *computed from the ledger*:
level-ups, first verified faces, couriers run, who brought someone in —
**tagging the people involved**. Each mention is a return-trigger for a player
and an impression for their followers. Every claim in the post is verifiable
against the public event log, which *is* the freeq pitch — marketing that
writes itself, honestly, forever.

Guardrails: only ledger-derived claims; opt-out respected; never post about
guests (did:key holders never asked to be public).

## 4. Familiars — the platform demo disguised as a pet

**Detailed plan: [docs/FAMILIARS-PLAN.md](docs/FAMILIARS-PLAN.md)** — written
for handoff to a sub-agent, protocol facts verified against the freeq server
source.

One line: at L12 (already promised in the shipped ladder — "dispatch a familiar
— a real spawned agent") you hatch a small creature derived from your DID that
is a *real* spawned agent (`AGENT SPAWN`, `spawned_agents` table, capability
grants), visible to every IRC client in the room you dispatch it to. People
love pets beyond all reason, but the buzz angle is better: "my pet is a real
agent with scoped capabilities on a federated IRC network" is a freeq platform
demo people will explain to each other unprompted.

## 5. Passport travel — federation is the moat, make it a story

The ⇗ doors to remote servers exist, but travel is a checkpoint dialog, not an
event. Make it ceremonial: a passport (derived, of course), a stamp per town —
witnessed by *that town's* agent, so the ledger shows **cross-server
attestations**. "I took the train to another server and got my passport
stamped" is the single most freeq-native sentence a player can say. Nobody else
can copy this feature; the moat should be the postcard.

Depends on: an agent presence on at least one other server willing to witness
arrivals. Start with a second town we run ourselves.

## 6. Marks on the world

People return to places where something is *theirs*. The gallery wall exists;
extend: a statue in the plaza for ladder leaders (recomputed weekly from the
ledger — losing your statue is also a return trigger), a placed object at high
level, name on a courier plaque in the room where the run landed. Cheap to
render, expensive to stop thinking about.

## 7. Solidity (unglamorous, do alongside everything above)

- **Mobile controls.** The checklist now fits on a phone but movement is still
  keyboard-shaped. Tap-to-walk or a d-pad is table stakes before any viral
  push — shared links open on phones.
- **Reconnect grace.** Any wobble that drops you to the landing page during a
  first session is a funnel leak worse than any missing feature.
- **The OAuth leg of an invited arrival is still untested end-to-end** (needs a
  real second Bluesky account). Fix before pushing referrals hard — it's the
  exact path new users take.
- **MST/CAR proof for the post quest** — currently trusts the player's chosen
  PDS to serve honestly; the one honest gap in tier 1. ~half a day.
- **Level-up fanfare** — own leitmotif transposed over a ducked bed; reuses the
  music engine. ~half a day. (Pairs with idea 2: fanfares during a party are
  communal moments.)
- **Server-side reaper** for empty/memberless/stale channels — 12 shells
  reappear via client auto-join; the e2e suite still litters.

## Anti-goals (load-bearing)

No streaks, no daily-login rewards, no engagement nudges, no tracking. The
world's whole identity is "nothing here is fake, nothing farms you" — one
hollow mechanic poisons that, and it's exactly the thing that makes the
chronicle account credible rather than cringe. No XP for talking, ever
(chatter must never earn points or real channels become grind farms).

## Recommended order

duets → chronicle account → weekly event (those three form one machine: the
event generates ledger entries → the chronicle posts them → duets spread them)
→ mobile controls → familiars → passport travel.
