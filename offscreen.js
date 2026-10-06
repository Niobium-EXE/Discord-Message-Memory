(() => {
  "use strict";

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "DMH_OFFSCREEN_PLAY") return;
    const dataUrl = String(message.dataUrl || "");
    const volume = Math.max(0, Math.min(1, Number(message.volume ?? 1)));
    if (!dataUrl) {
      sendResponse({ ok: false, error: "No custom sound is configured." });
      return;
    }

    try {
      const audio = new Audio(dataUrl);
      audio.volume = volume;
      audio.preload = "auto";
      const cleanup = () => {
        try { audio.pause(); } catch {}
        audio.removeAttribute("src");
        try { audio.load(); } catch {}
      };
      audio.addEventListener("ended", cleanup, { once: true });
      audio.addEventListener("error", cleanup, { once: true });
      Promise.resolve(audio.play()).then(() => {
        sendResponse({ ok: true });
      }).catch(error => {
        cleanup();
        sendResponse({ ok: false, error: String(error?.message || error) });
      });
      return true;
    } catch (error) {
      sendResponse({ ok: false, error: String(error?.message || error) });
    }
  });
})();
