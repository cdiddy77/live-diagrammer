# Submission copy

Portal description, X post, LinkedIn post. Every technical claim below is
checked against `main`. Cut the AMI paragraph if the public copy should stay
on the demo card alone; the rest reads whole without it.

---

## Project description

Live Diagrammer is a Chrome extension and a local server that listen to a
Google Meet call and draw the conversation on a whiteboard while it happens.
Not a transcript. The diagram: the boxes and arrows you would sketch if
someone handed you a marker while your teammate explained the pipeline.

The useful output of a design call is rarely the words. It is the picture
that ends up in one person's head. Meeting tools give you the words back
afterward. We wanted the picture, during.

**The environment is the point.** Nobody types. There is no prompt box. The
extension captures the Meet tab and your mic as two channels, so the agent
hears both sides and knows who said what. The only controls are two buttons.
Snapshot pins the board. Dismiss parks whatever was drawn since the last
snapshot or quiet stretch, and that parked board goes into the extractor's
next three calls as a negative example: this is what the room just rejected.
Over one meeting the agent learns what this room does not want drawn. A
chatbot never gets that signal; there is no room around it reacting.

**How it works.** The MV3 extension streams both channels as PCM over a
WebSocket to a Node server. One OpenAI Realtime transcription session per
channel (gpt-live-transcribe), with our own energy-based turn detection.
Partials hold the current batch open while someone is still talking; only
committed finals reach the model. At a pause, the batch goes to the extractor
(gpt-4.1-mini, strict `json_schema` generated from the same zod contract the
rest of the system enforces), which returns operations: `add_node`,
`add_edge`, `rename`, `remove`, `new_diagram`. An empty list is the normal
answer.

The model never emits Mermaid. Streamed Mermaid is broken until the last
token lands, and each re-render lays out the whole graph again, so nodes jump
while you watch. Operations against a graph the server owns fix both. A
reducer applies each op, rejects unknown ids and duplicate edges, and appends
everything - ops, rejections, snapshots, dismisses - to one event log. The
React Flow panel places each new node beside its neighbors and never moves an
old one. The board at any moment is the log replayed to that moment, so a
scrubber over the meeting came free, and any point exports to Mermaid.

**What was hard.** Not adding nodes. Getting the model to leave the board
alone. Most speech should change nothing, and a mid-sentence correction ("the
transcriber, no, the extractor") must land as a rename, not a second box.
Those two failures turn a live diagram into noise, and you cannot eyeball
them in a demo.

So we measured. gonogo is a Python evaluation harness James wrote before the
event: cases in, pass rate with a 95% interval out, no verdict when n is too
small, and any LLM judge checked against human labels first. Today we pointed
it at the board. A storyboard says what is said and what the diagram should
be after each beat; a take's cue lines re-time it to what was actually
spoken; a deterministic matcher scores the live board against the intended
one on node and edge F1. No model grades the model. On the recorded take: 3
of 3 segments matched (F1 0.93, 0.91, 0.89), 6 of 6 beats landed - rename,
redirect, the tangent drawn, a dismiss scoped to that tangent, the
architecture intact after it. The interval is wide because n is 3, and the
card says so.

With gonogo's LLM judge over 35 human-annotated segments of real AMI
meetings: 57% [41%, 72%]. Boards under about sixteen nodes pass; past twenty
they mostly do not. That is the next fix, and it has a number.

**Every take feeds the next.** A capture becomes test cases with one command.
The cases accumulate in the repo. The same command grades any prompt or
pipeline change against every take so far. In one afternoon that loop found
the dismiss discarding the whole board instead of the tangent (recovery 0 of
10 runs, then 10 of 10), a mic that never went quiet enough to end a turn,
and four defects in the grader itself. The harness finds it, a person fixes
it, the harness confirms.

**Stack.** TypeScript end to end: Chrome MV3, Node + ws, OpenAI Realtime API,
chat completions with `json_schema`, zod, React, React Flow, Vite. Evaluation
in Python on gonogo.

Built at AI Tinkerers "Agents, Everywhere," Seattle, September 12, 2026, by
Charles Parker and James Dominguez.

---

## X post

We built a thing today at @aitinkerers that sits in your Google Meet and
draws the conversation while you have it. A few seconds behind speech, two
buttons (snapshot / dismiss), and a dismiss goes back to the model as "not
this" for the next few calls.

No eyeballing the demo. We pointed gonogo (an eval harness @<james> wrote
before the event) at the live board: 3 of 3 segments, 6 of 6 beats. Every
take we record is a test case for the next change.

Built with @<james>. Video + repo: https://github.com/cdiddy77/live-diagrammer

---

## LinkedIn post

James Dominguez and I spent today at AI Tinkerers "Agents, Everywhere" in
Seattle building Live Diagrammer: a whiteboard inside a Google Meet call that
stays current while people talk. Not a transcript. The diagram.

What I did not expect:

There is no prompt. The input is two channels of live audio and the only
feedback is someone hitting Snapshot or Dismiss. A dismiss parks what was
just drawn and hands it back to the model as a negative example, so it learns
the room's taste during the meeting.

The model never touches Mermaid. It emits ops against a graph we own, applied
by a reducer to an append-only log. Stable ids, nodes that stay put, and a
scrubber over the whole meeting for free.

Adding nodes was easy. Getting the model to do nothing while someone thinks
out loud, and to treat "no, I mean the extractor" as a rename instead of a
new box, was most of the day.

We did not eyeball it. James had written gonogo, a Python eval harness,
before the event; today we pointed it at the board. A storyboard defines the
intended diagram after each beat, a deterministic matcher scores the live
board against it, gonogo turns that into a pass rate with an interval. 3 of 3
segments, 6 of 6 beats, including a scoped dismiss and the recovery after it.
On 35 real meeting segments from the AMI corpus, with an LLM judge, 57% - and
it says where it fails: boards past about twenty nodes.

The part I will keep: every recorded take becomes test cases with one
command, and every change is graded against all of them. That loop found
three real bugs this afternoon, one in the grader.

Stack: Chrome MV3, Node, OpenAI Realtime transcription, gpt-4.1-mini with
structured output, zod, React Flow, gonogo.

Video and repo: https://github.com/cdiddy77/live-diagrammer

Thanks to AI Tinkerers for hosting.
