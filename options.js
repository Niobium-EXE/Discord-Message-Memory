const DEFAULTS = {
  rememberingEnabled: true,
  showingEnabled: true,
  quickCss: "",
  hookStatus: null
};

const rememberToggle = document.getElementById("rememberingEnabled");
const showingToggle = document.getElementById("showingEnabled");
const quickCss = document.getElementById("quickCss");
const cssStatus = document.getElementById("cssStatus");
const chatList = document.getElementById("chatList");
const chatSearch = document.getElementById("chatSearch");
const confirmDialog = document.getElementById("confirmDialog");
const confirmTitle = document.getElementById("confirmTitle");
const confirmBody = document.getElementById("confirmBody");
const confirmButton = document.getElementById("confirmButton");
const hookPill = document.getElementById("hookPill");

let chats = [];
let cssSaveTimer = null;

function sendBackground(message) {
  return chrome.runtime.sendMessage(message);
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(Number(value || 0));
}

function updateHookStatus(status) {
  hookPill.classList.remove("connected", "error");
  const fresh = status?.updatedAt && Date.now() - status.updatedAt < 90_000;
  if (fresh && status.connected) {
    hookPill.classList.add("connected");
    hookPill.textContent = "Discord hook connected";
  } else if (fresh && status.error) {
    hookPill.classList.add("error");
    hookPill.textContent = "Discord hook error";
    hookPill.title = status.error;
  } else {
    hookPill.textContent = "Discord hook waiting";
    hookPill.title = "Open or reload a Discord tab to connect.";
  }
}

async function loadSettings() {
  const data = await chrome.storage.local.get(DEFAULTS);
  rememberToggle.checked = Boolean(data.rememberingEnabled);
  showingToggle.checked = Boolean(data.showingEnabled);
  quickCss.value = data.quickCss || "";
  updateHookStatus(data.hookStatus);
}

async function loadStats() {
  const stats = await sendBackground({ type: "DMH_GET_STATS" });
  if (!stats || stats.ok === false) return;
  document.getElementById("messageCount").textContent = formatNumber(stats.messageCount);
  document.getElementById("channelCount").textContent = formatNumber(stats.channelCount);
  document.getElementById("mediaCount").textContent = formatNumber(stats.mediaCount);
  document.getElementById("mediaBytes").textContent = formatBytes(stats.mediaBytes);
}

function displayChatName(chat) {
  if (chat.channelName && chat.guildName) return `${chat.guildName} / ${chat.channelName}`;
  if (chat.channelName) return chat.channelName;
  if (chat.scope === "dm") return `Direct Message ${chat.channelId}`;
  if (chat.scope === "group_dm") return `Group DM ${chat.channelId}`;
  if (chat.scope === "private") return `DM / Group DM ${chat.channelId}`;
  return `Channel ${chat.channelId}`;
}

function displayChatKind(chat) {
  if (chat.scope === "dm") return "direct message";
  if (chat.scope === "group_dm") return "group DM";
  if (chat.scope === "private") return "DM / group DM";
  if (chat.scope === "server" || chat.guildId) return "server channel";
  return "saved chat";
}

function renderChats() {
  const query = chatSearch.value.trim().toLowerCase();
  const filtered = chats.filter(chat => {
    const haystack = [chat.channelName, chat.guildName, chat.channelId, chat.guildId].filter(Boolean).join(" ").toLowerCase();
    return !query || haystack.includes(query);
  });

  chatList.textContent = "";
  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = chats.length ? "No saved chats match that search." : "No Discord messages have been saved yet.";
    chatList.appendChild(empty);
    return;
  }

  for (const chat of filtered) {
    const row = document.createElement("div");
    row.className = "chat-row";

    const info = document.createElement("div");
    const title = document.createElement("div");
    title.className = "chat-title";
    const name = document.createElement("strong");
    name.textContent = displayChatName(chat);
    title.appendChild(name);
    const kind = document.createElement("span");
    kind.textContent = displayChatKind(chat);
    title.appendChild(kind);
    info.appendChild(title);

    const meta = document.createElement("div");
    meta.className = "chat-meta";
    meta.textContent = `${formatNumber(chat.messageCount)} messages · ${formatNumber(chat.deletedCount)} deleted · ${formatNumber(chat.editedCount)} edited · ${formatBytes(chat.mediaBytes)} files`;
    info.appendChild(meta);

    const id = document.createElement("div");
    id.className = "chat-id";
    id.textContent = `Channel ID: ${chat.channelId}`;
    info.appendChild(id);
    row.appendChild(info);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "danger-button";
    button.textContent = "Delete";
    button.addEventListener("click", async () => {
      const accepted = await showConfirm(
        "Delete this chat's saved data?",
        `${displayChatName(chat)}\n\nThis removes its saved messages, edit history, deleted-message records, and cached attachments. This cannot be undone.`,
        "Delete chat data"
      );
      if (!accepted) return;
      button.disabled = true;
      await sendBackground({ type: "DMH_DELETE_CHAT", channelId: chat.channelId });
      await Promise.all([loadChats(), loadStats()]);
    });
    row.appendChild(button);
    chatList.appendChild(row);
  }
}

