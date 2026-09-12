# CHARLES01 reference

demo storyboard, architecture discussion. Duration 02:18. Official split: demo. Words: 296.

| agent | speaker | channel | words |
| --- | --- | --- | --- |
| A | Charles | me | 146 |
| B | James | them | 150 |

## Abstract

- Charles restated the live pipeline and James corrected it: Meet tab and mic into the Chrome extension, extension to a local server, server to the OpenAI Realtime transcriber, transcriber to the extractor.
- The extractor emits operations, never a drawing. Operations go into a log and the side panel draws from the log.
- Charles thought gonogo was the judge and read the log directly. James corrected both: gonogo is the harness that runs the judge over many cases and reports a pass rate with an interval, and it reads cases written by the case emitter, which is the only thing that reads the log.
- James went off on the submission: the video goes to Loom, the Loom link and the repo link go into the portal, and the social post tags the sponsors. Charles dismissed the board.
- Back on the pipeline, Charles added the batcher between the transcriber and the extractor, and James added the reducer between the extractor and the log.
- James explained that a dismissed board becomes a negative example for the next few extractor calls.

## Decisions

- The pipeline is: Meet tab and mic, Chrome extension, local server, transcriber (OpenAI Realtime), batcher, extractor, reducer, log, side panel.
- gonogo is the harness, not the judge. The judge runs inside it.
- gonogo reads cases from the case emitter. Only the case emitter reads the log.
- A dismissed board is a negative example for the next few extractor calls.
- The submission flow (Loom, portal, social post) is not part of the architecture.

## Actions

- Record the take at 12:30 on Sep 12 2026.

## Problems

- The agent drew the submission tangent on the architecture board.

## Topic timeline (from the take's cue lines)

- [00:00] cold open
- [00:00] first nodes
- [00:48] gonogo, rename and redirect
- [01:47] submission tangent
- [02:00] recovery
- [02:45] closing

Source: live take charles-20-04-49; beat boundaries are the storyboard's cue lines as spoken. A dismiss was clicked on this machine.
