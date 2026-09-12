// The side panel: a WebSocket client, the placer on a React Flow canvas,
// Snapshot, Dismiss, and Reset, a latency badge, a structural badge, a
// scrubber, and Mermaid export. Everything on screen is a fold over the log
// (session.ts).
//
// URL params:
//   ?ws=ws://host:port   the server fan-out (default ws://localhost:8791)
//   ?caption=text        small fixed text bottom-left, for the video
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, useReactFlow,
  type Edge, type Node, type NodeProps,
} from "@xyflow/react";
import type { CompactDiagram, LogEntry } from "../../contracts/schema.ts";
import { diagramToMermaid } from "../../extractor/mermaid.ts";
import { DEFAULT_PANEL_PORT, type PanelMsg, type ServerMsg, type Wall } from "../../server/protocol.ts";
import { nodeSize, ROW_PITCH } from "./layout.ts";
import { DRIFT_LIMIT_PX, type Positions } from "./drift.ts";
import { activeDiagram, fold, structure, type Frozen } from "./session.ts";

const params = new URLSearchParams(location.search);
const WS_URL = params.get("ws") ?? `ws://localhost:${DEFAULT_PANEL_PORT}`;
const CAPTION = params.get("caption");

type Rec = { entry: LogEntry; wall?: Wall; received: number };

/** Speech end to pixel, with where the time went. Wall-clock ms on one machine. */
export type Latency = {
  total: number; asr: number; wait: number; llm: number; render: number; seq: number;
};

declare global {
  interface Window {
    __panel: {
      entries: number; calls: number; ended: boolean; connected: boolean;
      latency: Latency | null; latencies: Latency[];
    };
  }
}

// ---------------------------------------------------------------------------
// WebSocket client. Reconnects until the component unmounts.
// ---------------------------------------------------------------------------
function useFeed() {
  const [recs, setRecs] = useState<Rec[]>([]);
  const [connected, setConnected] = useState(false);
  const [ended, setEnded] = useState<string | null>(null);
  const [source, setSource] = useState("");
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let stop = false;
    let ws: WebSocket;
    let timer: ReturnType<typeof setTimeout>;
    const connect = () => {
      ws = new WebSocket(WS_URL);
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onmessage = (m) => {
        const msg = JSON.parse(m.data) as ServerMsg;
        const now = Date.now();
        if (msg.kind === "hello") {
          setSource(`${msg.source} · ${msg.rate === 0 ? "unpaced" : `${msg.rate}×`}`);
          setRecs(msg.backlog.map((entry) => ({ entry, received: now })));
          setEnded(null);
        } else if (msg.kind === "log") {
          setRecs((r) => [...r, { entry: msg.entry, wall: msg.wall, received: now }]);
        } else if (msg.kind === "end") {
          setEnded(msg.reason);
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (!stop) timer = setTimeout(connect, 1000);
      };
    };
    connect();
    return () => { stop = true; clearTimeout(timer); ws.close(); };
  }, []);

  const send = useCallback((m: PanelMsg) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
  }, []);

  return { recs, connected, ended, source, send };
}

// ---------------------------------------------------------------------------
// A node with a handle on every side. The edge picks the pair that fits the
// geometry, so a same-row edge runs sideways instead of looping.
// ---------------------------------------------------------------------------
function Box({ data }: NodeProps<Node<{ label: string }>>) {
  return (
    <>
      <Handle type="target" position={Position.Top} id="t-t" />
      <Handle type="target" position={Position.Left} id="t-l" />
      <Handle type="target" position={Position.Right} id="t-r" />
      <Handle type="target" position={Position.Bottom} id="t-b" />
      {data.label}
      <Handle type="source" position={Position.Bottom} id="s-b" />
      <Handle type="source" position={Position.Right} id="s-r" />
      <Handle type="source" position={Position.Left} id="s-l" />
      <Handle type="source" position={Position.Top} id="s-t" />
    </>
  );
}
const nodeTypes = { box: Box };

function handles(d: CompactDiagram, pos: Positions, from: string, to: string): { sourceHandle: string; targetHandle: string } {
  const s = pos[from], t = pos[to];
  if (!s || !t) return { sourceHandle: "s-b", targetHandle: "t-t" };
  const label = (id: string) => d.nodes.find((n) => n.id === id)?.label ?? "";
  const sx = s.x + nodeSize(label(from)).width / 2;
  const tx = t.x + nodeSize(label(to)).width / 2;
  const dy = t.y - s.y;
  // Target below: the normal case.
  if (dy > ROW_PITCH / 2) return { sourceHandle: "s-b", targetHandle: "t-t" };
  // Same row: sideways.
  if (Math.abs(dy) <= ROW_PITCH / 2) {
    return tx >= sx ? { sourceHandle: "s-r", targetHandle: "t-l" } : { sourceHandle: "s-l", targetHandle: "t-r" };
  }
  // Back edge: round the side.
  return tx >= sx ? { sourceHandle: "s-r", targetHandle: "t-r" } : { sourceHandle: "s-l", targetHandle: "t-l" };
}

