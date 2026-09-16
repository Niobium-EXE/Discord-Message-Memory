"use strict";

const activeAudio = new Set();

async function playProvidedSound(dataUrl, volume = 1) {
  // FileReader can produce application/octet-stream for some otherwise valid
  // audio files when the OS/browser does not provide a MIME type. Let the
  // browser's media decoder decide whether the selected data URL is playable.
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
    return { ok: false, reason: "not-configured" };
  }

  try {
    const audio = new Audio();
    audio.preload = "auto";
    audio.volume = Math.max(0, Math.min(1, Number(volume ?? 1)));
    audio.src = dataUrl;
    activeAudio.add(audio);

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      activeAudio.delete(audio);
      try {
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
      } catch {}
    };

    audio.addEventListener("ended", cleanup, { once: true });
    audio.addEventListener("error", cleanup, { once: true });

    await audio.play();
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: String(error?.message || error) };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "dmh-offscreen-audio" || message?.type !== "PLAY_CUSTOM_NOTIFICATION") return false;
  playProvidedSound(message?.dataUrl, message?.volume)
    .then(sendResponse)
    .catch(error => sendResponse({ ok: false, reason: String(error?.message || error) }));
  return true;
});
