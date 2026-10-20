# Local source analysis

`window.cascade.analysis` implements `AnalysisBridge` in `src/shared/analysis.ts`.
All returned times are **integer source flicks** (705,600,000 per second), including ranged runs.
Map source times through a clip's source-in and speed before editing the timeline.
Nothing here changes the document or creates captions.

```ts
const bridge = window.cascade.analysis
await bridge.installModels(['speech', 'events', 'tone'])
const result = await bridge.run(path, {
  range: { start: 600 * 705600000, end: 900 * 705600000 },
  language: 'en',
  parts: ['speech', 'events', 'tone', 'shots']
})
```

`status()` lists usable parts and missing models. Defaults run installed parts; requesting
tone also requests speech because sentences are its input. Downloads run only on explicit
`installModels`, except the existing transcription service's automatic Whisper downloads.
Linux x64 is supported. `tar` is required for installation; ffmpeg is required for decoding.
`cancel()` aborts downloads, kills active ffmpeg/Whisper children, and terminates the inference
worker. There is one analysis job at a time; the shared caption service also rejects competing
Whisper jobs. An inference call may finish its current native operation before worker termination.

## Outputs and precision

- **Speech:** existing whisper.cpp Large v3 Turbo Q8 + Silero VAD + DTW, including its bounded
  alignment/GPU fallback. A filler-rich initial prompt requests verbatim words, with a separate
  transcript cache key. Prompting cannot guarantee preservation of disfluencies. Filled pauses
  (`um`, `uh`, `erm`, `er`, `hmm`, `mm`, `ah`, including elongated variants) receive `filler: true`;
  discourse markers such as “like” stay unflagged. Token confidence is the minimum per word.
- **Sentences:** punctuation, pauses over 0.6 s, and bounded utterance length determine half-open
  word index ranges. `rate` is words per second across the sentence span, including fillers.
- **Loudness:** ffmpeg mono 16 kHz Float32 PCM supplies each word's RMS. `speechDb` is the median
  of finite, nonzero word RMS levels in dBFS; `word.db` is relative to it. This is a reference for
  the **analyzed range**, not a separately computed full-file median. It is not perceptual LUFS,
  pitch, emphasis detection, or evidence of emotion. Silent words omit `db`.
- **Silences:** the same PCM decode runs silencedetect at -35 dBFS for at least 0.18 s, clamped to
  the requested range. Quiet speech may be classified as silence; background music may hide pauses.
- **Events:** CED-Mini int8 AudioTagging uses 2 s windows at a 1 s hop. Curated AudioSet labels map
  to cues (music, applause, laughter, cheering, crowd, footsteps, door, phone, dog, cough, sigh,
  gunshots, explosion, siren, crying, alarms, glass, weather, vehicles, sneezes). Speech and singing
  are excluded. Per-class entry thresholds are 0.35–0.65, exit thresholds 60% of entry; ranges
  separated by at most one hop merge. `score` is the peak window score, not calibrated probability.
  `underSpeech` means unioned word spans cover more than half of the event. Without successful
  speech analysis this flag is false because speech overlap is unknown. Window boundaries have
  approximately 1–2 s uncertainty and must not be treated as sample-accurate editing boundaries.
- **Tone:** SenseVoiceSmall reads each sentence plus 150 ms context. Neutral hard labels receive
  confidence 0.5. A non-neutral label must agree with a second decode of the unpadded sentence;
  it then receives confidence 0.65. These numbers express a conservative policy, **not model
  posteriors or calibrated probabilities**. Disagreement, unknown labels, and sentences shorter
  than 0.7 s omit tone. Tone is an acoustic model label, not a claim about intent or actual feelings.
  The SenseVoice event label is not promoted into a precisely timed event.
- **Shots:** CPU-only ffmpeg decodes every frame, scales to width 320, and selects scene score
  >0.30. Cuts within 150 ms collapse. This targets conspicuous hard cuts; fades, animated slides,
  and similar-looking camera changes can be missed. A rapid motion/lighting change can false-trigger.
