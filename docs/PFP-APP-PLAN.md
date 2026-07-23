# FreeqWorld PFP — "become your FreeqWorld self on Bluesky"

A single-purpose microapp: type your Bluesky handle → see the deterministic
pixel character FreeqWorld derives from your identity → one tap sets it as your
Bluesky avatar, with an optional post about it. A Bluesky-native growth loop
that also *demonstrates the core idea* (your identity → your face, derived not
uploaded) in 15 seconds.

## Where it lives: `freeqworld.boxd.sh/id` (not `pfp.freeq.at` — yet)

**Recommendation: ship at `freeqworld.boxd.sh/id`.** The auth broker's
`return_to`/`ALLOWED_ORIGINS` allowlist is **compiled into the Rust broker**
(DEPLOYMENT.md). `freeqworld.boxd.sh` is *already allowlisted*, so `/id` needs
**zero broker changes**. A new `pfp.freeq.at` origin would require a broker
code change + redeploy on the Hetzner box before OAuth would work at all — a
cross-repo deploy and an easy way to lose an afternoon. Add `pfp.freeq.at`
later as a vanity domain (CNAME → same origin + broker allowlist entry) once
the app is proven.

## The pitch / why it works

- **Deterministic identity → face.** Same DID, same character, forever. The PFP
  is literally the same sprite you walk around as in FreeqWorld. That *is* the
  protocol thesis, made shareable.
- **Viral on Bluesky.** People love a fun, unique, on-brand pixel avatar. The
  optional post ("I'm now my FreeqWorld self ✦ freeqworld.boxd.sh") links back.
- **Cross-promo both ways.** Success screen CTA: "walk into FreeqWorld as this
  character." PFP feeds the main app; the main app's Bluesky users find PFP.

---

## What we reuse (no new generation logic)

- `shared/src/avatar.ts` → `deriveAvatar(did)` + `renderSpritePixels(av, facing, frame)`
  (DID → HKDF-SHA256 → seeded PRNG → 16 traits → 16×24 palette-indexed sprite).
- `shared/src/hkdf.ts`, `shared/src/leitmotif.ts` (optional: play their motif).
- `client/src/identity.ts` → `resolveBlueskyHandle`, `startOAuth`,
  `consumeOAuthReturn`, `OAuthSession` (already returns `did`, `handle`,
  `pds_url`, `web_token`, `broker_token`, `broker_url`).

The **only new code** is: (1) compose the sprite into a square, profile-worthy
PNG; (2) the AT Proto write calls (uploadBlob + putRecord + optional post).

---

## User flow

1. **Land** (`/id`): input a Bluesky handle, or "surprise me" (random `did:key`).
2. **Reveal** (no login): resolve handle → `did:plc` via the public AppView
   (`resolveBlueskyHandle`), `deriveAvatar(did)`, render the square PFP preview
   immediately. Show a couple of framings (portrait crop + full-body-on-scene)
   and maybe a "▶ hear your leitmotif" button. This is the shareable aha and it
   needs **no auth**.
3. **Set it** → "Set as my Bluesky avatar". Triggers connect (see auth options).
4. **Write**: uploadBlob(png) → getRecord(profile) → putRecord(profile w/ new
   avatar, preserving displayName/description/banner).
5. **Optional post** (checkbox, default on): createRecord `app.bsky.feed.post`
   with text + `app.bsky.embed.images` (the PFP) + a link facet to FreeqWorld.
6. **Success**: link to their profile + "enter FreeqWorld as this character".

---

## Rendering the PFP image (the one genuinely new visual)

Target: **1024×1024 PNG** (Bluesky avatars are square, shown as a circle; keep
content inside the inscribed circle; PNG < 1 MB — trivial here).

- Reuse `renderSpritePixels(avatar, 'south', 0)` → the 16×24 indexed sprite.
- **Backdrop = on-brand pixel scene** derived from the same avatar palette:
  floor + wall + a `glow` tile row + subtle checker, echoing the game's room
  templates. Use `accent_palette` for a vignette/ring so every PFP feels part
  of one set but is unmistakably theirs. (Palettes already exist in the client
  room templates — factor the palette table into `shared/` so both use it.)
- Compose: nearest-neighbor upscale the sprite (integer scale), center it in the
  circle-safe area, draw a thin signature line (`✦ freeqworld` + short handle)
  low and quiet.
- Two variants selectable: **Portrait** (head+shoulders crop, big) and
  **Explorer** (full body on scene). Portrait usually reads best as a circle.
- Export: `canvas.toBlob(..., 'image/png')` → `Uint8Array` for uploadBlob.
- Determinism note in UI copy: "This isn't uploaded art — it's *derived* from
  your DID. Same identity, same face, everywhere."

---

## Auth + write path — the one real dependency (spike first)

AT Proto OAuth issues **DPoP-bound** access tokens. A pure browser app cannot
replay them against the PDS without the DPoP private key, which the broker
holds. So there are two viable paths; we build the app against a thin
`BskyWriter` interface and pick the implementation after a 1-hour spike.

### Path A (preferred): broker XRPC proxy

