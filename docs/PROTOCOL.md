# FreeqWorld protocol extensions

FreeqWorld adds a *world layer* on top of a standard freeq (IRC + AT Protocol
identity) server without any server-side changes. Everything below rides
existing protocol machinery — IRCv3 client tags, CHATHISTORY, SASL, NAMES —
and is safely invisible to clients that don't opt in. A conventional client
in the same channel sees ordinary messages and members; a world client sees
a place.

This document is the interoperability contract: an independent client that
implements it will see the same world, the same faces, and the same motifs.

## 1. Identity

Users are ed25519 `did:key`s, generated and held in the browser, and
authenticated with the server via SASL `ATPROTO-CHALLENGE` `method=crypto`
(sign the raw challenge bytes; base64url the signature). A linked AT Protocol
identity (e.g. a Bluesky `did:plc`) may *anchor the avatar* without being the
signing identity; such linkage is display-only until proven.

## 2. Deterministic avatars (`avatar-v1`)

The avatar is a pure function of the DID. No server stores appearance.

```
canonical_seed = HKDF-SHA256(
  ikm  = UTF8(did),
  salt = UTF8("freeq-world-avatar"),
  info = UTF8("avatar-v1"),
  len  = 32 bytes)
```

A [sfc32 PRNG](https://pracrand.sourceforge.net/) is seeded with the first 16
bytes of `canonical_seed` (four uint32, little-endian) and drawn once per
trait, in this exact order:

`body_silhouette, head_shape, skin_palette, hair_shape, hair_palette,
eye_pixels, shirt_jacket, pants_skirt, shoes, accessory, idle_movement,
walk_cadence, speech_sound, accent_palette, arrival_effect`

Each draw selects `options[floor(r * len)]` from the trait tables in
[`shared/src/avatar.ts`](../shared/src/avatar.ts). The sprite is a 16×24
palette-indexed raster with four facings; `sprite_hash` is SHA-256 over the
four facings' pixels + palette strings.

**Conformance:** [`fixtures/avatar-conformance.json`](../fixtures/avatar-conformance.json)
pins DIDs to expected seeds, traits, sprite hashes, and leitmotifs.
`shared/src/conformance.test.ts` enforces them. Regenerate (only on a
deliberate generator version bump) with `npx vite-node scripts/gen-fixtures.mjs`.

## 3. Personal leitmotifs (`motif-v1`)

```
motif_seed = HKDF-SHA256(ikm=UTF8(did), salt=UTF8("freeq-world-motif"), info=UTF8("motif-v1"))
```

Same PRNG construction. Draws: note count (3–5), root (midi 60–71), then
per-note interval moves from `[2,3,4,5,7,-2,-3,-4,-5]` clamped to midi 48–96,
then a rhythmic cell matching the note count, then an instrument from
`[pulse, triangle, fmbell, square25]`.

## 4. Spatial presence — `+freeq.at/world-pos`

Position is **ephemeral**: it rides a TAGMSG client tag, is relayed only to
clients that negotiated `message-tags`, and never enters CHATHISTORY.

```
TAGMSG #channel
  +freeq.at/world-pos = "<x>,<y>,<facing>,<animation>,<sequence>"
```

- `x`, `y`: tile coordinates, two decimals
- `facing`: `north|south|east|west`
- `animation`: `idle|walk|react`
- `sequence`: monotonically increasing per client; receivers apply
  last-write-wins and expire entries after ~8s of silence
- Send rate: ≤ ~3/s while moving. Be polite; it's a shared server.

Members who never send positions are rendered "parked" at a deterministic
DID-derived walkable spot (collision-aware, sorted-DID order) so the room
shows the whole real roster.

## 5. Touch autographs — `+freeq.at/world-touch`

First contact between two players exchanges *signed autographs*:

```
TAGMSG #channel
  +freeq.at/world-touch = "<toNick>,<ts>,<sig>"

sig = base58btc(ed25519_sign(canonical_json({
        kind: "world-touch", from: <senderDid>, to: <targetDid>, ts: <ts> })))
```

`canonical_json` sorts object keys recursively. The receiver verifies with
the sender's did:key and reciprocates once (cooldown ≥15s per pair). A
verified autograph is a portable, checkable proof two identities met.
Clients witnessing *both* directions of an exchange between two other nearby
players may credit themselves an introduction.

## 6. The world itself

The town is generated, not authored: `LIST` (plus the user's own
`CHATHISTORY TARGETS` for channels LIST hides) feeds a deterministic
generator ([`shared/src/liveWorld.ts`](../shared/src/liveWorld.ts)) — spawn
in the busiest gathering channel, portal arches ranked by live population,
same-template channels linked into districts, development/test debris
filtered by pattern. Channel policy gates (`POLICY <chan> RULES/ACCEPT`) are
surfaced as in-world entry gates.

## 7. What's deliberately NOT protocol

Sparks, stamps, stars, and the journal are client-local records *about*
protocol events (autographs received, channels genuinely joined, agent-
verified courier deliveries). Rooms' tile art, music, critters, and worn
paths are pure renderer — two clients may skin the same channel differently,
and that's the point.
