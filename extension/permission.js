const status = document.getElementById("status");

document.getElementById("grant").addEventListener("click", async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    status.textContent =
      "Granted. Close this tab, open a Meet tab, and click the extension icon to start.";
  } catch (e) {
    status.textContent = `Not granted: ${e.name}. Check chrome://settings/content/microphone.`;
  }
});
