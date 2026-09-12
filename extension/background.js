// Service worker. It owns the click gesture, the badge, and the offscreen
// document. It never touches audio: a service worker has no getUserMedia and
// no AudioContext. The offscreen document does that work.

const OFFSCREEN_URL = "offscreen.html";
const PERMISSION_URL = "permission.html";

chrome.runtime.onInstalled.addListener(({ reason }) => {
  // The offscreen document cannot show the mic prompt. A normal extension
  // page asks once; Chrome then remembers the grant for the extension origin.
  if (reason === "install") openPermissionPage();
});

function openPermissionPage() {
  chrome.tabs.create({ url: chrome.runtime.getURL(PERMISSION_URL) });
}

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["USER_MEDIA"],
    justification: "Capture the tab audio and the microphone, encode PCM, stream to the local server",
  });
}

async function isCapturing() {
  const { capturing } = await chrome.storage.session.get("capturing");
  return Boolean(capturing);
}

async function setCapturing(on) {
  await chrome.storage.session.set({ capturing: on });
}

async function setBadge(text, color) {
  await chrome.action.setBadgeText({ text });
  if (color) await chrome.action.setBadgeBackgroundColor({ color });
}

chrome.action.onClicked.addListener(async (tab) => {
  // Both calls need the click gesture, so they start before any await.
  // A stop click also runs them; the unused stream id expires on its own.
  const streamIdPromise = chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  chrome.sidePanel
    .open({ tabId: tab.id })
    .catch((e) => console.warn("side panel did not open:", e.message));

  if (await isCapturing()) {
    streamIdPromise.catch(() => {});
    await stopCapture();
    return;
  }

  let streamId;
  try {
    streamId = await streamIdPromise;
  } catch (e) {
    console.error("no stream id for this tab:", e.message);
    await setBadge("ERR", "#c00000");
    return;
  }

  await ensureOffscreen();
  const result = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "start",
    streamId,
    tabTitle: tab.title,
  });

  if (result?.ok) {
    await setCapturing(true);
    await setBadge("REC", "#c00000");
    return;
  }

  console.error("capture did not start:", result?.error);
  await setBadge("ERR", "#c00000");
  if (String(result?.error).includes("NotAllowedError")) openPermissionPage();
});

async function stopCapture() {
  try {
    await chrome.runtime.sendMessage({ target: "offscreen", type: "stop" });
  } catch (e) {
    // No offscreen document: nothing runs, so there is nothing to stop.
  }
  await setCapturing(false);
  await setBadge("");
}

// The offscreen document reports frame counts once per second and tells us
// when the capture ended on its own (tab closed, server gone).
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== "background") return;
  if (msg.type === "stats") {
    // Frames per second over both channels. 100 means both sources are live.
    setBadge(String(msg.me + msg.them));
  } else if (msg.type === "ended") {
    setCapturing(false);
    setBadge(msg.reason === "server" ? "ERR" : "", "#c00000");
  }
});
