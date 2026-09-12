# eval

The report card is an internal instrument: it says whether a take is safe to
film. It does not appear in the video.

## Pre-flight a take

The server writes `out/<name>.log.jsonl` for every session. Turn the log into
cases and grade them against the storyboard's intended board:

```sh
npm run cases -- --log out/<take>.log.jsonl --meeting DEMO01 --from 00:00 --run take1 > eval/cases/take1.jsonl
cd eval && ./.venv/Scripts/python demo_card.py --real cases/take1.jsonl --target cases/demo01-target.jsonl --out card.html
```

Several takes of the same recording widen n honestly (each is an independent
draw of the extractor). Pass them all to `--real`; the card reports each line
as *k of N runs*.

## Replaying a recording N times

```sh
npm run server -- --events out/take1.transcript.jsonl --rate 0 --dismiss-after 12 --name r1
```

The server does not exit after a replay (the panel WebSocket stays up); kill
it once `out/r1.mmd` appears, then start the next. `eval/cases/runs/` holds
ten such runs of `eval/ref/DEMO01/transcript.jsonl`, and `card-10runs.html`
is their card.

## Setup, once

```sh
cd eval && python -m venv .venv && ./.venv/Scripts/python -m pip install gonogo-eval
```

`demo_card.py` needs no API key. `rubric.py` is the rubric for the LLM
fidelity judge used on the AMI benchmark; that judge is not part of the demo.

## Files

| file | what |
| --- | --- |
| `cases.ts`, `reference.ts` | session log → gonogo cases, one per human-annotated segment plus one at each dismiss |
| `demo_card.py` | gonogo harness with a deterministic board-vs-target judge; renders the card |
| `rubric.py` | rubric for the LLM fidelity judge (benchmark only) |
| `ref/DEMO01/` | the storyboard as a reference meeting: transcript, topic timeline, mock op stream |
| `cases/demo01-target.jsonl` | the intended board per segment |
| `cases/runs/` | ten replays of DEMO01 through this server |
| `card-10runs.html` | their card: every segment matched in 10 of 10 runs |
