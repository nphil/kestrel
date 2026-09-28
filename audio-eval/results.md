# Kestrel audio bake-off: which bird-sound model, and what settings

**Bottom line: use Google Perch v2 at a 0.50 confidence threshold in BirdNET-Go.** It's the
best of the two models you can actually run today, catches noticeably more real birds than
BirdNET v2.4, and never once cried wolf on 25 minutes of your own camera audio with no bird in
it. Don't run any audio "cleanup" filter before classification — none of the four I tried
reliably helps, and the one that helps most (Google's MixIT) is far too slow to run live.

There's also a newer model, **BirdNET+ V3.0**, still in "developer preview," that scored
meaningfully better than both — especially on quiet/distant calls, which is exactly the case
that matters for an exterior camera. It's now installable from inside BirdNET-Go's own model
gallery if you want to try it, but its own maker doesn't call it production-ready yet, so it's
a "try it and see" recommendation, not the default.

## The numbers behind that

Tested on 483 real bird-call recordings (35 species you actually get locally, from
iNaturalist) mixed at three loudness levels into 25 clips of real ambient audio recorded from
your own Front Door and Back Door cameras, plus those 25 ambient clips alone (no bird at all,
to check for false alarms). "Loud/medium/faint" = the call is 10 dB louder / equal / 10 dB
quieter than the background hiss and traffic noise.

| Model | Loud | Medium | Faint | Catches faint calls¹ | False alarms on quiet background² | Speed³ |
|---|---|---|---|---|---|---|
| BirdNET v2.4 | 52.8% | 36.6% | 11.2% | 6.2% | 0 / 25 | 3.5 |
| **Perch v2** | **59.0%** | **49.7%** | **32.3%** | **9.9%** | 0 / 25 | 10.4 |
| Both agree (v2.4 + Perch) | 44.7% | 30.4% | 9.9% | 4.3% | 0 / 25 | — |
| BirdNET+ V3.0 (preview) | 65.2% | 57.1% | 44.7% | 19.9% | 0 / 25 | 15.8–20.4 |

¹ Of the 161 *faint*-level clips, the % where the model's top guess at ≥0.50 confidence was
the right species. ² Out of 25 pure-ambience clips with zero bird, how many got a false
detection at the 0.80 (strictest) threshold — same result (0) at every threshold tested.
³ CPU-seconds needed to process one minute of audio; all four ran CPU-only, no GPU.

Perch v2 beats BirdNET v2.4 at every loudness level, roughly triples the faint-call catch
rate, and costs about 3x the CPU time — still very cheap (10 CPU-seconds per minute of audio
processed). "Both agree" is stricter and worth knowing about but isn't a separate model you'd
run day to day; it just means fewer false alarms at the cost of missing more real birds.

### Confidence threshold: 0.50

| Threshold | Right when it speaks up⁴ | Flags at least one bird on⁵ | False alarms |
|---|---|---|---|
| **0.50 (recommended)** | 67.4% | 35.6% of clips | 0 |
| 0.70 | 72.5% | 22.6% of clips | 0 |
| 0.80 | 72.5% | 14.3% of clips | 0 |

⁴ When Perch v2 names a species at or above this confidence, how often it's actually right.
⁵ Share of the 483 bird clips where it said *something* at or above this confidence.

Raising the threshold barely improves accuracy (67→72%) but throws away a third of your real
detections, and false alarms on pure background stayed at zero at every threshold tested — so
there's no downside to keeping it low. **0.50 is the setting to put in BirdNET-Go.**

### About BirdNET+ V3.0

This is the newest model from the BirdNET team, not yet an official release — still called
"developer preview" by its own maker, with BirdNET v2.4 as BirdNET-Go's default. It beat both
tested models on every measure here, most notably on faint calls (44.7% vs. Perch's 32.3%,
and double Perch's faint-catch rate). It's also the slowest and heaviest to run (needs
PyTorch, not the lightweight engine the other two use). BirdNET-Go added an installable V3.0
option to its own model gallery only about a month ago. If you want the best possible
detection and don't mind it still being labeled "preview," it's worth trying; if you want the
safe, fast, proven option, stick with Perch v2 at 0.50.

## Should you clean up the audio before classifying it?

Short answer: **no, don't** — for the live pipeline. Tried four ways to strip noise from a
bird call before feeding it to the classifier, on 60 test clips (20 different bird
recordings, all three loudness levels, drawn evenly from the same 483-clip set):

- **Google's MixIT** — an AI model made specifically for pulling apart mixed sounds; picks the
  best of 4 separated tracks by asking the classifier which one it's most confident about.
- **noisereduce** — a general "clean up background hiss" tool.
- **ffmpeg filter** — a simple built-in noise filter.
- **MixIT then noisereduce** — both combined.

None of them reliably make the *recording* cleaner (measured against the exact original bird
call before it was mixed with your camera's ambient noise):

| Method | Loud | Medium | Faint | Speed (10-sec clip) |
|---|---|---|---|---|
| MixIT | −12.9 dB (worse) | −7.1 dB (worse) | −3.0 dB (worse) | 37 seconds |
| noisereduce | −7.8 dB (worse) | −0.1 dB (about even) | **+5.0 dB (better)** | 0.09 sec |
| ffmpeg filter | −56.0 dB (much worse) | −47.8 dB (much worse) | −39.4 dB (much worse) | 0.11 sec |
| MixIT + noisereduce | −15.7 dB (worse) | −8.7 dB (worse) | −1.2 dB (worse) | 37 seconds |

(Negative = the "cleaned" version sounds *less* like the original bird call than the noisy
original did — these tools can just as easily distort a call as clean it, especially when it
was already fairly audible. **The ffmpeg filter actively wrecks the recording at every
loudness level — don't use it for anything.**)

What actually matters more than raw sound quality is whether the *classifier's confidence*
for the real species holds up after cleanup:

| Method | Confidence held or improved (loud) | (medium) | (faint) | Overall |
|---|---|---|---|---|
| **MixIT** | 50% | 65% | **75%** | **63%** |
| ffmpeg filter | 45% | 55% | 60% | 53% |
| MixIT + noisereduce | 35% | 45% | 55% | 45% |
| noisereduce | 40% | 35% | 55% | 43% |

MixIT is the one method that's actually good at this — three out of four times on the
quietest calls, it keeps or boosts the classifier's confidence in the true species, because
it's specifically choosing the track the classifier likes best. **But it costs 37 CPU-seconds
per 10-second clip** — about 370x slower than real time. That's fine for reprocessing one
saved clip you're curious about by hand later; it's not something to run automatically on
every camera event.

**Recommendation:** feed the classifier raw audio, no filtering — matches how the model
numbers above were actually measured. If a particular saved recording seems like it should
have a bird in it but didn't get flagged, MixIT is worth trying on that one clip by hand
(`cleanup_prepare.py`/`cleanup_classify.py` in this folder do that), but it's not worth
building into the live pipeline.

**One more check, and it came back clean:** looked for whether cleanup could make an actual
*voice* worse (more audible) — checked the 15 real ambient camera clips used in this test and
found zero contained detectable speech to begin with (they're filtered out before ever
reaching a test clip; see Methodology). So there's nothing to report there beyond "your
camera audio going into this test had no voices in it."

**Listen for yourself:** `audio-eval/examples/` has 15 short WAV files — one real hummingbird
recording at all three loudness levels, each with the original ("00-before") next to all four
cleanup attempts, so you can hear what "worse SI-SNR" actually sounds like.

## Methodology, briefly

- **Bird calls:** 161 real recordings across 35 locally-seen species (from iNaturalist,
  research-grade only), each mixed at loud/medium/faint into your own camera's ambient audio
  → 483 test clips, each 10 seconds.
- **Ambient audio:** 60-second clips captured live from your Front Door and Back Door
  cameras' microphones, split into 10-second pieces, and run through voice-detection (WebRTC
  VAD) so nothing with a detected voice ever made it into a test clip.
- **Every model ran CPU-only** in a disposable Docker container on Unraid that self-deletes
  when done — nothing was left installed anywhere.
- **The cleanup comparison** used a smaller, evenly-spread sample of 60 of those 483 clips
  (20 different bird recordings × all 3 loudness levels) because Google's MixIT model alone
  takes about 37 CPU-seconds per clip; the full 483 would have taken hours for one extra
  comparison. Every number in the cleanup section — signal quality, confidence, and speed —
  uses this same 60-clip sample, so they're all comparable to each other.
- Full numbers behind every table: `audio-eval/data/results/score-summary.json` (models) and
  `audio-eval/data/results/cleanup-summary.json` (cleanup comparison).

## One real problem found and fixed along the way

The `birda` command-line tool (used to run BirdNET v2.4/Perch v2 here) hung forever the first
time it was run for real — not a timeout, an actual indefinite hang, 0% CPU, confirmed even
running it directly on the Unraid box with no Docker involved at all. Root cause: the
particular build of the tool loads its ONNX math library separately at startup, and that
loading path never finishes on this machine. The fix was switching to the tool's other,
self-contained build (which bundles its own matching copy of that library) — confirmed
working, and it's what every run in this report actually used. Full detail is in a comment in
`get_birda.py`, in case a future update to that tool needs the same fix re-checked.

## Cleanup done

- Verified on Unraid: no leftover containers from this work (`docker ps -a`, checked after
  every run finished — all `--rm`, all gone).
- The raw ambient recordings captured from your cameras for this test (60-second clips from
  Front Door and Back Door) have been deleted from this machine.
