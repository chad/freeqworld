# FreeqWorld

**A federated chat protocol rendered as a 1992 multiplayer RPG.**

What looks like a retro multiplayer game is a working client for a Freeq-style
protocol: every room is a real channel, every message is an ed25519-signed
durable event, every bot is a first-class identity with cryptographic
provenance, encryption happens in your browser, and the portal at the north
end of Federation Station leads to a second, independently operated server —
which you can cross without changing who you are.

The retro RPG is the demo. The protocol is the world model.

## Run it

```sh
npm install
npm run build        # bundles the client (≈26 KB gzipped)
npm run dev          # starts both towns
# Freeq City  → http://localhost:8787
# Neon Wharf  → http://localhost:8788  (federated peer)
```

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

## Layout

```
shared/src   protocol types · avatar generator · leitmotifs · music state
             signing (ed25519 did:key) · launch world + tilemaps
server/src   town core (pure, tested) · agents · ws/http shell
client/src   canvas renderer · chiptune engine · vault crypto · UI
e2e          Playwright suites: world, vault, federation
```

## Honest limitations

- Bluesky "login" resolves your handle to its DID and derives your avatar
  from it, but does not prove control of the account (no OAuth flow); such
  identities are marked *unverified*. Message signing always uses the local
  device `did:key`.
- The Vault's passphrase is a public demo constant. The mechanics are real —
  PBKDF2-derived AES-GCM key, client-side seal/open, ciphertext-only relay —
  the secrecy is not. Key rotation and per-member sealed key distribution are
  not implemented.
- The server verifies signatures and enforces per-DID rate limits, but there
  is no persistent storage (logs are in-memory) and no admission control.
- Presence privacy: positions are visible to everyone in the room; there is
  no invisible mode yet.

## Non-goals (by design)

No combat, no tokens, no 3D, no voice — and the whole world layer is an
*optional extension*: a conventional client that ignores the world schemas
can join every channel here (the `Chat` mode button is exactly that client).
