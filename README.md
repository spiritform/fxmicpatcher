# FX MIC Patcher

A `config.json` patch designer for the Teenage Engineering **EP-2350 FX MIC**.
Build effect chains, wire the handle / shake / LFO into parameters, audition the
result in the browser, and **push** straight to the device over USB — config and
sample wavs together, ejected so the device reloads.

![The patcher: transport and perform on the left, the four-bay rack in the
middle, live config.json on the right](docs/screenshot.jpg)

Double-click **`start.bat`** — it serves the app and opens it. Or:

```
node serve.mjs              # serve + open
node serve.mjs 8080         # different starting port
node serve.mjs --no-open    # no browser
```

The .html files also open standalone by double-clicking them. The only thing
that needs the server is the **microphone** preview source — `getUserMedia`
requires a secure context and `file://` is not one.

`v2.html` is the current build; `index.html` is the earlier single-column one,
kept for comparison.

## Using it

| | |
|---|---|
| **orange rail** | the 4 preset slots (`pos` 0–3) |
| **effect chain** | up to 4 rows, processed top to bottom |
| **parameter toggles** | the small square left of each name. **Off = not written to the file**, so the device keeps its own default. Only turn on what you actually want to set. |
| **BUS** | `main` is serial. `BUS 1` / `BUS 2` are parallel paths fed from the same input and summed — the main path keeps running dry alongside them. |
| **modulation** | `handle`, `shake`, `lfo` each target one `row` + `param`. `trigger` picks the row the white button fires. |
| **checks** | errors block, notes are firmware or doc caveats |

Keyboard: `1`–`4` switch preset, `space` fires the trigger row, `s` shakes.

### On the device

1. Power on, connect USB-C, open the **fx-mic disk**.
2. Put `config.json` and your wavs in the root.
3. **Eject the disk** — that reloads samples and settings (fw 1.0.5+).

If a config stops it booting, hold two buttons during startup to skip the file.
The on-device readme says **green + white**; the web guide says **white + grey**.
Try both.

## Firmware

**Get on 1.1.2 before you spend time on configs.** Its only release note is
*"fix regressions since 1.0.9 parsing user json file"* — every rev from 1.0.9 to
1.1.1 misparses valid JSON, and you will blame your file.

Full version list from TE's downloads page (checked 2026-11-07 — **1.1.2 is
the newest; there is nothing after it**):

| version | date | note |
|---|---|---|
| **1.1.2** | 2026.09.07 | fix regressions since 1.0.9 parsing user json file |
| 1.1.1 | 2026.08.25 | smoother start up click |
| 1.0.8 | 2025.12.05 | flutter in noise floor removed |
| 1.0.7 | 2025.11.25 | reverb click, sample loop glitch, json parsing fixes |
| 1.0.5 | 2025.11.04 | **eject drive now reloads samples and settings** |

1.0.9 and 1.1.0 are no longer listed, but 1.1.2's own note references 1.0.9, so
they existed and were pulled. Note the jump from **1.0.8 straight to 1.1.1**:
if a device is on 1.0.8 it is *below* the 1.0.9 floor, so `duck` and filter `Q`
genuinely will not work — the checks panel's notes are real failures on that
build, not caveats.

Features gated on firmware:

- **1.0.9** — `duck` on samples; new filter and EQ settings (this is where `Q` on
  LOWPASS/HIGHPASS appears).
- **1.0.5** — ejecting the disk reloads samples and settings; before that you
  needed a full power cycle.

## Where the spec came from, and where it disagrees

Three sources, none complete:

- the `readme.pdf` on the device (newest — written at current firmware)
- <https://teenage.engineering/guides/ep-2350> (older — predates 1.0.9)
- the EP-2350 release log

Unresolved conflicts, all surfaced as notes in the tool:

| | on-device readme | web guide |
|---|---|---|
| EQ effect name | `EQUALIZER` | `EQUALISER` |
| LOWPASS / HIGHPASS | has `Q` | `cutoff` only |
| `duck` on samples | documented | absent |
| recovery button combo | green + white | white + grey |

Resolved by the release log: `duck` and filter `Q` are real, added in 1.0.9 —
the web guide is simply older. The EQ spelling is still a coin flip; if an
EQUALIZER row is ignored by the device, try the other spelling.

**Bugs in TE's own example config** (the tool's *load starter* has them fixed):

- `"spring": 0.5` should be `"spring-mix"`. The import path silently corrects it.
- The first preset's LFO targets `row 3` / `param: "echo"`, but row 3 is
  `SAMPLE`, which has no `echo`. It should be row 2 (the DELAY).

