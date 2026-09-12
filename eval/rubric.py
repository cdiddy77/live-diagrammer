"""The rubric the judge scores against.

gonogo builds the prompt as:

    {rubric}

    Expected answer:
    {expected}

    Candidate answer:
    {output}

    Score the candidate from 1 to 5. Reply with the number first, then one
    sentence of justification.

So the rubric only has to say what good means. `expected` carries the
conversation so far and the human annotations; `output` carries the board.

Why the case grades the board and not the edit
----------------------------------------------
A first version graded what changed during one segment. Most segments change
nothing — correctly, since most talk is not structure — so the rubric had to
say "no change is a 5", and 12 of 20 cases became automatic passes. The judge
agreed with everything, kappa collapsed to 0.02, and the eval measured nothing.

Grading the *board* against *everything said so far* keeps every segment a real
judgment, which is also what a report card on a diagram actually means.
"""

RUBRIC = """You are grading a diagram that an agent drew live while people talked.

The agent listens to a meeting and maintains a diagram of the structure being
discussed. It is not taking minutes, and it is not trying to capture every
topic — most of what is said is not structure and belongs nowhere on a board.

You will see the conversation so far, the human annotator's topic labels for
that stretch, the human-written decisions for the meeting, and then the board
as it stood at that moment.

Judge the BOARD against the CONVERSATION SO FAR, on three things:

GROUNDED - does everything on the board trace to something actually said?
  An invented node or edge is the worst defect available, because a person has
  to notice it and remove it.

COMPLETE - is the structure that was actually discussed present on the board?
  Judge against what has been covered so far, never against what comes later.
  A board that is merely small is not incomplete; a board missing the main
  thing under discussion is.

COHERENT - can someone read it? Two nodes meaning the same thing, a node left
  unconnected to anything, or an edge asserting a relationship nobody claimed
  all make it worse.

Scale:
  5 - grounded, covers the structure discussed so far, reads cleanly
  4 - solid; a minor omission or an awkward label, nothing invented
  3 - right topic, but missing something important, or carrying a duplicate or
      an unsupported edge
  2 - loosely related to what was said, several invented or duplicated pieces,
      or a set of nodes with no relationships drawn between them
  1 - unrelated to the conversation, or so duplicated or disconnected that it
      misleads a reader

Two hard caps, which override everything above:

- A board with three or more nodes and NO edges is a list, not a diagram. It
  tells a reader nothing about how anything relates. Score it 2 at most, however
  well chosen the node labels are.
- A board carrying two nodes that mean the same thing scores 3 at most, because
  a person has to notice and merge them.

Do not reward volume: a small correct board beats a large speculative one.
Do not reward an empty board either — if real structure was discussed and the
board is empty, that is a 2 or below."""
