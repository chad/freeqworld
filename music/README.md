# freeqworld/music — chiptune generator

Deterministic, dependency-free chiptune engine for FreeqWorld.

```
Theme ──compose()──▶ Score ──renderScore()──▶ Audio ──▶ .wav  (Node, offline)
                                                   └──▶ AudioBuffer (browser)
DID   ──mintChiptune()──▶ Theme                                  ← phase 2
```

No audio assets, no sample packs, no streaming. A room theme is ~30 lines of
JSON; the whole engine + demo page builds to **23 kB** (9.5 kB gzipped). Same
code path in Node and the browser, so the `.wav` you audition offline is
sample-identical to what a visitor hears.

---

## Phase 1 — can we make nice, simple, video-game-appropriate music?

Yes. All six launch-room themes from the vision doc (§11.7) are implemented:

```bash
node bin/chiptune.ts list
node bin/chiptune.ts all              # renders out/*.wav
node bin/chiptune.ts render plaza --play
afplay out/plaza.wav
```

| theme | BPM | brief (§11.7) |
|---|---|---|
| `plaza` | 108 | bright suspended harmony, pulse lead, walking triangle bass |
| `workshop` | 92 | mechanical percussion, minor-modal ostinato, **5/4 insert every 8 bars** |
| `laboratory` | 118 | FM bell fragments, polyrhythmic arpeggios |
| `library` | 72 | sparse descending figures, long rests, soft noise texture |
| `club` | 126 | angular free-jazz interplay over a stable cycle |
| `vault` | 64 | low pulse, narrow pitch range |

Interactive pages:

```bash
npx vite
#   /index.html   the six room themes + live piano-roll
#   /studio.html  type a Bluesky handle -> mint that person's tune
```

### Why it sounds like game music and not like noodling

The generator is opinionated. Four rules do most of the work:

1. **Form before notes.** Melodies are built as two-bar phrases arranged into an
   eight-bar `A A B A′` period. Repetition is what makes a tune a tune; `A′` is
   `A` with a varied tail so the period answers itself.
2. **Contours, not random walks.** Each phrase gets a shape (`arch`, `rise`,
   `fall`, `wave`, `hook`, `plateau`) with an amplitude, centred so it swings
   both ways. Off-beats add small neighbour motion on top.
3. **Strong beats are chord tones.** Beat-aligned notes snap to the nearest tone
   of the current chord *in scale-degree space*, so when phrase `A` repeats over
   a different chord it re-snaps and sounds deliberate rather than wrong.
4. **A hardware budget.** One lead (pulse 1), one harmony (pulse 2), one bass
   (triangle), drums (noise + kick). Channels are strictly monophonic — later
   notes cut earlier ones, exactly like a 2A03. Registers are octave-folded into
   fixed lanes (bass A1–E3, harmony below the tonic, lead above) so nothing ever
   turns to mud.

Plus arrangement: intro → full → break → last-chorus octave lift, drum fills on
the eighth bar, and a seamless loop (the ring-out tail is folded back into the
head, so the file loops with no seam and no click).

### The synth

`src/synth.ts` is a small software 2A03:

- **pulse** with 12.5 / 25 / 50 % duty, PWM sequences, and PolyBLEP
  anti-aliasing (the charm of squares, without the fizz at 44.1 kHz)
- **triangle** quantised to 16 steps, like the real chip
- **noise** from a 15-bit LFSR with the short (metallic) and long (hiss) taps
- **FM bell** for the Agent Laboratory
- 60 Hz envelope/arpeggio/duty tables — the classic chip "chord on one channel"
- master chain: DC block, gentle low-pass, soft clip, peak normalise

## The studio page

`studio.html` is the listening/feedback tool. Type a Bluesky handle (or paste a
raw DID), and it resolves the handle through the public AppView, mints the
tune, plays it with a scrolling playhead over the piano roll, and shows the
reveal card. Tunes stack up in a table so you can click between them and A/B
instantly (rendered buffers are cached), rate them ★ / · / ✗, leave a note, and
hit **copy feedback** for a markdown digest to paste into a chat. Ratings
survive a reload; the WAV button exports whatever's playing.

The profile picture and display name are cosmetic only — traits come from the
DID alone (spec §8.4), so renaming yourself never changes your music.

## Phase 2 — mint a unique chiptune per DID

Same idea as the PFP project, same derivation family (it literally shares
`fimp/shared/src/hkdf.ts` with the avatar generator). Nothing is uploaded;
everything is a pure function of the identity.

```text
motif_seed = HKDF(DID, salt="freeq-world-motif",    info="motif-v1")     # §11.5
tune_seed  = HKDF(DID, salt="freeq-world-chiptune", info="chiptune-v1")
```

> **One motif per identity.** `src/motif.ts` is an *adapter over*
> `shared/src/leitmotif.ts` — the canonical derivation pinned by the public
> conformance fixtures (spec §31). It occupies the same HKDF domain, so reading
> that seed our own way would have given every DID two rival "official" motifs.
> The stinger plays the canonical MIDI notes literally; the minted tune snaps
> the same contour into its own key.

```bash
node bin/chiptune.ts mint did:plc:z72i7hdynmk6r22z27h6tvur --play

  ┌─────────────────────────────────────────
  │ key          D# lydian
  │ tempo        92 BPM
  │ mood         wondering
  │ progression  market
  │ motif        4 notes, fall
  │ voice        fm bell
  │ bass         held low notes
  │ harmony      falling arpeggio
  │ percussion   broken beat
  └─────────────────────────────────────────
```

