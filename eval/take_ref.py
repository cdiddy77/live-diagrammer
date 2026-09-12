"""
Build a reference and a re-timed target for a live take of the storyboard.

  python take_ref.py eval/takes/charles-20-04-49 CHARLES01

Writes eval/ref/<NAME>/{reference.md,meta.json} with the storyboard's beats at
the times the cue lines were actually spoken in this take, and
eval/cases/<name>-target.jsonl: the DEMO01 intended boards re-timed to those
beats. Then:

  npm run cases -- --log eval/takes/<take>/take.log.jsonl --meeting <NAME> --from 00:00 --run <run> > eval/cases/<run>.jsonl
  python demo_card.py --real cases/<run>.jsonl --target cases/<name>-target.jsonl

Cue lines are matched loosely (several phrasings each) and in time order. A
beat whose cue is not found is dropped from the timeline and the target, and
the script says so; the card then grades only the beats that were performed.
"""
import json, re, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

# (beat label, [cue phrasings, first match in time order wins])
BEATS = [
    ("first nodes",                 ["okay, go", "okay go", "go ahead", "start"]),
    ("gonogo, rename and redirect", ["now gonogo", "now go, no go", "now go no go", "now go/no-go", "now go-no-go", "go, no-go is the judge", "gonogo is the judge", "is the judge"]),
    ("submission tangent",          ["before i forget", "the submission", "goes to loom"]),
    ("recovery",                    ["back to the pipeline", "skipped a piece", "there's a batcher", "the batcher"]),
    ("closing",                     ["whole thing", "that's it", "we're done"]),
]

# DEMO01 target rows -> storyboard beat they belong to
TARGET_MAP = {
    ("00:11", False): "first nodes",
    ("00:44", False): "gonogo, rename and redirect",
    ("01:26", False): "submission tangent",
    ("01:26", True):  "submission tangent",   # the board at the dismiss (bait)
    ("01:43", False): "recovery",
}


def norm(s):
    return re.sub(r"[^a-z0-9 ]", " ", s.lower().replace("-", " ").replace("/", " "))


def find_cues(finals):
    """Return [(beat, t_ms)] in time order; beats not found are omitted."""
    found, last_t = [], -1
    for beat, phrases in BEATS:
        hit = None
        for e in finals:
            if e["t_start"] <= last_t:
                continue
            txt = norm(e["text"])
            if any(norm(p) in txt for p in phrases):
                hit = e["t_start"]; break
        if hit is not None:
            found.append((beat, hit)); last_t = hit
    return found


def main():
    take_dir, name = Path(sys.argv[1]), sys.argv[2]
    run = name.lower()
    T = [json.loads(l) for l in (take_dir / "take.transcript.jsonl").open(encoding="utf8") if l.strip()]
    fin = sorted((e for e in T if e.get("is_final")), key=lambda e: e["t_start"])
    if not fin:
        sys.exit("no final transcript events in the take")
    cues = find_cues(fin)
    mm = lambda ms: f"{ms // 60000:02d}:{(ms // 1000) % 60:02d}"
    t_end = fin[-1]["t_end"]

    missing = [b for b, _ in BEATS if b not in {c for c, _ in cues}]
    print(f"{name}: {len(fin)} finals, {mm(fin[0]['t_start'])}-{mm(t_end)}")
    for b, t in cues:
        print(f"  {mm(t)}  {b}")
    if missing:
        print(f"  cue not found for: {', '.join(missing)}  (dropped from timeline and target)")

    # reference.md: DEMO01's abstract/decisions, this take's timeline
    src = (HERE / "ref" / "DEMO01" / "reference.md").read_text(encoding="utf8")
    head = src.split("## Topic timeline")[0].replace("DEMO01", name)
    lines = [f"- [{mm(fin[0]['t_start'])}] cold open"] + [f"- [{mm(t)}] {b}" for b, t in cues]
    if not any(b == "closing" for b, _ in cues):
        lines.append(f"- [{mm(t_end)}] closing")
    timeline = ("## Topic timeline (from the take's cue lines)\n\n" + "\n".join(lines) +
                f"\n\nSource: live take {take_dir.name}; beat boundaries are the storyboard's cue lines as spoken. "
                + ("A dismiss was clicked on this machine." if (take_dir / "take.log.jsonl").exists() and
                   any('"kind": "dismiss"' in l or '"kind":"dismiss"' in l for l in (take_dir / "take.log.jsonl").open(encoding="utf8"))
                   else "No dismiss was clicked on this machine.") + "\n")
    out_ref = HERE / "ref" / name
    out_ref.mkdir(parents=True, exist_ok=True)
    (out_ref / "reference.md").write_text(head + timeline, encoding="utf8", newline="\n")
    meta = json.loads((HERE / "ref" / "DEMO01" / "meta.json").read_text(encoding="utf8"))
    meta.update(meeting_id=name, source=f"live take {take_dir.name}", duration_s=round(t_end / 1000, 1), n_events=len(fin))
    (out_ref / "meta.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf8", newline="\n")

    # target: DEMO01 boards re-timed to this take's beats
    starts = dict(cues)
    order = [b for b, _ in cues] + ([] if "closing" in starts else ["closing"])
    if "closing" not in starts:
        starts["closing"] = t_end
    nxt = {order[i]: starts[order[i + 1]] for i in range(len(order) - 1)}
    tgt = [json.loads(l) for l in (HERE / "cases" / "demo01-target.jsonl").open(encoding="utf8") if l.strip()]
    rows = []
    for r in tgt:
        key = (r["input"]["segment_start"], bool(r.get("dismissed")))
        beat = TARGET_MAP.get(key)
        if beat is None or beat not in starts or beat not in nxt:
            continue
        lo, hi = starts[beat], nxt[beat]
        r = json.loads(json.dumps(r))
        r["input"].update(meeting=name, segment_start=mm(lo), segment_end=mm(hi))
        r["expected"].update(topic=beat, topic_path=[beat])
        r["id"] = f"{name}#{mm(lo)}-{mm(hi)}#target" + ("#dismissed" if key[1] else "")
        rows.append(r)
    out_t = HERE / "cases" / f"{run}-target.jsonl"
    out_t.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf8", newline="\n")
    print(f"wrote ref/{name}/ and cases/{run}-target.jsonl ({len(rows)} target rows)")


if __name__ == "__main__":
    main()
