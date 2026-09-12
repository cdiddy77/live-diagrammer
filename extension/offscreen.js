// Offscreen document. All audio work happens here:
//   local mic  (getUserMedia audio)        -> channel 0 "me"
//   tab audio  (chromeMediaSource: "tab")  -> channel 1 "them"
// Each source feeds its own AudioWorklet node. The node posts PCM16 mono
// frames of FRAME_MS, and every frame goes to the server over one WebSocket.
//
// Wire format:
//   first text message   {"type":"hello","sample_rate":24000,"frame_ms":20}
//   each binary message  [1 byte channel][pcm16le samples for one frame]

const SERVER_URL = "ws://localhost:8787";
// The transcription API takes 24 kHz PCM. The capture AudioContext runs at
// that rate, so Chrome resamples both inputs and no server-side work is needed.
const SAMPLE_RATE = 24000;
const FRAME_MS = 20;
const CHANNEL = { me: 0, them: 1 };

let session = null;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "offscreen") return;
  if (msg.type === "start") {
    start(msg.streamId)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => {
        console.error(e);
        sendResponse({ ok: false, error: `${e.name}: ${e.message}` });
      });
    return true;
  }
  if (msg.type === "stop") {
    stop();
    sendResponse({ ok: true });
  }
});

async function start(streamId) {
  if (session) stop();
  const opened = { tracks: [], contexts: [] };

  try {
    const tabStream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
      video: false,
    });
    opened.tracks.push(...tabStream.getTracks());

    // NotAllowedError here means the one-time grant on permission.html was skipped.
    const micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    opened.tracks.push(...micStream.getTracks());

    // Passthrough. Capture mutes the tab for the user; play it back so the
    // meeting stays audible.
    const playback = new AudioContext();
    opened.contexts.push(playback);
    playback.createMediaStreamSource(tabStream).connect(playback.destination);

    const capture = new AudioContext({ sampleRate: SAMPLE_RATE });
    opened.contexts.push(capture);
    await capture.audioWorklet.addModule("pcm-worklet.js");

    const ws = await connect(SERVER_URL);
    ws.send(JSON.stringify({ type: "hello", sample_rate: SAMPLE_RATE, frame_ms: FRAME_MS }));

    const counts = { me: 0, them: 0 };
    const attach = (stream, name) => {
      const source = capture.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(capture, "pcm-frames", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        processorOptions: { frameSamples: (SAMPLE_RATE * FRAME_MS) / 1000, channel: CHANNEL[name] },
      });
      node.port.onmessage = (e) => {
        counts[name]++;
        if (ws.readyState === WebSocket.OPEN) ws.send(e.data);
      };
      source.connect(node);
      // The node writes silence, but it must reach the destination. A node
      // with no path to the destination is never pulled, so process() never runs.
      node.connect(capture.destination);
    };
    attach(micStream, "me");
    attach(tabStream, "them");

    const statsTimer = setInterval(() => {
      chrome.runtime.sendMessage({ target: "background", type: "stats", ...counts });
      console.log(`frames/s me=${counts.me} them=${counts.them}`);
      counts.me = 0;
      counts.them = 0;
    }, 1000);

    session = { tabStream, micStream, playback, capture, ws, statsTimer };

    // The tab track ends when the tab closes or the user stops sharing.
    tabStream.getAudioTracks()[0].onended = () => end("tab");
    // The server closed the socket, or it went away.
    ws.onclose = () => end("server");

    console.log("capture started", { SAMPLE_RATE, FRAME_MS });
  } catch (e) {
    for (const track of opened.tracks) track.stop();
    for (const ctx of opened.contexts) ctx.close();
    throw e;
  }
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error(`cannot connect to ${url}; is the server running?`));
  });
}

function end(reason) {
  if (!session) return;
  stop();
  chrome.runtime.sendMessage({ target: "background", type: "ended", reason });
}

function stop() {
  if (!session) return;
  const s = session;
  session = null;
  clearInterval(s.statsTimer);
  s.ws.onclose = null;
  for (const track of [...s.tabStream.getTracks(), ...s.micStream.getTracks()]) track.stop();
  s.capture.close();
  s.playback.close();
  if (s.ws.readyState === WebSocket.OPEN || s.ws.readyState === WebSocket.CONNECTING) s.ws.close();
  console.log("capture stopped");
}
