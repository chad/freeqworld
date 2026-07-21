# FreeqWorld

**A federated chat protocol rendered as a 1992 multiplayer RPG.**

**Live: https://freeqworld.boxd.sh** — walks straight into the real
[irc.freeq.at](https://irc.freeq.at) server.

What looks like a retro multiplayer game is a **real freeq client**: by
default it connects to the production server at `irc.freeq.at` via
`@freeq/sdk`. Every room is a real IRC channel with real people in it; your
identity is a browser-held ed25519 `did:key` authenticated with the server
over SASL ATPROTO-CHALLENGE; your avatar is derived from that DID; spatial
presence rides ephemeral IRCv3 `TAGMSG`s that are relayed but never stored;
members on conventional clients appear as parked pixel characters at
DID-derived spots. The Chat button is an ordinary client for the same
channels.

The retro RPG is the demo. The protocol is the world model.

## Run it

```sh
npm install
npm run build        # bundles the client
npm run dev          # serves the client + two demo towns
# http://localhost:8787          → world client on the REAL irc.freeq.at
# http://localhost:8787/?server=http://localhost:8787
#                                → same client on the local demo town
# http://localhost:8788          (second local town, federated with the first)
```

Two backends, one client:

- **freeq** (default): durable state lives on `irc.freeq.at` — channels,
  history (CHATHISTORY), reactions, membership, native AES-256-GCM channel
  E2EE. Positions go over vendored `+freeq.at/world-pos` client tags.
- **town** (`?server=`): a self-contained local implementation of the same
  ideas (signed events, ephemeral presence, agents with provenance, two-town
  federation) — used by the hermetic e2e suite and the "run your own town"
  story.

**The world is generated from the server, not authored.** On connect the
client issues `LIST` and builds the town from what actually exists: every
real channel becomes a room (real topic as the subtitle, size from real
population, template from the channel's character), the spawn lands in the
busiest gathering channel, the plaza's doors rank by liveliness, and a
directory kiosk lists every channel — click to travel. A room only renders
as encrypted after the client has actually decrypted E2EE payloads there.

**The NPCs are real clients.** `node scripts/world-agents.mjs` runs the
Archivist and Cartographer as freeq clients with persistent `did:key`
identities (SASL-authenticated, registered as agents): they join real
channels, wander via the same ephemeral TAGMSGs the browser sends, and answer
mentions by quoting real CHATHISTORY. Anyone on any IRC client sees them;
the world client sees them walk.

## Test it

```sh
npm test             # 67 unit tests (vitest) — written red→green, TDD
npm run e2e          # 14 end-to-end browser tests (Playwright)
```

The e2e suite drives real Chromium against both live towns: two browsers
chatting in one room, portal travel that keeps your DID, vault messages that
never reach the server as plaintext, agent mentions answered with signed
provenance-carrying events.

## What to try in five minutes

1. **Identity** — enter as a guest. An ed25519 keypair is minted in your
   browser and encoded as a `did:key`. Your pixel avatar is derived from that
   DID by HKDF-SHA256 → seeded PRNG → 16 traits. Same DID, same face,
   everywhere, forever. (Or link a Bluesky handle: your avatar derives from
   your real AT Protocol DID.)
2. **The protocol is real** — press the `Dev` button. Every message you see
   arrives as a signed event and is verified again in your browser
   (`sig=VERIFIED`). Fetch `/api/debug/log/%23lobby` to read the durable
   store with curl — that's the same channel the game renders.
3. **Agents have parents** — say `@archivist what do you keep here?` in the
   plaza, then click the ghost's name: the provenance card shows its
   `agent_chain` from the town operator's DID to its own. Its replies are
   signed events like everyone else's.
4. **The locked room is not just visual** — walk south to the Library, then
   down into the Vault (`#private-demo`). Send a message, then open
   `/api/debug/log/%23private-demo`: the server stores an AES-GCM envelope.
   The plaintext never left the browsers.
5. **Cross the border** — walk north to Federation Station and step through
   the portal. You arrive in Neon Wharf — a separate server process with its
   own operator, agents, and channel logs — with the same DID and the same
   avatar. Messages in `#federation` relay between the towns with signatures
   and origin intact.

## Architecture

```
┌───────────────────────────────────────────────────────┐
│  FreeqWorld UI    canvas map · avatars · chat · audio │
├───────────────────────────────────────────────────────┤
│  World projection  channels→rooms · events→actions    │
│                    DIDs→pixel art · state→music       │
├───────────────────────────────────────────────────────┤
│  Browser SDK       identity (did:key) · signing       │
│                    E2EE (AES-GCM) · presence          │
├───────────────────────────────────────────────────────┤
│  Transport         WebSocket (JSON frames)            │
├───────────────────────────────────────────────────────┤
│  Town server ×2    durable channel logs · membership  │
│                    agents · moderation · federation   │
└───────────────────────────────────────────────────────┘
```

**Durable vs. ephemeral** (the load-bearing distinction): messages, reactions
and structured actions are signed, stored, and replayed as history. Movement
(`freeq.at/presence/world-position/v1`) is ephemeral — rate-limited,
last-write-wins by `(client_instance, sequence)`, expiring at `expires_at`,
and *never* written to the durable log. `/api/debug/presence/#lobby` vs
`/api/debug/log/#lobby` shows the split live.

**Deterministic everything**: avatars (HKDF salt `freeq-world-avatar`),
personal 3–5-note leitmotifs (salt `freeq-world-motif`), agent keys, room
tilemaps — all derived, none stored. The music is synthesized in Web Audio
from a shared `music-state` (energy/tension/density/brightness + topic
family) computed from room activity; no audio assets exist.

## Protocol

The world layer is a set of documented, independently implementable
extensions — deterministic avatars, ephemeral world-pos TAGMSGs, signed
touch autographs, generated towns: see **[docs/PROTOCOL.md](docs/PROTOCOL.md)**.
Conformance fixtures live in [`fixtures/`](fixtures/) and are enforced by the
test suite.

## Numbers

- client bundle ≈ 53 KB gzipped (includes the freeq SDK); no image or audio assets — sprites and music are synthesized
- first meaningful render well under a second on a warm cache; world generation adds one LIST round-trip
- 320×180 internal render target, integer-ish scaled; 60 FPS canvas loop
- presence: ≤3 position beacons/s while moving, expiring after 8s, never stored
- 100+ unit tests, 15 Playwright end-to-end tests (several run against the live production server)

## Layout

```
shared/src   protocol types · avatar generator · leitmotifs · music state
             signing (ed25519 did:key) · launch world + tilemaps
server/src   town core (pure, tested) · agents · ws/http shell
client/src   canvas renderer · chiptune engine · vault crypto · UI
e2e          Playwright suites: world, vault, federation
```

## Honest limitations

- On the freeq backend your `did:key` is authenticated for real (SASL
  method=crypto), but Bluesky *handle* login only resolves the handle to its
  DID for avatar derivation — it does not prove account control (no OAuth
  flow); such identities are marked *unverified*.
- The Vault's passphrase is a public demo constant. The mechanics are real —
  client-side AES-GCM (the SDK's channel E2EE on freeq; PBKDF2+WebCrypto on
  the local town), ciphertext-only relay — the secrecy is not.
- The local town server verifies signatures and enforces per-DID rate
  limits, but has no persistent storage (logs are in-memory) and no
  admission control.
- Presence privacy: positions are visible to everyone in the room; there is
  no invisible mode yet.
- The agent NPCs (Archivist, Packet, …) inhabit the local towns. On
  irc.freeq.at, members with a server-attested agent actor class are marked
  as agents; the launch NPCs are not deployed there.

## Non-goals (by design)

No combat, no tokens, no 3D, no voice — and the whole world layer is an
*optional extension*: a conventional client that ignores the world schemas
can join every channel here (the `Chat` mode button is exactly that client).
