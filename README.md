# MusicBoyColor

A web app that rips the soundtrack out of a Game Boy / Game Boy Color ROM (`.gb`, `.gbc`) or a
`.gbs` file and gives it back as lossless, tagged tracks in a ZIP.

Everything runs in the browser: the file is never uploaded. No build step, no dependencies.

```sh
npm start        # serves the folder at http://localhost:8080 (any static server works)
npm test         # node --test, needs Node 20+
```

## What you get

- FLAC (or WAV) at 44.1 / 48 / 96 kHz, 16 or 24-bit, rendered with band-limited synthesis
  (no aliasing) straight from an emulated sound chip — not a recording.
- Or the music as data instead of audio:
  - **VGM** — the exact, timed log of what the game writes to the sound chip, with loop point and
    GD3 tags. This is the raw form of the music; VGM players turn it back into sound.
  - **MIDI** — an interpretation of that log as notes (Pulse 1, Pulse 2, Wave as instrument tracks,
    Noise as drums), with pitch bends, panning and `loopStart` / `loopEnd` markers. Pitches, timing
    and volumes survive; Game Boy timbres do not.
- One file per song, `NN - Title.flac` inside `Album (Year)/`, plus an `.m3u8` playlist.
- Tags: title, artist, album, track number/total, date, genre, and `LOOPSTART` / `LOOPLENGTH`
  (in samples) for looping songs.
- Loops are detected exactly; looping songs are rendered intro + N loops + fade-out.
- Album and artist are pre-filled from the cartridge header (title, publisher) or the GBS header.
  Cartridges do not contain song names, so tracks start as `Track 01…` and can be renamed (and
  previewed) before downloading.
- English and Spanish interface.

## How it finds the songs

A cartridge has no standard music format; every game ships its own sound driver. Rather than
knowing drivers, MusicBoyColor watches the game run (`src/rip/scan.js`):

1. Boot the ROM in the built-in emulator, tracing the call stack of every write to a sound
   register. The outermost routine that only does sound work and covers those writes is the
   driver's *play* routine.
2. Record which RAM that routine reads — the driver's state — and find game code outside the
   driver that writes into it. That is how the game says "play song N": a function taking the id
   in a register, or a request variable the driver polls.
3. Prove it by replaying from a snapshot with other ids and checking that different, sustained,
   mostly-looping music comes out. Then try all 256 ids and keep the distinct songs.
4. From then on only the play routine is run (no game logic), so playback is deterministic and a
   loop is simply the moment the driver's state repeats.

`.gbs` files skip all that: their header says where INIT and PLAY are.

## Limitations

- Song discovery is heuristic. It is tested on synthetic ROMs covering both selection styles and
  on open-source homebrew, **not yet on a broad set of commercial games**. When it cannot find a
  song selector it falls back to capturing the music the game plays at start-up, and says so.
- Engines that select songs by data pointer instead of by number (common in homebrew: GBT Player,
  hUGEDriver) or that need two arguments (song + bank) are not enumerated; use a `.gbs` for those.
- The VGM writer follows the 1.71 spec and is structurally tested, but has not been checked in an
  external VGM player yet.
- Ids past the end of a game's song table can produce garbage "tracks"; preview and untick them.
- The emulator passes Blargg's `cpu_instrs`, `instr_timing` and `dmg_sound` 01–08 and 11. It has
  no video output and does not emulate a few wave-RAM access quirks (inaudible).

## Layout

```
index.html, style.css     UI
src/main.js, i18n.js      UI logic and strings
src/worker.js             emulation/encoding off the main thread
src/core/                 CPU, APU, band-limited synthesis, memory/mappers/timing
src/rip/                  driver discovery, loop analysis, rendering, GBS, export
src/enc/                  FLAC, WAV, MIDI, VGM, ZIP, MD5 writers
src/meta/                 cartridge header parsing
test/                     synthetic ROM builder and tests
```

MusicBoyColor neither includes nor distributes ROMs. Use it with dumps of games you own.
