# Live Diagrammer

An agent listens to a live meeting and keeps a diagram of the discussion
current. This repo is the submission for the AI Tinkerers "Agents, Everywhere"
hackathon, Sep 12 2026.

## Layout

One npm package at the root, plus a Python venv for `eval/`.

| Directory | What it holds |
| --- | --- |
| `contracts/` | `schema.ts` (zod contract, `CONTRACT_VERSION`), `reducer.ts`, `validate.ts`, `fixtures/` |
| `extractor/` | `prompt.ts`, `provider.ts` (OpenAI-compatible client), `mermaid.ts` |
| `server/` | transcriber, pipeline, and WebSocket fan-out as one process |
| `extension/` | Chrome MV3 extension; `extension/panel/` is the panel build output |
| `panel/` | Vite React side panel; `src/layout.ts` is the incremental placer |
| `eval/` | report-card scripts, cases, reference transcripts |
| `demo/` | Playwright demo driver |

## Run

```sh
npm install
cp .env.example .env        # then set OPENAI_API_KEY
npm run server              # transcriber + pipeline + panel fan-out
npm run dev                 # standalone panel at http://localhost:5174
npm run build:ext           # writes extension/panel/ for the Chrome side panel
```

`eval/` uses Python:

```sh
python3 -m venv eval/.venv
eval/.venv/bin/pip install gonogo-eval
```

## Check

```sh
npm run validate            # fixtures parse and replay through the reducer
npm run check               # tsc --noEmit over the whole package
# plus the private-name check in CLAUDE.local.md
```

## Rules

- Keep the S0 contract unchanged. If a shape must change, bump
  `CONTRACT_VERSION` in `contracts/schema.ts` and say so.
- Pre-event components brought in as-is are listed in the README under
  What was built during the event.
- The submission deadline is 16:30 PDT. Target submitted by 16:00.