## Effects

Once per chain only: `DELAY`, `HARMONY`, `REVERB`, `SSB`.

| effect | parameters (min, max) |
|---|---|
| `BALANCE` | balance 0–1 |
| `DELAY`\* | time 0–1.1 · lowpass-cutoff · highpass-cutoff · wet-level · dry-level · echo · cross-feed · balance (all 0–1) |
| `DIST` | amount 0–40 · highpass-cutoff · lowpass-cutoff · mix (0–1) |
| `EQUALIZER` | cutoff 0–1 · Q 0–1 · gain −1–1 |
| `HARMONY`\* | dry-level 0–1 · pitch 0.5–2 |
| `HIGHPASS` | cutoff 0–1 · Q 0–1 |
| `LOWPASS` | cutoff 0–1 · Q 0–1 |
| `RING` | frequency 0–20000 · mix 0–1 |
| `REVERB`\* | dry-level · wet-level · time · spring-mix · highpass-cutoff (0–1) |
| `SAMPLE` | speed 0–4 · pitch −24–24 · level 0–1 · balance 0–1 |
| `SSB`\* | frequency −20000–20000 |

LFO shapes: `sine`, `square`, `sawtooth`, `random`.
Playmodes: `oneshot`, `hold`, `startstop`.
Samples: wav only, mono or stereo, 8/16/24-bit or 32-bit float, up to 96 kHz,
**~1 MB total** across all four slots.

## The preview is an approximation

It is a Web Audio rig that sounds *like* the chain, not an emulation of the
device. Known divergences:

- `HARMONY` is a two-tap crossfading delay-line shifter; it warbles, and at
  pitch ≈ 1.0 it degrades to a slow chorus rather than passing through clean.
- `SSB` previews as a ring modulator. A real single-sideband frequency shifter
  needs a Hilbert transform, which native Web Audio nodes can't do.
- `REVERB` is a generated impulse response; `spring-mix` blends in a dispersive
  chirp to approximate the "boing".
- `cross-feed` on DELAY is a simplified ping-pong.
- Parameter→Hz/dB curves are guesses. The device's normalized 0–1 ranges are
  documented without units anywhere.

Use it to find a patch. Trust the hardware for how it actually sounds.

## Known issues

Verified end to end against real hardware — push writes `config.json` and your
sample wavs to the disk, ejects, and the device reloads and plays them. These
are the rough edges you should know about first:

- **The eject is unreliable**, at least on the machine this was built on. The
  eject *is* the reload, so a failed one looks exactly like a push that did
  nothing — the files land correctly and the device keeps running its old
  config. The status line says which happened. **If in doubt, unplug and
  replug**; that forces a re-read unconditionally and takes two seconds.
- **Run one tab.** Nothing stops a second tab also capturing the microphone and
  processing it through a different chain, which sounds like effects cutting in
  and out. Both tabs also autosave to the same key, so the last save wins.
- **`MAX_ROWS = 4` is an inference, not documented.** It comes from TE's own
  examples never exceeding four effects. Untested on hardware — if a five-effect
  chain loads, raise the constant.
- **`EQUALIZER` vs `EQUALISER` is unresolved.** TE's web guide spells it with an
  S, the on-device readme without. The tool emits `EQUALIZER` and imports
  either; if the device ignores an EQ row, try the other.
- **Needs firmware 1.1.2.** The version list jumps 1.0.8 straight to 1.1.1, so a
  device on 1.0.8 sits *below* the 1.0.9 floor and `duck` and filter `Q` will
  genuinely fail there.

An effect can also be silenced by its own settings — `mix` at 0 on DIST is a
wet/dry blend, not a level; `highpass-cutoff` near 1 is ~20kHz; `lowpass-cutoff`
near 0 is a 60Hz ceiling that kills whatever the rows above it produced. The
checks panel flags all of these, because a bypassed effect and a broken one look
identical from outside.

## Unofficial

Not affiliated with or endorsed by teenage engineering. The device spec here is
reconciled from three sources that disagree with each other — see the conflict
table above — and `MAX_ROWS = 4` is an inference, not documented. The preview is
an approximation of the chain, not an emulation of the device.

`push` writes to a removable volume and ejects it. It only ever touches a disk
that is FAT, 1MB-ish and either labelled like an fx-mic disk or already carrying
a `config.json`; the filename is fixed, the payload must parse as a patch, and
whatever was on the disk is copied into the project first. The server binds to
**127.0.0.1 only** — it is never reachable from your network.

MIT licensed. See [LICENSE](LICENSE).
