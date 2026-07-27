# Working in this repo

Read this before you touch anything. It exists because two agents worked this
tree at the same time and cost a human real hours.

## Deploy coordination

**One deployer at a time, and never from a dirty tree.**

Three separate deploy targets come out of this one repo, and they are not
interchangeable:

| target | what it serves | how |
|---|---|---|
| `world.freeq.at` | the world client + town server (`client/`, `server/`, share routes) | `miren deploy -C freeq` |
| `pfp.freeq.at` | the ID microapp, static nginx vhost | `npx vite build pfp --base=/ --outDir=dist-root` + `rsync -az --delete pfp/dist-root/ root@87.99.152.98:/var/www/pfp/` |
| the NPC agents | `scripts/world-agents.mjs`, on the **boxd VM**, not miren | `boxd exec freeqworld -- 'cd freeqworld && git pull --ff-only'` then `boxd exec freeqworld -- 'sudo systemctl restart freeqworld-agents'` |

Rules, each of which has already been learned the hard way:

1. **Commit before you deploy.** `miren deploy` ships the working tree, so a
   `-dirty` build ships whatever anyone else has half-finished in it. That
   happened, and the human spent an afternoon retesting builds that were not the
   ones under discussion.
2. **Say which build is live.** Paste the commit and the `__build` stamp
   (`window.__build` in the client) when you hand a build over for testing. If
   two agents are deploying, the person testing cannot tell whose build they
   have.
3. **Agents deploy from git, so push first.** The boxd VM pulls; an unpushed
   commit cannot reach the NPCs.
4. **`pfp/` must ship to BOTH targets together.** vite's asset hashes depend on
   the base, so `pfp/dist` (`/id/`) and `pfp/dist-root` (`/`) name different
   bundles, and `/u/<handle>` injects OpenGraph tags into whichever index.html
   matches the requesting host. Deploy one without the other and shared links
   point at a hash that host doesn't have — nginx answers the SPA fallback and
   the module load fails (blank page). See docs/DEPLOYMENT.md.
5. **If more than one agent is in here, use separate git worktrees** (or
   branches with an explicit deploy handoff). `git add -A` in a shared tree
   sweeps someone else's work into your commit; that also happened.

Verify after deploying, don't assume:

```sh
curl -s "https://cardyb.bsky.app/v1/extract?url=https%3A%2F%2Fpfp.freeq.at%2Fu%2Fbsky.app"   # what Bluesky shows
curl -s https://pfp.freeq.at/u/bsky.app | grep -oE 'src="/assets/[^"]*"'                      # must match nginx's
boxd exec freeqworld -- 'tail -n 20 /tmp/agents-svc.log'                                      # NPCs
```

## Things that are frozen

- **`shared/src/avatar.ts`.** Same DID → same face, forever. There is a
  conformance fixture on the sprite hash (`fixtures/avatar-conformance.json`).
  Do not change the 16 traits or `renderSpritePixels`. Progression must be
  additive overlays (badges, auras, familiars), never trait mutation.
- **`shared/src/leitmotif.ts`.** Also fixture-pinned, and it owns the
  `motif-v1` HKDF domain. `music/src/motif.ts` is an *adapter* over it, not a
  second derivation — one identity must not have two official motifs.
- **The two `act` implementations** (`shared/src/act.ts` for the browser,
  `scripts/act.mjs` because the agents run under bare node) are held to the same
  Rust-generated vectors by `shared/src/act.test.ts`. Don't delete one without
  solving the bare-node import problem; that test is what stops them drifting.

- **`server/src/face.ts` becomes frozen the moment anyone wears it.** The
  portrait is verified by hashing its bytes, so changing one pixel changes every
  CID and everybody who verified silently stops verifying. Treat it like
  `shared/src/avatar.ts`. If you must change it, plan to re-verify the world.
  Related: only `Math.sqrt` (and `+ - * /`) are correctly rounded per IEEE-754 —
  `pow`, `hypot`, `sin`, `cos` are not, and one ULP is one wrong byte.

## Bugs that are pinned by tests — read the test before "fixing" the behaviour

- Spawn ranking (`shared/src/liveWorld.test.ts`): the home-channel bonus applies
  only if the channel is visible in LIST **and** populated. Two older tests
  encoding the previous behaviour were deliberately updated.
- Static assets (`server/src/main.test.ts`): anything with a file extension
  404s; only extensionless SPA routes fall back to index.html. `index.html` is
  `no-cache`, `/assets/*` is immutable.
- The stale-cache rescue in `client/index.html` **must stay inline** — it catches
  a failed module load, which is exactly when the bundle can't be relied on.
- Single-use SASL web tokens: skip the broker refresh only for a token minted on
  *this* page load. A stored identity always mints a fresh one
  (`freshWebToken`). And keep the `authError` listener — a silent auth failure
  cost four hours once.
- Courier ledger (`shared/src/quest.test.ts`): a player's nick changes between
  sign-in modes, so a run sealed for one nick completes for another session of
  the same person. The hint must distinguish wrong-room from wrong-phrase.

## House style

Errors that a user will hit must say what happened and what to do. Silent
failure is the recurring theme in every expensive bug above: the auth failure
that showed nothing, the courier refusal that logged nothing, the music that
said "now playing" while making no sound. If you add a failure path, log it and
surface it.

## Shipping the ID app

`node scripts/deploy-pfp.mjs` — never a hand-rolled rsync. It builds both pfp
targets (the `/id/` and root bases produce different asset hashes), refuses to
ship a bundle older than its sources, and verifies the live hash matches.

The trap it closes: `pfp/dist-root/` is a build artifact, so an rsync with no
build in front of it silently ships whatever was there last. The container
serves TypeScript at runtime and therefore gets source changes from
`miren deploy` alone — so an HTTP route can be correct while the browser bundle
is stale, and a server-side check will not notice. **After changing anything in
`pfp/`, `music/src/` or `shared/src/`, verify through a real browser, not just
curl.**
