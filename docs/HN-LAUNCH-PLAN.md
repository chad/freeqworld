# FreeqWorld — Hacker News launch plan

Goal: **#1 on Hacker News.** The product already has the thing HN rewards —
a playful surface (a 1992 multiplayer RPG) hiding a serious substrate (a real
federated-chat protocol client). The reveal *is* the upvote. This plan is about
not fumbling it.

Status legend: ☐ todo · ◐ in progress · ☑ done

---

## 0. What's already true (assets we lead with)

- No-signup live demo: guest entry mints an ed25519 `did:key` in-browser.
- Every room is a real IRC channel on `irc.freeq.at`; every message is a signed
  durable event re-verified in the browser (`sig=VERIFIED` in Dev mode).
- Deterministic everything (avatars, leitmotifs, tilemaps) — no image/audio
  assets, ~53 KB gzipped bundle.
- Real agents (Archivist, Cartographer) as SASL-authenticated clients.
- E2EE vault channel; `/api/debug/log` proves ciphertext-only relay.
- Federation between two towns keeping DID + avatar.

## 1. Title & framing

- **Title:** `Show HN: A 1992 multiplayer RPG that's secretly a real federated chat client`
  - "Show HN" is mandatory (live demo, no signup). Concrete, a little
    mysterious, technical payoff implied. No "AI/web3/blockchain".
- **First comment (post it yourself within 60s of submitting):** the "how it's
  real" paragraph — rooms are real channels, identity is a browser-held
  `did:key`, movement rides ephemeral IRCv3 `TAGMSG`s that are never logged,
  the NPCs are real clients, and the `Chat` button is a plain client for the
  same channels. Link `docs/PROTOCOL.md`. This steers the thread toward depth,
  not "cute game".

## 2. The first 90 seconds (this decides everything)

A skeptical reader must hit a "wait, it's *real*?" moment without signing up.

- ☐ **Seed the world before launch.** Empty rooms kill it. Have a handful of
  real humans + the agents parked in the spawn channel and `#lobby` at go-time.
  ("I walked into #lobby and nobody was there" is death on HN.)
- ☐ Guarantee the spawn channel (busiest at connect) is the populated one.
- ☐ First toast points at the two payoffs: press `Dev` (watch the signed
  protocol) and walk to the ghost, say `@cartographer quest` (interactive
  proof — now crowd-safe after the per-user cooldown fix, commit `bf731cf`).

## 3. Reliability / scale hardening — the make-or-break (do before launch)

Ranked by risk:

1. ☐ **`irc.freeq.at` (single Hetzner box) load.** This is the one point of
   failure and it was already dropping connections (agents churned; real
   clients `QUIT :Connection closed`). Load-test a few hundred concurrent WS
   clients doing `LIST` + `CHATHISTORY` + presence before launch. If it
   wobbles under synthetic load, it will fall over on the front page.
2. ☐ **Empty-room / agent-dropout guard.** Agents must stay in the spawn
   channel and `#lobby`. Consider a re-JOIN watchdog and shorter reconnect
   backoff. (Quest issuance itself is now crowd-safe.)
3. ☐ **Bluesky OAuth.** The broker's `return_to`/`ALLOWED_ORIGINS` allowlist is
   compiled in (see DEPLOYMENT.md). Confirm `auth.freeq.at/health` shows a
   commit that includes `freeqworld.boxd.sh`, and sign-in works end-to-end.
   Guest works regardless, so this is secondary — but a broken login *reads* as
   broken.
4. ☐ **Silence the console.** `[e2ee] Init failed: InvalidAccessError` fires on
   every load (vendored SDK `client.js:1238`). The README sells a clean
   console; HN opens devtools. Patch-in-vendor.
5. ☐ **Mobile.** A large share of HN is mobile. Re-verify first-tap + layout
   (`4d90917`) on a real phone.

## 4. Launch mechanics

- ☐ **Timing:** Tue–Thu, ~7:30–8:30am US Eastern. Avoids the overnight void,
  rides the morning ramp.
- ☐ **Do NOT solicit upvotes** (fast flag/ban). Do line up a few friends to
  *genuinely play* so the world is alive and early comments are substantive.
- ☐ **Be in the thread all day.** Answer the deepest technical question first,
  fast and generously. Author presence is worth dozens of votes.
- ☐ **Assets:** a 15–30s screen-capture GIF in the README (walk in → chat →
  Dev → `sig=VERIFIED` → ask cartographer for a quest → deliver it). Clean OG
  image (unfurl already added in `ac60b29`). The GIF is what gets shared
  off-HN.

## 5. Prepared answers (comment-thread ammo)

- "Isn't this just an IRC skin?" → The world layer is a documented,
  independently-implementable protocol extension; conventional clients
  interoperate (the `Chat` button *is* one).
- "Is the crypto real?" → Yes for signing/identity/relay. Be upfront: the Vault
  passphrase is a public demo constant, and Bluesky *handle* login only
  resolves the DID (marked *unverified*) unless OAuth is used. Lead with the
  `Honest limitations` section — HN respects candor.
- "Does it scale?" → have a real answer from the §3.1 load test.

## 6. Growth loop (see docs/PFP-APP-PLAN.md)

`freeqworld.boxd.sh/id` — generate your deterministic FreeqWorld pixel PFP,
set it as your Bluesky avatar, optional post linking back. A Bluesky-native
viral loop that feeds the launch. Ship alongside or just after.

---

## Definition of done for launch

- [ ] Load test passed on `irc.freeq.at`.
- [ ] Spawn channel populated; agents pinned and stable.
- [ ] OAuth verified live; guest verified live; quest loop verified under load.
- [ ] Clean console; mobile pass.
- [ ] README GIF + OG image.
- [ ] First-comment draft written and ready to paste.
