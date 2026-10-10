# Live Diagrammer

An agent that sits inside a Google Meet call and keeps a diagram of the
discussion current while people talk. It lives in the meeting, hears both
sides, and is corrected by the people in the room — not by a prompt box.

**Two-minute demo video:** _link added at submission_

## What it is

An agent listens to a live multi-person meeting and keeps a diagram of the
discussion current, a few seconds behind speech. Participants snapshot or
dismiss; a dismissal teaches it what not to draw. Afterward the timeline is
scrubbable and any state exports as Mermaid.

## Why a meeting and not a chatbox

The input is two channels of live audio: the Meet tab and the local mic.
Nobody types. There is no prompt box. The only correction signal is a person in
the room hitting Snapshot or Dismiss while looking at the board, and a dismiss
goes back into the model's next three calls as a negative example. A chatbot
never gets that signal, because there is no room around it reacting.

## How it works

```
Meet tab ──tab audio──┐
                      ├─► extension ──PCM/WS──► server ──► batcher ──► extractor ──► reducer ──► panel
local mic ────────────┘                                                  (LLM, ops)     (state)
```

| Stage | What | Measured |
| --- | --- | --- |
| Capture | Chrome MV3, tab audio + mic as two channels | 24 kHz, 50 fps both channels |
| Transcription | `gpt-live-transcribe` over the Realtime API, one session per channel, own energy VAD | speech end → final, p50 ≈ 1.5 s on the recorded take |
| Extraction | `gpt-4.1-mini`, strict `json_schema` from the zod contract, ops not Mermaid | p50 ≈ 0.7 s per call, ~75–80% of calls return no ops |
| Reduce + render | reducer rejects unknown ids and duplicate edges; incremental placer | 0 px: a placed node never moves |
| **Speech → pixels** | | **p50 ≈ 2.9 s / p90 ≈ 3.7 s** |

Partial transcripts hold the current batch open while someone is still
talking; only committed finals reach the model. At a pause the batch goes to
the extractor, which returns **operations** against a graph the server holds —
`add_node`, `add_edge`, `rename`, `remove`, `new_diagram` — never Mermaid.
Half-streamed Mermaid is broken syntax, and re-laying out from scratch moves
every node on screen. Ops give stable ids, pinnable positions, and an
append-only log where `state(T) = replay(events ≤ T)`, which is where the
scrubber and the Mermaid export come from.

Dismiss parks whatever was drawn since the last snapshot or quiet stretch onto
a side diagram, and that parked board is attached to the extractor's next three
calls as a negative example: this is what the room just rejected, drawn from
this transcript.

## Quickstart

```sh
git clone https://github.com/cdiddy77/live-diagrammer.git && cd live-diagrammer
npm install
cp .env.example .env            # set OPENAI_API_KEY
npm run build:ext               # builds the side panel into extension/panel/
npm run server                  # extension on :8787, panel on :8791
```

Then load the extension: open `chrome://extensions`, turn on Developer mode,
**Load unpacked**, pick the `extension/` directory, and click **Grant
microphone access** in the tab that opens. Join a Meet and click the extension
icon. The badge shows `REC`, then frames per second across both channels; 100
means both sources are live. The side panel opens beside the tab. Click the
icon again to stop; the session's log and board land in `out/`.

Requires `OPENAI_API_KEY` — https://platform.openai.com/api-keys — for both
transcription and extraction. Without a key you can still replay a recorded
conversation through the pipeline with a fake extractor and watch the panel:

```sh
npm run server -- --events eval/ref/DEMO01/transcript.jsonl --rate 1 --mock
```

The live path is what the video shows.

## What was built during the event

The submission repo was created empty on the day. Its first commit (10:45) is a
bootstrap of pre-event files, and everything brought in is listed below. The
pre-event spikes live in a separate repo; where code here was adapted from one
of them, that is said below.

**Built Saturday:** the server (a Realtime transcription session per channel
with its own energy VAD, the batcher, the pipeline, the WebSocket fan-out),
written on the day on the design of the pre-event transcription and replay
spikes, with some of their code carried over. The MV3 extension (tab and mic
capture, the side panel), adapted from the pre-event capture spike. The panel,
adapted from the pre-event panel spike, which already had the React Flow
canvas, Snapshot, Dismiss, Reset, the scrubber and the Mermaid export; new on
the day are Pause, Reset re-added to this panel, and node sizing. The eval work
that graded the day's takes: `npm run take`, `take_ref.py` (a reference built
from a take's cue lines), the fixes that grading a live take forced on the case
emitter and the matcher, and the other changes to the report card.

**Brought in, as the rules allow:** the extractor prompt and its helpers,
written before the event and unchanged here apart from an import path
(`extractor/prompt.ts`, `provider.ts`, `mermaid.ts`; `provider.ts` is what
requests the strict `json_schema`); the S0 contract module
(`contracts/schema.ts`, `reducer.ts`, `fixtures/`, unchanged), which defines
the append-only log and `state(T) = replay(events ≤ T)`, plus
`contracts/validate.ts`, a rewrite of the S0 fixture check that came in with
the bootstrap; the incremental placer and drift measure (`panel/src/layout.ts`,
`panel/src/drift.ts`); the report card with its deterministic matcher, and the
fidelity rubric (`eval/demo_card.py`, `eval/rubric.py`); the case emitter and
reference parser from the extractor spike, with only import paths and the
reference directory changed on arrival (`eval/cases.ts`, `eval/reference.ts`);
the DEMO01 storyboard reference and its intended board (`eval/ref/DEMO01/`,
`eval/cases/demo01-target.jsonl`); gonogo as a pip dependency; the organizer
starter kit; and the named libraries (`@xyflow/react`, `elkjs`, `zod`, `ws`,
`vite`, `playwright`).

**Not from the day:** the AMI benchmark in Evaluation — the 35 human-annotated
segments, the label tiers, and the judge validation behind that 57% — was run
before the event and is not in this repo. The demo card over the recorded take
is Saturday's.

## Evaluation

We measured instead of eyeballing. A storyboard says what gets said and what
the board should look like after each beat; a recorded take's cue lines re-time
that to what was actually spoken; a deterministic matcher scores the live board
against the intended one on node and edge F1. gonogo, a Python evaluation
harness written before the event, turns per-segment pass/fail into a pass rate
with a 95% interval and refuses a verdict when n is too small. No model grades
the model. On the recorded take the board matched the intended board in **3 of
3 segments** (F1 0.93, 0.91, 0.89) and **6 of 6 storyboard beats** landed — a
rename, an edge redirect, the tangent drawn, a dismiss scoped to that tangent,
and the architecture intact after it. The interval is wide because n is 3, and
the card says so. Separately, gonogo's LLM judge over 35 human-annotated
segments of real meetings (the AMI corpus) scores 57% [41%, 72%]; boards under
about sixteen nodes pass and boards past twenty mostly do not, which is the
next thing to fix.

Every capture becomes test cases with `npm run take -- <who>`; `eval/README.md`
has the three commands from capture to card. The cases accumulate in
`eval/takes/`, so any change to the prompt or the pipeline is graded against
every take so far.

## Team

Charles Parker and James Dominguez · built at AI Tinkerers "Agents,
Everywhere", Seattle, Sep 12 2026
