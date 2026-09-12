#!/usr/bin/env node
// Save a capture's files where the other machine can see them.
//
//   npm run take -- charles              # newest capture in out/
//   npm run take -- charles 20-35-07     # a specific capture, by the time part of its stamp
//   npm run take -- charles --all        # every capture in out/ not yet saved
//
// Copies out/live-<stamp>.{transcript.jsonl,log.jsonl,mmd} to
// eval/takes/<who>-<HH-MM-SS>/take.*, then prints the commit command. out/ is
// ignored by git; eval/takes/ is tracked, which is the whole point.
//
// If a capture was never stopped with the extension icon, only the transcript
// exists. That is enough: the board and log are regenerated from it on replay.
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

const [who, ...rest] = process.argv.slice(2);
if (!who || who.startsWith("-")) {
  console.error("usage: npm run take -- <who> [HH-MM-SS | --all]");
  process.exit(2);
}
const all = rest.includes("--all");
const pick = rest.find((a) => !a.startsWith("-"));

const outDir = "out";
const stamps = [...new Set(
  readdirSync(outDir)
    .map((f) => /^live-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})\.transcript\.jsonl$/.exec(f)?.[1])
    .filter(Boolean),
)].sort();
if (!stamps.length) {
  console.error(`no live-*.transcript.jsonl in ${outDir}/ - start a capture first`);
  process.exit(1);
}

let chosen;
if (all) chosen = stamps;
else if (pick) {
  chosen = stamps.filter((s) => s.endsWith(pick));
  if (!chosen.length) { console.error(`no capture ending in ${pick}; have: ${stamps.map((s) => s.slice(11)).join(" ")}`); process.exit(1); }
} else chosen = [stamps[stamps.length - 1]];

const saved = [];
for (const stamp of chosen) {
  const dir = join("eval", "takes", `${who}-${stamp.slice(11)}`);
  if (existsSync(dir) && !all) console.error(`note: ${dir} exists, overwriting`);
  mkdirSync(dir, { recursive: true });
  const files = [["transcript.jsonl", "take.transcript.jsonl"], ["log.jsonl", "take.log.jsonl"], ["mmd", "take.mmd"]];
  const got = [];
  for (const [ext, name] of files) {
    const src = join(outDir, `live-${stamp}.${ext}`);
    if (existsSync(src)) { copyFileSync(src, join(dir, name)); got.push(name); }
  }
  const note = got.length === 1 ? "  (transcript only - capture was not stopped; board regenerates on replay)" : "";
  console.log(`${dir}/  <- ${got.join(", ")}${note}`);
  saved.push(dir);
}

console.log(`\nnow:\n  git add eval/takes && git commit -m "eval: ${who}'s take${saved.length > 1 ? "s" : ""}" && git push`);