async function loadChats() {
  chatList.innerHTML = '<div class="empty-state">Loading saved chats…</div>';
  const result = await sendBackground({ type: "DMH_LIST_CHATS" });
  chats = Array.isArray(result) ? result : [];
  renderChats();
}

function showConfirm(title, body, buttonText) {
  confirmTitle.textContent = title;
  confirmBody.textContent = body;
  confirmButton.textContent = buttonText;
  confirmDialog.showModal();
  return new Promise(resolve => {
    confirmDialog.addEventListener("close", () => resolve(confirmDialog.returnValue === "confirm"), { once: true });
  });
}

function saveCssNow() {
  clearTimeout(cssSaveTimer);
  cssStatus.textContent = "Saving…";
  cssStatus.className = "saving";
  chrome.storage.local.set({ quickCss: quickCss.value }).then(() => {
    cssStatus.textContent = "Saved";
    cssStatus.className = "saved";
  });
}

rememberToggle.addEventListener("change", () => {
  chrome.storage.local.set({ rememberingEnabled: rememberToggle.checked });
});

showingToggle.addEventListener("change", () => {
  chrome.storage.local.set({ showingEnabled: showingToggle.checked });
});

quickCss.addEventListener("input", () => {
  cssStatus.textContent = "Unsaved";
  cssStatus.className = "saving";
  clearTimeout(cssSaveTimer);
  cssSaveTimer = setTimeout(saveCssNow, 250);
});

quickCss.addEventListener("keydown", event => {
  if (event.key === "Tab") {
    event.preventDefault();
    const start = quickCss.selectionStart;
    const end = quickCss.selectionEnd;
    quickCss.setRangeText("  ", start, end, "end");
    quickCss.dispatchEvent(new Event("input"));
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    saveCssNow();
  }
});

document.getElementById("resetCss").addEventListener("click", async () => {
  if (!quickCss.value) return;
  const accepted = await showConfirm("Clear Live CSS?", "This removes the custom CSS currently applied to Discord.", "Clear CSS");
  if (!accepted) return;
  quickCss.value = "";
  saveCssNow();
});

document.getElementById("deleteAll").addEventListener("click", async () => {
  const accepted = await showConfirm(
    "Delete all saved Discord data?",
    "This permanently deletes every saved message, edit history, deleted-message record, and cached attachment stored by this extension. Your two on/off settings and Live CSS are kept.",
    "Delete everything"
  );
  if (!accepted) return;
  const button = document.getElementById("deleteAll");
  button.disabled = true;
  await sendBackground({ type: "DMH_DELETE_ALL" });
  button.disabled = false;
  await Promise.all([loadChats(), loadStats()]);
});

document.getElementById("refreshChats").addEventListener("click", () => Promise.all([loadChats(), loadStats()]));
chatSearch.addEventListener("input", renderChats);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.hookStatus) updateHookStatus(changes.hookStatus.newValue);
  if (changes.rememberingEnabled) rememberToggle.checked = Boolean(changes.rememberingEnabled.newValue);
  if (changes.showingEnabled) showingToggle.checked = Boolean(changes.showingEnabled.newValue);
});

(async () => {
  await loadSettings();
  await Promise.all([loadChats(), loadStats()]);
})();
