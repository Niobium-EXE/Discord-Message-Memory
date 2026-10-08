const DEFAULTS = {
  rememberingEnabled: true,
  showingEnabled: true
};

const remember = document.getElementById("rememberingEnabled");
const showing = document.getElementById("showingEnabled");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const autoScrollButton = document.getElementById("autoScrollHistory");
const autoScrollStatus = document.getElementById("autoScrollStatus");

async function sendToActiveDiscordTab(message) {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs?.[0];
  if (!tab?.id) throw new Error("No active tab.");
  return chrome.tabs.sendMessage(tab.id, message);
}

function renderAutoScrollState(result) {
  const active = Boolean(result?.active);
  autoScrollButton.classList.toggle("active", active);
  autoScrollButton.textContent = active ? "Stop" : "Auto-scroll";
  if (active) {
    autoScrollStatus.textContent = result?.atTop
      ? "At the top; waiting for Discord to load older messages…"
      : "Scrolling upward slowly. You can close this popup.";
  } else if (result?.reason === "reached-top") {
    autoScrollStatus.textContent = "Reached the oldest history Discord loaded.";
  } else {
    autoScrollStatus.textContent = "Slowly scroll upward through the open chat.";
  }
}

async function refreshAutoScrollState() {
  try {
    const result = await sendToActiveDiscordTab({ type: "DMH_GET_AUTO_SCROLL_STATUS" });
    renderAutoScrollState(result);
  } catch {
    autoScrollButton.classList.remove("active");
    autoScrollButton.textContent = "Auto-scroll";
    autoScrollStatus.textContent = "Open a Discord chat to use auto-scroll.";
  }
}

async function init() {
  const data = await chrome.storage.local.get({ ...DEFAULTS, hookStatus: null });
  remember.checked = Boolean(data.rememberingEnabled);
  showing.checked = Boolean(data.showingEnabled);

  const status = data.hookStatus;
  const fresh = status?.updatedAt && Date.now() - status.updatedAt < 90_000;
  statusDot.classList.remove("connected", "error");

  if (fresh && status.connected) {
    statusDot.classList.add("connected");
    const method = status.hookMethod ? ` via ${status.hookMethod}` : "";
    statusText.textContent = `Connected to Discord's message event layer${method}.`;
  } else if (fresh && status.error) {
    statusDot.classList.add("error");
    statusText.textContent = `Discord hook error: ${status.error}`;
  } else if (fresh && status.webpackFound) {
    statusText.textContent = `Discord runtime found via ${status.webpackCaptureMethod || "runtime capture"}; waiting for MessageStore/dispatcher.`;
  } else if (fresh && status.runtimeSnifferInstalled) {
    statusText.textContent = "Runtime hook installed; waiting for Discord's Webpack runtime. Reload this Discord tab once.";
  } else {
    statusText.textContent = "Open or reload Discord to connect the message event hook.";
  }

  await refreshAutoScrollState();
}

remember.addEventListener("change", () => {
  chrome.storage.local.set({ rememberingEnabled: remember.checked });
});

showing.addEventListener("change", () => {
  chrome.storage.local.set({ showingEnabled: showing.checked });
});

autoScrollButton.addEventListener("click", async () => {
  autoScrollButton.disabled = true;
  try {
    const result = await sendToActiveDiscordTab({ type: "DMH_TOGGLE_AUTO_SCROLL" });
    if (result?.ok === false) {
      autoScrollButton.classList.remove("active");
      autoScrollButton.textContent = "Auto-scroll";
      autoScrollStatus.textContent = result.error || "Could not start auto-scroll in this chat.";
    } else {
      renderAutoScrollState(result);
    }
  } catch {
    autoScrollStatus.textContent = "Open a Discord chat to use auto-scroll.";
  } finally {
    autoScrollButton.disabled = false;
  }
});

document.getElementById("openSettings").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

init();
