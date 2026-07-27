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

- [ ] **1. Identity handoff (pfp → world).** A prominent "enter the world as
      this character" CTA that carries `?h=<handle>`; the world pre-fills and
      skips straight to sign-in. Nobody types their handle twice.
- [ ] **2. Landing that sells the right path.** Bluesky first, with what it
      unlocks stated plainly (verifiable runs, referrals, a face that proves
      itself). Guest kept, honestly labelled as look-around.
- [ ] **3. Invite arrival as a moment.** Name the host, show both characters,
      one obvious first action, and tell them what their host gets.
- [ ] **4. First steps checklist.** Five real, verifiable items with live
      progress, shown once in-world, gone when complete. Every item is a thing
      the ledger can confirm — no fake "tutorial complete".
- [ ] **5. "Make mine" CTA** when viewing somebody else's character.
- [ ] **6. Share at the moment of reward** — first completion offers the card.
- [ ] **7. Invite links unfurl** as "X invited you", with the host's card.

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

(appended as I go)