- **Speakers:** not implemented (stretch scope). An explicit request records a part error.

`parts` contains only completed parts. `errors` reports failed parts without erasing speech or
other successes. Progress events include source path, part, phase, and a fraction. `timings` are
wall-clock milliseconds per part, including required extraction and model startup. Parts run
sequentially; no model remains loaded after its part finishes.

PCM is written to a temporary disk file and read in windows of at most 31 s (about 1.98 MB).
This avoids hour-long JS PCM arrays and lets all audio parts use the same decoded samples.
The disk file costs roughly 64 KB per second of source audio; it is removed on success/failure/
cancellation. Whisper retains its existing on-disk WAV extraction and native memory use.
Sherpa uses CPU execution with four threads. Shots use four decode threads and one filter thread.

Caches are under `<userData>/cache/analysis`, keyed by analysis version, absolute path, mtime,
size, range, requested language, and normalized part set. Successful runs return from cache;
partial failures are saved for `cached(path)` inspection but retried by the next `run`.
`cached` filters stale source identities and never computes. Models and thresholds require an
analysis version bump when their output semantics change.

## Model provenance, checksums, and licenses

Runtime: npm `sherpa-onnx-node@1.13.8`, checked against npm on 2026-10-20, with its locked Linux
x64 prebuilt package. Both runtime and sherpa-onnx conversion code use Apache-2.0.
No upstream Python training implementation is included.

