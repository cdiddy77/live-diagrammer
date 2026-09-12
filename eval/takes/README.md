# takes

One directory per capture, per machine: `<who>-<HH-MM-SS>/`. The server's
`out/` is ignored, so copy the files here.

| file | what | needed for |
| --- | --- | --- |
| `take.transcript.jsonl` | TranscriptEvents with ASR latency, written live | the replay source; regenerate everything else from it |
| `take.log.jsonl` | the session log (ops, rejections, dismiss, snapshot) | `eval/cases.ts` |
| `take.mmd` | the final board | eyeballing |

The log and board are written when the capture stops (click the extension
icon). If a capture was never stopped, only the transcript exists; regenerate:

```sh
npm run server -- --events eval/takes/<who>-<stamp>/take.transcript.jsonl --rate 0 --name <who>-<stamp>
# kill the server once out/<who>-<stamp>.mmd appears, then copy the two files here
```

Both machines on one call each hear their own speaker on `me` clean and the
other through Meet on `them`, so the two takes of the same conversation are
mirror images in ASR quality. Compare them with `eval/cases.ts` + `demo_card.py`
on each, or stitch the two `me` channels into one transcript.