If `auth.freeq.at` exposes an authenticated XRPC proxy (browser presents
`web_token`/`broker_token`; broker attaches DPoP + forwards to the user's PDS),
then:

```
POST auth.freeq.at/xrpc/com.atproto.repo.uploadBlob      (image/png body)
GET  auth.freeq.at/xrpc/com.atproto.repo.getRecord?...   (existing profile)
POST auth.freeq.at/xrpc/com.atproto.repo.putRecord       (profile w/ avatar)
POST auth.freeq.at/xrpc/com.atproto.repo.createRecord    (optional post)
   Authorization: Bearer <web_token>
```

- **Spike:** confirm (a) the proxy exists, (b) the OAuth scope granted at
  sign-in includes write (transitional `transition:generic` does), (c) it
  allows `uploadBlob`/`putRecord`/`createRecord` for the session's own repo.
- If the proxy exists but scope is read-only → broker change: request write
  scope + allow those methods (cross-repo deploy per DEPLOYMENT.md).

### Path B (guaranteed fallback): app password

100% client-side, no broker changes, works today:

```
POST {pds}/xrpc/com.atproto.server.createSession   { identifier, password: <app-password> }
  → { accessJwt }   // plain Bearer, no DPoP
POST {pds}/xrpc/com.atproto.repo.uploadBlob         Authorization: Bearer accessJwt
GET  {pds}/xrpc/com.atproto.repo.getRecord
POST {pds}/xrpc/com.atproto.repo.putRecord
POST {pds}/xrpc/com.atproto.repo.createRecord
```

- UX: "Create an app password (Bluesky → Settings → App Passwords), paste it."
  Slightly more friction, but reliable and fully static. Never stored; used
  once in-memory.

**Ship plan:** implement Path B first (guarantees a working demo tomorrow),
wire Path A behind the same `BskyWriter` if the spike says the proxy is ready.
Offer OAuth as the headline button, app-password as "advanced / no-OAuth".

### The actual profile write (both paths)

```
record = getRecord(repo=did, collection='app.bsky.actor.profile', rkey='self')
         // 404 → start from { $type:'app.bsky.actor.profile' }
blob    = uploadBlob(pngBytes, 'image/png').blob
putRecord(repo=did, collection='app.bsky.actor.profile', rkey='self',
          record={ ...existing, $type:'app.bsky.actor.profile', avatar: blob })
```

Preserve `displayName`, `description`, `banner`, `labels`, `pinnedPost` — only
swap `avatar`. (A naive put that drops them would wipe the user's bio.)

### Optional post

```
createRecord(collection='app.bsky.feed.post', record={
  $type:'app.bsky.feed.post', createdAt:new Date().toISOString(),
  text:'I became my FreeqWorld self ✦ freeqworld.boxd.sh',
  embed:{ $type:'app.bsky.embed.images', images:[{ image: blob, alt:'my FreeqWorld pixel character' }] },
  facets:[ link facet over "freeqworld.boxd.sh" → https://freeqworld.boxd.sh ],
})
```

Re-upload the blob for the post (blobs are per-record) or reuse the ref if the
PDS allows within the session.

---

## Build / serve / deploy

- New source dir `pfp/` (or `client-id/`) with its own tiny `vite` build →
  `pfp/dist`. Imports `shared/src/avatar.ts` etc. directly (same monorepo).
- Serve at `/id` from the existing town server: add a static route in
  `server/src/main.ts` mapping `/id` and `/id/*` → `pfp/dist` (keeps ONE origin
  → no broker allowlist change; one deploy).
- OAuth `return_to` = `https://freeqworld.boxd.sh/id`; `consumeOAuthReturn`
  already parses `#oauth=`.
- Deploy: same as the client —
  `boxd exec freeqworld -- 'cd freeqworld && git pull && npx vite build pfp'`
  then (server route change) restart `freeqworld`.
- Keep it dependency-light; the pixel PNG is tiny; no server-side rendering.

## Tests

- Unit: PNG composition is deterministic for a fixed DID (hash the bytes, like
  `spriteHash`); handle→DID resolve mocked; `BskyWriter` mocked for the
  put/post sequence (preserves existing profile fields).
- E2E (Playwright): land `/id`, enter a handle, assert a non-blank canvas +
  correct derived traits; mock the PDS/broker for the write path and assert the
  putRecord payload swaps only `avatar`.

## Milestones

1. ☑ **Spike:** `auth.freeq.at` exposes `/health` only — **no XRPC proxy**
   (`/xrpc/*` → 404). Path A (OAuth write proxy) would need cross-repo broker
   changes. Path B (app password) has open CORS on the entryway *and* on real
   PDS hosts (`*.host.bsky.network`). **Decision: ship Path B now.**
2. ☑ Reveal app at `/id`: handle (or `surprise me`) → derived PFP (explorer
   default + portrait), trait card, PNG download. No auth. Live.
3. ☑ `BskyWriter` (`pfp/src/atproto.ts`, Path B app-password) → resolve
   handle→DID→PDS, createSession, uploadBlob, read-merge-write profile
   (avatar swapped, other fields preserved).
4. ☑ Optional post with image embed + UTF-8-correct link facet.
5. ☑ Success screen + cross-promo CTA into FreeqWorld.
6. ☑ Tests (8 unit + headless end-to-end with mocked AT Proto); deploy at `/id`.
7. ☐ Path A (OAuth one-tap) behind the same interface — needs a broker XRPC
   proxy (cross-repo). Do when the broker grows one.
8. ☐ `pfp.freeq.at` vanity domain (CNAME + broker allowlist entry).

### Shipped auth note
App password is used **once, in memory, never stored**; the connect modal is
explicit that it is not the account's main password. The avatar is re-derived
from the *authenticated* DID after login, so it is genuinely the user's
identity-face (surprise-me identities can't be pushed to an account they don't
own).

## Risks

- **Broker write scope** (mitigated by Path B fallback).
- **Wiping profile fields** on putRecord (mitigated: read-merge-write).
- **CORS** on direct PDS calls in Path B (PDS XRPC is generally CORS-open;
  verify against the common PDSes; if not, Path A/proxy required).
- Allowlist: only an issue if we jump to `pfp.freeq.at` early — don't.
