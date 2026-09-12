# <Project name>

<One sentence. What it does, and where it does it. Name the environment — the
rubric rewards an agent that could not be a chatbox.>

**[Two-minute demo video](<url>)**

## What it is

An agent listens to a live multi-person meeting and keeps a diagram of the
discussion current, about two seconds behind speech. Participants snapshot or
dismiss; a dismissal teaches it what not to draw. Afterward the timeline is
scrubbable and any state exports as Mermaid.

## Why a meeting and not a chatbox

<Two or three sentences. The input is a live multi-party conversation. There is
no prompt box. Nobody is typing. The correction signal is a person in the room
reacting to a drawing.>

## How it works

```
Meet tab ──tab audio──┐
                      ├─► extension ──PCM/WS──► server ──► batcher ──► extractor ──► reducer ──► panel
local mic ────────────┘                                                  (LLM, ops)     (state)
```

| Stage | What | Measured |
| --- | --- | --- |
| Capture | Chrome MV3, tab audio + mic as two channels | 24 kHz, 50 fps both channels |
| Transcription | `<model>` over the Realtime API, own energy VAD | speech end → final, p50 `<n>` ms |
| Extraction | `<model>`, structured output, ops not Mermaid | p50 `<n>` ms, `<n>`% no-op |
| Reduce + render | pure reducer, incremental placer | `<n>` px drift |
| **Speech → pixels** | | **p50 `<n>` s / p90 `<n>` s** |

The model emits **operations** against a graph we hold — `add_node`, `add_edge`,
`rename`, `remove` — never Mermaid. Half-streamed Mermaid is broken syntax, and
re-laying out from scratch moves every node on screen. Ops give stable ids,
pinnable positions, and an append-only log where `state(T) = replay(events ≤ T)`.

## Quickstart

```sh
<exact commands, in order, that work from a clean clone>
```

Requires `<ENV_VAR>` — `<where to get one>`. <If it cannot run without a key,
say so here and point at the video.>

## What was built during the event

<Fill in truthfully on the day.>

**Built Saturday:** <the live pipeline, the dismiss loop, the panel, the export,
the scoring — whatever is actually true at 15:00>

**Brought in, as the rules allow:** <the extractor prompt; gonogo as a pip
dependency; the organizer starter kit; named libraries>

## Evaluation

<How well does it work, and how do you know? One paragraph plus the number.
Name what it was measured against.>

## Team

<names> · built at AI Tinkerers "Agents, Everywhere", Seattle, Sep 12 2026
