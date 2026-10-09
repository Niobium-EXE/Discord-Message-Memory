const DEFAULTS = {
  rememberingEnabled: true,
  showingEnabled: true,
  checkForUpdatesEnabled: false,
  packedUpdateStatus: null,
  historyAutoScrollSpeed: 90
};

const remember = document.getElementById("rememberingEnabled");
const showing = document.getElementById("showingEnabled");
const checkForUpdatesToggle = document.getElementById("checkForUpdatesEnabled");
const applyPackedUpdateButton = document.getElementById("applyPackedUpdate");
const packedUpdateStatus = document.getElementById("packedUpdateStatus");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const autoScrollButton = document.getElementById("autoScrollHistory");
const autoScrollStatus = document.getElementById("autoScrollStatus");
const historyAutoScrollSpeed = document.getElementById("historyAutoScrollSpeed");
const historyAutoScrollSpeedValue = document.getElementById("historyAutoScrollSpeedValue");

function displayHistoryAutoScrollSpeed(raw) {
  const value = Math.min(300, Math.max(20, Math.round((Number(raw) || 90) / 10) * 10));
  historyAutoScrollSpeed.value = String(value);
  historyAutoScrollSpeedValue.textContent = `${value} px/s`;
}



function renderPackedUpdateStatus(enabled, status) {
  checkForUpdatesToggle.checked = Boolean(enabled);
  packedUpdateStatus.classList.remove("update-ok", "update-warn", "update-error");
  const installedVersion = chrome.runtime.getManifest().version;
  const ready = Boolean(status?.updateAvailable && status?.installedVersion === installedVersion);
  applyPackedUpdateButton.disabled = !ready || status?.state === "applying";
  applyPackedUpdateButton.textContent = status?.state === "applying" ? "Applying…" : status?.applyMode === "manual" ? "Get update" : "Apply update";

  if (status?.state === "applying") {
    packedUpdateStatus.classList.add("update-warn");
    packedUpdateStatus.textContent = "Applying packed update…";
  } else if (ready) {
    packedUpdateStatus.classList.add("update-warn");
    packedUpdateStatus.textContent = status.applyMode === "manual"
      ? `v${status.remoteVersion || "new"} on GitHub · manual download`
      : `v${status.remoteVersion || "new"} ready · click Apply update`;
  } else if (status?.ok === false) {
    packedUpdateStatus.classList.add("update-error");
    packedUpdateStatus.textContent = status.message || "Update check failed.";
  } else if (status?.state === "throttled") {
    packedUpdateStatus.textContent = "Browser check throttled · try later.";
  } else {
    packedUpdateStatus.classList.add("update-ok");
    packedUpdateStatus.textContent = enabled ? `v${installedVersion} · checking enabled` : `v${installedVersion} · checks off`;
  }
}

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
  renderPackedUpdateStatus(Boolean(data.checkForUpdatesEnabled), data.packedUpdateStatus);
  displayHistoryAutoScrollSpeed(data.historyAutoScrollSpeed);

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

checkForUpdatesToggle.addEventListener("change", async () => {
  const enabled = checkForUpdatesToggle.checked;
  await chrome.storage.local.set({ checkForUpdatesEnabled: enabled });
  const data = await chrome.storage.local.get(DEFAULTS);
  renderPackedUpdateStatus(enabled, data.packedUpdateStatus);
});

applyPackedUpdateButton.addEventListener("click", async () => {
  applyPackedUpdateButton.disabled = true;
  applyPackedUpdateButton.textContent = "Applying…";
  try {
    const result = await chrome.runtime.sendMessage({ type: "DMH_APPLY_PACKED_UPDATE" });
    if (result?.ok && result?.applyMode === "manual") {
      const data = await chrome.storage.local.get(DEFAULTS);
      renderPackedUpdateStatus(Boolean(data.checkForUpdatesEnabled), result);
      packedUpdateStatus.textContent = "Opened GitHub Release. Install from there manually.";
    } else if (!result?.ok) {
      packedUpdateStatus.classList.add("update-error");
      packedUpdateStatus.textContent = result?.message || result?.error || "No update is ready yet.";
      const data = await chrome.storage.local.get(DEFAULTS);
      renderPackedUpdateStatus(Boolean(data.checkForUpdatesEnabled), data.packedUpdateStatus);
    }
  } catch (error) {
    packedUpdateStatus.classList.add("update-error");
    packedUpdateStatus.textContent = String(error?.message || error);
  }
});

remember.addEventListener("change", () => {
  chrome.storage.local.set({ rememberingEnabled: remember.checked });
});

showing.addEventListener("change", () => {
  chrome.storage.local.set({ showingEnabled: showing.checked });
});

historyAutoScrollSpeed.addEventListener("input", () => {
  displayHistoryAutoScrollSpeed(historyAutoScrollSpeed.value);
  chrome.storage.local.set({ historyAutoScrollSpeed: Number(historyAutoScrollSpeed.value) });
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

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.historyAutoScrollSpeed) displayHistoryAutoScrollSpeed(changes.historyAutoScrollSpeed.newValue);
  if (changes.checkForUpdatesEnabled || changes.packedUpdateStatus) {
    chrome.storage.local.get(DEFAULTS).then(data => {
      renderPackedUpdateStatus(Boolean(data.checkForUpdatesEnabled), data.packedUpdateStatus);
    }).catch(() => {});
  }
});

init();