The **leitmotif** (spec §11.5) is the 3–5 note calling card: fixed interval
contour, fixed rhythmic cell, one instrument. It plays as an arrival stinger…

```bash
node bin/chiptune.ts stinger did:plc:…
```

…and it is also planted at the head of the minted tune's melody, so a person's
stinger and their full track are audibly the same character — the way their PFP
and their walking sprite are the same face.

The minted card mirrors the PFP reveal card: `key`, `tempo`, `mood`,
`progression`, `motif`, `voice`, `bass`, `harmony`, `percussion`.

### How unique is it, really?

Measured over 20,000 synthetic DIDs:

| | result |
|---|---|
| identical melodies (actual note data) | **0** |
| identical reveal cards | 4 pairs in 20,000 |
| same arrangement, different motif | 1.8%, never more than two people |

The note data is unique *by construction*: each DID gets a distinct 64-bit
compose seed that drives every phrase contour, rhythm cell, ornament and fill,
so two people cannot share a melody without a SHA-256 collision. The
descriptive card draws on ~10^8 curated combinations.

One deliberate trade: trait picks are **tempo-weighted** (fast tempos favour
breaks and stabs, slow tempos favour pads and held bass) rather than fully
independent. Independent picks give marginally more entropy but produce tunes
that sound assembled — a 160 BPM sustained pad, a 72 BPM breakbeat. Musical
coherence is worth more than the last few bits, especially when the melody
already guarantees uniqueness.

## Where it's used

**`pfp.freeq.at`** (`pfp/src/theme.ts`) — the FreeqWorld ID reveal plays your
minted theme next to your face. Adds ~22 kB gzipped and no network calls.

From anywhere else in the repo:

```ts
import { ChiptunePlayer } from '../../music/src/web.ts'
import { PLAZA } from '../../music/src/themes.ts'
import { mintStinger } from '../../music/src/mint.ts'

const music = new ChiptunePlayer()
music.play(PLAZA)                              // crossfades, loops forever
music.oneShotScore(await mintStinger(did))     // someone just walked in
```

## Layout

```
src/theory.ts       scales, chords, degrees, MIDI ↔ Hz
src/score.ts        Score/Note IR, tick grid, channel monophony
src/instruments.ts  patch definitions
src/synth.ts        software 2A03 → Float32 stereo
src/compose.ts      Theme → Score (the musical opinions live here)
src/themes.ts       the six launch rooms
src/motif.ts        DID → leitmotif      (§11.5)
src/mint.ts         DID → whole tune + reveal card
src/web.ts          Web Audio playback
src/wav.ts          16-bit WAV encoder
bin/chiptune.ts     CLI
web/demo.ts         demo page
```

`npx vitest run` — 28 tests covering theory, determinism, phrase repetition,
the odd-meter insert, channel monophony, loudness/clip-free rendering, seamless
looping, WAV headers, and per-DID minting.

## In the world (`src/room.ts`)

The room owns the music; identity enters it as a **quote**. Twenty people in a
room can't each play their own tune — that's not a soundtrack, it's a crowd of
ringtones. So:

| you hear | when |
|---|---|
| **your theme, in full** | arriving in the world (4 bars, then it hands over), and on pfp.freeq.at |
| **your own motif** | when you're alone in a room — your motif becomes the melody, and the room's own lead ducks under it |
| **someone else's motif** | they arrive (quiet, on the bar, budgeted) · you open their card (louder — you asked) · they @mention you (their motif *is* the notification, so you know who wants you without reading) |
| **nobody's motif** | on every chat line. That's the speech blip — tinted by their leitmotif's first note and instrument, but never the motif itself (§30.5: "avoid constant reaction sounds") |

How it stays musical rather than becoming a doorbell:

- **Four stems, one render.** The bed is composed once and rendered as
  base / rhythm / lead / texture buffers played in sync (§11.3's layers). The
  server's `MusicState` moves their gains, so the room breathes with activity
  without ever re-rendering or losing the loop point. Drums fade in with energy;
  an empty room has no backbeat.
- **Quotes land on the bar line**, computed from the bed's own audio clock —
  deliberate actions (mention, inspect) answer on the next *beat* so they feel
  connected to the click.
- **Quotes are re-keyed** into the room's scale and register, contour preserved,
  and the lead stem ducks under them.
- **A budget** (`MotifBudget`): 45 s per-person cooldown, a 2.5 s global gap, and
  no arrival quotes at all in a room of more than eight. Deliberate actions
  bypass the crowd rule, because silence in response to a click reads as a bug.
- Separate **music / motifs / effects** levels, persisted (§26).

All fourteen `RoomTemplate`s the live world can classify a channel into resolve
to an authored cue (`themeForCue`), and anything new still gets deterministic
music derived from its cue name rather than silence.

## Next

- Topic tint: `shared/src/music.ts` already classifies conversation into a
  topic family; the bed could shift mode/brightness with it (§11.4).
- Agent layer (§11.3 layer 4): motifs for active bots, distinct from people.
- Event stingers for federation and encryption changes (§11.3 layer 6).
- Transition/stinger scheduling so room changes land on a bar line.
- Publish minted themes as a `freeq.at/profile/chiptune/v1` record and quote a
  joining user's motif inside the room cue (§11.3, §11.5).
- User music packs: a Theme is just JSON.