// ---------------------------------------------------------------------------
const fmtS = (ms: number) => `${(ms / 1000).toFixed(2)} s`;
const mmss = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const FIT = { padding: 0.15, maxZoom: 1, duration: 400 };

function Inner() {
  const { recs, connected, ended, source, send } = useFeed();
  const [live, setLive] = useState(true);
  const [cursor, setCursor] = useState(0);
  const [peek, setPeek] = useState<Frozen | null>(null);
  const [showMmd, setShowMmd] = useState(false);
  const [lat, setLat] = useState<Latency | null>(null);
  const lats = useRef<Latency[]>([]);
  const measured = useRef(-1);
  const { fitView } = useReactFlow();
  // The camera refits after every change until the user zooms or pans. Fit turns that back on.
  const [autoFit, setAutoFit] = useState(true);

  const upto = live ? recs.length : cursor;
  // A new session (hello with an empty backlog) puts the panel back on live.
  useEffect(() => {
    if (recs.length === 0) { setLive(true); setPeek(null); setAutoFit(true); }
  }, [recs.length]);

  const view = useMemo(() => fold(recs.slice(0, upto).map((r) => r.entry)), [recs, upto]);
  const active = activeDiagram(view.state);
  const shown: CompactDiagram | undefined = peek?.diagram ?? active;
  const pos: Positions = peek ? peek.pos : shown ? view.pos[shown.diagram_id] ?? {} : {};
  const shape = structure(active);

  // Latency: the newest ops entry that changed the picture, measured on the
  // second animation frame after React committed it, when the pixels are on screen.
  useEffect(() => {
    if (!live) return;
    const r = recs[recs.length - 1];
    if (!r || r.entry.event.kind !== "ops" || !r.entry.event.ops.length) return;
    if (!r.wall?.speech_end || !r.wall.final_arrived || measured.current === r.entry.seq) return;
    measured.current = r.entry.seq;
    const ev = r.entry.event;
    const w = r.wall;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const paint = Date.now();
        const l: Latency = {
          total: paint - w.speech_end!,
          asr: w.final_arrived! - w.speech_end!,
          wait: Math.max(0, w.sent - w.final_arrived! - ev.latency_ms),
          llm: ev.latency_ms,
          render: paint - r.received,
          seq: r.entry.seq,
        };
        lats.current.push(l);
        setLat(l);
      });
    });
    return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); };
  }, [recs, live]);

  useEffect(() => {
    window.__panel = {
      entries: recs.length, calls: view.calls, ended: ended !== null, connected,
      latency: lat, latencies: lats.current,
    };
  }, [recs.length, view.calls, ended, lat, connected]);

  // Nodes never move relative to each other, so a refit is the only camera change.
  useEffect(() => { if (autoFit) fitView(FIT); }, [shown, pos, fitView, autoFit]);

  const drifted = new Set(view.last?.moved.filter((m) => m.dist > DRIFT_LIMIT_PX).map((m) => m.id));
  const fresh = new Set(peek ? [] : [...(view.last?.added ?? []), ...(view.last?.anchored ?? [])]);
  const nodes: Node[] = (shown?.nodes ?? []).map((n) => ({
    id: n.id,
    type: "box",
    position: pos[n.id] ?? { x: 0, y: 0 },
    data: { label: n.label },
    style: nodeSize(n.label),
    className: `node ${drifted.has(n.id) ? "drifted" : fresh.has(n.id) ? "fresh" : ""}`,
    draggable: false,
  }));
  const edges: Edge[] = shown ? shown.edges.map((e) => ({
    id: `${e.from}->${e.to}`,
    source: e.from,
    target: e.to,
    label: e.label,
    type: "smoothstep",
    markerEnd: { type: MarkerType.ArrowClosed },
    ...handles(shown, pos, e.from, e.to),
  })) : [];

  const mmd = shown ? diagramToMermaid(shown) : "";
  const copy = async () => {
    try { await navigator.clipboard.writeText(mmd); } catch { /* an extension page may refuse; the textarea is there */ }
    setShowMmd(true);
  };
  const latClass = !lat ? "" : lat.total <= 2000 ? "good" : lat.total <= 3500 ? "slow" : "bad";
  const shapeClass = shape.orphans + shape.duplicates + view.rejected === 0 ? "good" : shape.duplicates ? "bad" : "slow";
  const tNow = recs[upto - 1]?.entry.t_ms ?? 0;
  const parkedEmpty = view.parked.length > 0 && !view.state.active;
  const canAct = !!active && live && !ended;

  return (
    <>
      <div className="top">
        <span className={`dot ${connected && !ended ? "on" : "off"}`} title={WS_URL} />
        <h1>Live Diagrammer</h1>
        <button className="snapshot" onClick={() => send({ kind: "snapshot" })} disabled={!canAct}>Snapshot</button>
        <button className="dismiss" onClick={() => send({ kind: "dismiss" })} disabled={!canAct}>Dismiss</button>
        <button
          className="reset"
          onClick={() => send({ kind: "reset" })}
          disabled={!connected}
          title="new take: the server writes this session's files and starts a fresh one"
        >
          Reset
        </button>
      </div>
      <div className="canvas">
        <div className="badges">
          <div className={`badge ${latClass}`}>
            {lat ? <>
              <span className="big">{fmtS(lat.total)}</span>
              <span className="sub">speech end → pixel</span>
              <span className="sub">asr {fmtS(lat.asr)} · wait {fmtS(lat.wait)} · llm {fmtS(lat.llm)} · paint {lat.render} ms</span>
            </> : <>
              <span className="big">–</span>
              <span className="sub">{ended ? `ended: ${ended}` : connected ? "waiting for the first change" : "connecting…"}</span>
            </>}
          </div>
          <div className={`badge shape ${shapeClass}`} title="accepted ops · rejected ops · orphan nodes · duplicate labels, on the active diagram">
            <span className="sub">ops <b>{view.accepted}</b></span>
            <span className="sub">rejected <b>{view.rejected}</b></span>
            <span className="sub">orphans <b>{shape.orphans}</b></span>
            <span className="sub">dupes <b>{shape.duplicates}</b></span>
          </div>
        </div>
        {!shown && <div className={`empty ${parkedEmpty ? "parked" : ""}`}>
          {parkedEmpty ? "Parked. Listening for the next thing to draw." : ended ? "No diagram." : "Listening…"}
        </div>}
        <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} nodesDraggable={false} nodesConnectable={false}
          elementsSelectable={false} minZoom={0.2} onMoveStart={(e) => { if (e) setAutoFit(false); }}
          proOptions={{ hideAttribution: true }}>
          <Background gap={20} />
        </ReactFlow>
        {CAPTION && <div className="caption">{CAPTION}</div>}
      </div>
      <div className="bottom">
        <div className="heard">{view.heard ? <><b>{view.heard.channel}</b> {view.heard.text}</> : source || " "}</div>
        <div className="row">
          <button onClick={() => { setLive(true); setPeek(null); }} disabled={live && !peek}>Live</button>
          <button onClick={() => { setAutoFit(true); fitView(FIT); }} disabled={autoFit} title="the wheel zooms and a drag pans; Fit follows the diagram again">Fit</button>
          <input type="range" min={0} max={recs.length} value={upto}
            onChange={(e) => { setLive(false); setPeek(null); setCursor(Number(e.target.value)); }} />
          <span className="mono">{mmss(tNow)} · {upto}/{recs.length}</span>
        </div>
        <div className="row">
          <div className="chips">
            <span className="chip">{view.calls} calls · {view.noops} no-op</span>
            {view.parked.map((p) => (
              <span key={p.seq} className={`chip parked ${peek?.seq === p.seq ? "on" : ""}`}
                onClick={() => setPeek(peek?.seq === p.seq ? null : p)} title="dismissed; click to peek">
                parked {p.diagram.title ?? `${p.diagram.nodes.length} nodes`}
              </span>
            ))}
            {view.snapshots.map((s) => (
              <span key={s.seq} className={`chip snap ${peek?.seq === s.seq ? "on" : ""}`}
                onClick={() => setPeek(peek?.seq === s.seq ? null : s)} title="snapshot; click to peek">
                📌 {mmss(s.t_ms)}
              </span>
            ))}
          </div>
          <span style={{ flex: 1 }} />
          <button onClick={copy} disabled={!shown}>Mermaid</button>
        </div>
        {showMmd && <textarea className="mmd" readOnly value={mmd} onClick={() => setShowMmd(false)} />}
      </div>
    </>
  );
}

export function App() {
  return (
    <ReactFlowProvider>
      <Inner />
    </ReactFlowProvider>
  );
}
