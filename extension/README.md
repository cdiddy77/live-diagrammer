# extension/

A Chrome MV3 extension. One click on a meeting tab starts the capture and
opens the side panel. A second click stops it.

## Load it

1. Build the panel once. It writes `extension/panel/`, which git ignores.

   ```sh
   npm run build:ext
   ```

2. Open `chrome://extensions`, turn on Developer mode, click "Load unpacked",
   and pick this directory.
3. A tab opens for the microphone grant. Click "Grant microphone access".
   Close the tab.
4. Start the server with `npm run server`.
5. Open a Meet tab and click the extension icon. The badge shows `REC`, then
   the frames per second over both channels. 100 means both sources are live.

## What it sends

One WebSocket to `ws://localhost:8787` per capture session.

| Message | Content |
| --- | --- |
| First text message | `{"type":"hello","sample_rate":24000,"frame_ms":20}` |
| Each binary message | 1 byte channel (`0` me, `1` them), then pcm16le mono samples for one frame |

At 24 kHz and 20 ms, one frame is 480 samples and 961 bytes. Each channel
sends 50 frames per second.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | Permissions `tabCapture`, `offscreen`, `storage`, `sidePanel`. `side_panel.default_path` is the panel build. |
| `background.js` | Service worker. Gets the stream id and opens the side panel in the click gesture. Creates the offscreen document. Shows the badge. |
| `offscreen.js` | All audio work. Two `getUserMedia` calls, passthrough playback, the capture `AudioContext`, and the WebSocket. |
| `pcm-worklet.js` | AudioWorklet. Mono mix, PCM16, fixed-size frames with the channel byte. |
| `permission.html` | One-time page that grants the mic to the extension origin. |

## Rules the code keeps

- `getMediaStreamId` and `sidePanel.open` need the click gesture. Both start
  before any `await` in the click handler.
- A service worker has no audio APIs. All `getUserMedia` and `AudioContext`
  work is in the offscreen document, created with reason `USER_MEDIA`.
- Capture mutes the tab. The offscreen document plays the tab stream back
  through a second `AudioContext`.
- An offscreen document cannot prompt for the mic. `permission.html` grants
  it once. A `NotAllowedError` at start opens that page again.
- A worklet node with no path to the destination never runs. The node
  connects to the capture destination and writes silence.
- A `them` channel at `-inf dBFS` with a steady 50 frames per second is a
  connected but silent tab. Meet sends exact zero until a remote audio track
  connects.
- The mic hears the speakers. `echoCancellation: true` helps. Headphones fix it.
