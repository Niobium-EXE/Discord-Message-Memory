const DEFAULTS = {
  rememberingEnabled: true,
  showingEnabled: true
};

const remember = document.getElementById("rememberingEnabled");
const showing = document.getElementById("showingEnabled");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");

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
}

remember.addEventListener("change", () => {
  chrome.storage.local.set({ rememberingEnabled: remember.checked });
});

showing.addEventListener("change", () => {
  chrome.storage.local.set({ showingEnabled: showing.checked });
});

document.getElementById("openSettings").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

init();
