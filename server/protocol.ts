// The wire between the server and a panel. One JSON text message per frame.
// Server to panel: `hello` with the backlog, then `log` per LogEntry, then `end`.
// Panel to server: `snapshot` and `dismiss`, the two diagram buttons; `reset`,
// which ends the session and starts a fresh one without a restart; and
// `pause` / `resume`, which gate the capture audio while the sessions stay open.
import type { LogEntry } from "../contracts/schema.ts";

export const DEFAULT_PANEL_PORT = 8791;

/** Wall-clock stamps on an ops entry, so a panel can split speech end to pixel. */
export type Wall = {
  /** Date.now() on the server when the message left. */
  sent: number;
  /**
   * Date.now() at which the speech behind this entry ended. Live: arrival of
   * the last final minus the ASR latency. Paced replay: play start plus t_end
   * over rate. Absent when the server cannot know (unpaced replay, backlog).
   */
  speech_end?: number;
  /** Date.now() at which the last final of the batch reached the pipeline. */
  final_arrived?: number;
};

export type ServerMsg =
  | { kind: "hello"; source: string; rate: number; backlog: LogEntry[]; paused?: boolean }
  | { kind: "log"; entry: LogEntry; wall?: Wall }
  | { kind: "end"; reason: string }
  | { kind: "paused"; paused: boolean };

export type PanelMsg =
  | { kind: "snapshot" }
  | { kind: "dismiss" }
  | { kind: "reset" }
  | { kind: "pause" }
  | { kind: "resume" };