| Part | Download | Archive bytes | Installed required bytes |
| --- | --- | ---: | ---: |
| Speech | Existing Whisper Large v3 Turbo Q8 + Silero v6.2 | See `src/main/transcribe.ts` | 874,188,075 + 885,098 |
| Events | [CED-Mini 2024-04-19 release](https://github.com/k2-fsa/sherpa-onnx/releases/tag/audio-tagging-models) | 47,658,399 | 10,451,715 ONNX + 14,675 labels |
| Tone | [SenseVoiceSmall int8 2024-07-17 release](https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models) | 163,002,883 | 239,233,841 ONNX + 315,894 tokens |

The CED archive includes an unused float model and test WAVs; installation extracts only the
int8 model and class labels. Both archives stay in the model directory for reuse. Downloads
stream to `.partial`, resume with HTTP Range validation, and verify size and SHA-256 before
rename/extraction. Installation writes a `NOTICE.txt` beside each model. Status checks expected
installed file sizes; it does not rehash hundreds of megabytes on every status request.

Archive SHA-256:

```text
CED-Mini: bec8bfa0af2c20ec3a9e7c6dd6c92d0fb6e96d6b25370ebe7a48e7283a60a02c
SenseVoiceSmall: 7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e
```

CED was hashed after downloading the official release; that older release asset does not expose
a GitHub digest. SenseVoice's hash also matches the GitHub release asset's published SHA-256.
The manifest pins these exact archives rather than following a mutable model name.

**CED-Mini attribution:** CED-Mini by Xiaomi Corporation / Heinrich Dinkel et al.;
[original weights model card](https://huggingface.co/mispeech/ced-mini) declares Apache-2.0.
The [training repository](https://github.com/RicherMans/CED) is GPL-3.0; that code is not used or
redistributed here. AudioSet ontology/class labels are by Google, [CC BY 4.0](https://research.google.com/audioset/).
Retain weight authorship and license notices when redistributing models.

**SenseVoiceSmall attribution:** “SenseVoiceSmall by FunASR/FunAudioLLM, Alibaba Group;
ONNX conversion by k2-fsa/sherpa-onnx.” Retain that source/author information and model name,
and link the [model card](https://huggingface.co/FunAudioLLM/SenseVoiceSmall) and
[FunASR Model Open Source License Agreement v1.1](https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE).
Section 2 grants use/copy/modification/sharing and requires attribution. Section 3 says the
models are provided for reference/learning and disclaims responsibility. An earlier maintainer
comment interpreted this as permitting commercial use with attribution, but
[issue #334](https://github.com/QwenAudio/SenseVoice/issues/334) was reopened and explicitly says
that comment is **not final license-owner confirmation**. As checked on 2026-10-20, the issue
remains open. Commercial-use certainty therefore remains a release/legal review item; do not
represent these weights as Apache-2.0 or unconditionally cleared for commercial redistribution.

## Verification on this machine

Measured results and spot-checks are recorded below after running the real Electron IPC bridge.
Hardware: AMD Ryzen 5 7600 (6 cores / 12 logical CPUs), 32 GB RAM, Linux x64.
Whisper verification uses `CASCADE_WHISPER_CPU=1` so the Electron test instance is the only
GPU job. No full-file benchmark is required or run. Test ranges never exceed five minutes.

The cold built-app run on `~/wwdc.webm`, **600–900 s**, completed speech/events/tone/shots
without errors: 924 words, 73 sentences, 10 MUSIC ranges, 31 cuts, no filler flags.
Median word speech loudness was -23.62 dBFS.

| Part | Wall seconds | Wall / 300 s (RTF) | Realtime throughput |
| --- | ---: | ---: | ---: |
| speech | 169.418 | 0.5647 | 1.77× |
| events | 1.236 | 0.0041 | 242.72× |
| tone | 5.448 | 0.0182 | 55.07× |
| shots | 5.971 | 0.0199 | 50.24× |

Total part time was 182.073 s (1.65× realtime throughput), excluding model installation.
The packaged `dist/linux-unpacked/cascade` repeated the same five-minute analysis via its
**real preload IPC**, with a warm Whisper transcript but recomputed PCM/events/tone/shots:
0.383 / 1.190 / 5.566 / 5.732 s respectively. All four completed, with identical counts and
no errors; `status()` reported all four available and `cached(path)` returned the result.
Native sherpa `.node` and dependent `.so` files were present under `app.asar.unpacked`.
`bunx electron-builder --linux dir` succeeded. An initial-phase event job cancelled in 4 ms; cancellation after 10% of active event
inference completed rejected the job in 9 ms, without caching the cancelled result.

Validation commands passed: `bun run typecheck`, `bun run test` (130 tests, 15 files),
`bun run build`. No network/model loads occur in the tests. The native build was exercised
with the isolated `.profile` / `.projects` directories. Every test Electron process was closed.

### Accuracy spot-checks and gaps

- **Fillers:** a fresh, identical-range 600–630 s comparison through the packaged app returned
  95 baseline words versus 97 verbatim-prompt words. Both had **0 um/uh and 0 other filler flags**.
  The five-minute prompt run also had zero fillers. This scripted sample does not demonstrate
  improved disfluency recall; prompt support is implemented, but filler retention remains
  unproven on real hesitations. No filler was inserted merely to meet a count target.
- **Tone:** **0/73 non-neutral emitted, 0/73 any tone emitted**. A direct raw SenseVoice check at
  635–640 s returned `<|EMO_UNKNOWN|>` with event `<|Speech|>` and plausible recognized words.
  Unknown labels are deliberately omitted. This English example provides no evidence of useful
  emotion coverage or non-neutral accuracy; no tone was invented from sentence wording.
- **Shots:** a contact sheet of the six detected 600–630 s cuts showed alternating presenter,
  phone-only, and presenter views at 602.001, 606.039, 612.345, 615.181, 622.722, 627.627 s.
  These are visible hard view changes. Comparing scene thresholds 0.15 and 0.30 on that range
  found the same six (scores 0.805–1.0), supporting the more conservative 0.30 setting. This
  is a precision spot-check, not an exhaustive recall audit of all 31 cuts.
- **Events:** MUSIC at 608–610, 621–624, 626–629, 632–640, 643–660, 662–680,
  682–684, 713–726, 730–760, 872–874 s; scores 0.408–0.672, all under speech.
  No applause/crowd/laughter was detected in this range. A separate 0–30 s intro check found
  MUSIC spanning the decoded audio (0–29.979 s), peak 0.836; this is stronger than the beds.
  Five-second ebur128/astats checks at 645/735/800/872 s found -22.0/-23.1/-22.2/-21.9 LUFS
  and approximately -26 dBFS RMS. Stereo side-channel RMS was -50.7/-48.3/-69.7/-54.5 dBFS:
  positive windows have more non-mono energy than the 800 s negative control. This is
  consistent with a quiet stereo bed but **does not prove music**; weak ranges remain
  unconfirmed and may be speech/room/codec false positives. No claim of verified event recall.
- Speaker diarization remains unimplemented. No full-file benchmark was run. Commercial
  distribution of SenseVoice needs the license clarification described above.

### Compact real IPC result excerpt

All times below are source flicks. Words/sentences are excerpts (their indices refer to the
full 924-word result); the event and shot arrays are complete. Tone/filler fields are absent
because no labels were emitted, rather than fabricated neutral/false values.

```json
{"version":1,"range":{"start":423360000000,"end":635040000000},"language":"en","parts":["speech","events","tone","shots"],"speechDb":-23.621456961963244,
"words":[{"text":"Choose","start":423430560000,"end":423642240000,"p":0.136425,"db":0},{"text":"one","start":423642240000,"end":423791680435,"p":0.996578,"db":-5.3},{"text":"that","start":423825696000,"end":424065600000,"p":0.997107,"db":0.1}],
"sentences":[{"start":423430560000,"end":424683279418,"words":[0,7],"text":"Choose one that best fits your needs.","rate":3.9427823413846053},{"start":425101288147,"end":426893674435,"words":[7,16],"text":"Let's take a look at them in iOS 14.","rate":3.5429862650232455}],
"events":[
{"cue":"MUSIC","label":"Music","score":0.4081419110298157,"start":429004800000,"end":430416000000,"underSpeech":true},
{"cue":"MUSIC","label":"Music","score":0.4098738729953766,"start":438177600000,"end":440294400000,"underSpeech":true},
{"cue":"MUSIC","label":"Music","score":0.45654764771461487,"start":441705600000,"end":443822400000,"underSpeech":true},
{"cue":"MUSIC","label":"Music","score":0.615391731262207,"start":445939200000,"end":451584000000,"underSpeech":true},
{"cue":"MUSIC","label":"Music","score":0.6403611898422241,"start":453700800000,"end":465696000000,"underSpeech":true},
{"cue":"MUSIC","label":"Music","score":0.6716859340667725,"start":467107200000,"end":479808000000,"underSpeech":true},
{"cue":"MUSIC","label":"Music","score":0.5012349486351013,"start":481219200000,"end":482630400000,"underSpeech":true},
{"cue":"MUSIC","label":"Music","score":0.5812528729438782,"start":503092800000,"end":512265600000,"underSpeech":true},
{"cue":"MUSIC","label":"Music","score":0.6708420515060425,"start":515088000000,"end":536256000000,"underSpeech":true},
{"cue":"MUSIC","label":"Music","score":0.43962663412094116,"start":615283200000,"end":616694400000,"underSpeech":true}
],
"shots":[424771905600,427621118400,432070632000,434071713600,439392643200,442853611200,481464748800,485325792000,491706532800,496862352000,499451904000,503831563200,538604942400,547457400000,550471017600,552519374400,554543740800,558781574400,563514033600,569141193600,579570667200,584044171200,592660958400,597605097600,606928190400,609235502400,611024904000,613284940800,624162470400,626327956800,633438288000]}
```

Full local verification artifacts (ignored, not committed): `.scratch/analysis-600-900.json`,
`.scratch/packaged-600-900.json`, `.scratch/baseline-600-630.json`,
`.scratch/verbatim-600-630.json`, `.scratch/events-intro.json`, `.scratch/cuts.png`, and
`.scratch/packaged-check.log`. The first JSON preserves cold timing; the packaged one uses
warm transcription. Reproduction hooks are `.scratch/ipc-steps.mjs`,
`.scratch/packaged-check.mjs`, and `.scratch/compare.mjs`.
