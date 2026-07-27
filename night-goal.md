# Night goal: viral onboarding

**Brief (Chad, before sleep):** "viral onboarding. the best in the business."
Working, testable results over perfection. Commit often. Document blockers and
move on.

## What "best in the business" means here

FreeqWorld has a hook almost nothing else has: **your identity already has a
face and a song, derived and provable, before you do anything.** No signup, no
upload, no configuration — type a handle and there you are. Great onboarding
here means getting that moment in front of people fast, then converting it into
one *verifiable* action and one *attributable* invitation.

So the funnel is:

```
see someone's card  →  see YOUR OWN character  →  enter the world
      →  complete one witnessed run  →  share / invite  →  (loop)
```

Every step must (a) show value before asking for anything, (b) make the next
action trivially achievable, (c) make the reward provable and shareable.

## Funnel as it stands (walked live, 2026-07-26 night)

| step | state | leak |
|---|---|---|
| shared link | lands on the *sharer's* character, card + clip + tune | no visible path onward to the world except a footer sentence |
| "see mine" | handle input at the top; instant character + theme | fine, but not obviously the point when you arrive on someone else's |
| → world | none: the world CTA only appears after setting an avatar | **identity is not carried**; the world asks again from scratch |
| world landing | "Enter world" (guest name) listed first; "Sign in with Bluesky" second | guest = did:key = **cannot do face / post / referral runs, cannot be verified**, and the copy never says so |
| first 60s | spawn in #general; help behind `?`; obelisk and quest board are furniture you must find | no first-run guidance; nothing tells you the first thing to do |
| reward | XP lands silently in the ledger | no share prompt at the moment it is earned |
| invite arrival | `?invite=` shows a toast | not a moment; the host is not even named |

## Plan, in priority order

- [x] **1. Identity handoff (pfp → world).** A prominent "enter the world as
      this character" CTA that carries `?h=<handle>`; the world pre-fills and
      skips straight to sign-in. Nobody types their handle twice.
- [x] **2. Landing that sells the right path.** Bluesky first, with what it
      unlocks stated plainly (verifiable runs, referrals, a face that proves
      itself). Guest kept, honestly labelled as look-around.
- [x] **3. Invite arrival as a moment.** Name the host, show both characters,
      one obvious first action, and tell them what their host gets.
- [ ] **4. First steps checklist.** Five real, verifiable items with live
      progress, shown once in-world, gone when complete. Every item is a thing
      the ledger can confirm — no fake "tutorial complete".
- [x] **5. "Make mine" CTA** when viewing somebody else's character.
- [x] **6. Share at the moment of reward** — first completion offers the card.
- [x] **7. Invite links unfurl** as "X invited you", with the host's card.

## Rules I am holding myself to tonight

- No tracking. The spec's privacy stance forbids it and it would be a lie about
  what this is. Funnel health is observable from the **signed completion log**
  (`/api/xp`) — real actions, not pageviews.
- No fake progress. Every checklist item must be verifiable by the same rules as
  everything else; a tutorial that congratulates you for nothing is the opposite
  of this project.
- Nothing may claim something the system hasn't checked (the recurring lesson
  from today: the courier hint, "now playing", "not yet" on the face).
- Working and deployed beats elegant and local. Commit per item.

## Log

**1–3 done.** Handoff (`?h=`), landing rewritten (Bluesky primary, guest behind a
disclosure that says plainly what it cannot do), invite arrival greets you by
name with the host's character drawn from the DID inside the token.

**Bug found doing it — the referral flow was dead on the client side.** The
`?invite=` capture had never landed: an earlier edit anchored on text that only
exists in the ID app, so the replace silently did nothing, and
`redeemPendingInvite` read a localStorage key that nothing ever wrote. My live
"referrals work" test drove the protocol directly (raw TAGMSG) and never opened
the client, so it proved the agent half and missed the user half entirely.
Lesson recorded: **test the user path, not the protocol path.**

Also fixed: the stale-build self-heal in client/src/main.ts reloaded to
`?r=<ts>` and DROPPED the query string, so an invite arriving on a cached build
lost its token. It now preserves the search params.


**4 done — first steps.** Five items, none of which tick because you clicked
something: a real identity, hearing your own theme, a run in the signed ledger,
an avatar whose bytes hash to your DID, and somebody you actually brought in.
Read back from `/api/xp` and `/api/face`, and it retires itself for good when all
five are genuinely true. Two bugs the browser test caught first: it rendered over
the landing overlay and swallowed the "enter world" click, then (once gated) took
20s to appear because the interval was created before entry.

**5, 6, 7 done.** "See mine" when you land on somebody else's card; the card
offered at the moment a first witnessed run lands (once, ever); and `/i/<token>`
unfurls as *"X invited you into FreeqWorld"* with the host's card — verified
through Bluesky's own extractor. A forged token gets a 404, because the witness
signature is checked before anyone's name goes on an unfurl.

**Mobile.** Shared links are opened on phones, so I measured: the checklist was
914px tall on a 664px screen, covering the world. Narrow screens now get the
progress and the next step only, capped at half the viewport.

**One tap instead of an exact phrase.** "say cartographer, quest" is friction,
worse on a phone. The step now carries the sentence and a button sends it into
the room; verified end to end that one tap produces a real sealed envelope.

**Tightened:** an invitation carries your name and unfurls with it, so the
inviter now needs a real identity too (it was showing a raw did:key in the
unfurl title).

## Where the funnel stands, walked live at the end

```
shared card  ->  hears the theme, sees "see mine"            ✓
"see mine"   ->  own character + theme + where they stand     ✓
              ->  "enter the world as this character" CTA     ✓
world        ->  handle carried over, Bluesky is the primary  ✓
              ->  first steps, all five verifiable            ✓
              ->  one tap asks the Cartographer for a run     ✓
reward       ->  card offered the moment the run lands        ✓
invite       ->  unfurls as the host, greets you by name      ✓
```

## Not done / known gaps

- **The OAuth leg of an invited arrival is untested end to end.** Redemption
  needs a real Bluesky sign-in, and I have no spare account. The token survives
  in localStorage and `redeemPendingInvite` fires on `onAuth`; the pieces are
  unit-tested, but nobody has walked it with a real handle. **First thing worth
  trying in the morning.**
- The invite card reuses the host's normal share card. A dedicated "X invites
  you" image would be better.
- No funnel measurement. Deliberate: tracking visitors would contradict the
  privacy stance. Real actions are already visible in the signed ledger.
