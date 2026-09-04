const DEFAULTS = {
  rememberingEnabled: true,
  showingEnabled: true,
  quickCss: "",
  hookStatus: null,
  sidebarCollapsed: false
};

const EXPORT_DB_NAME = "discord-message-memory";
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
const appShell = document.querySelector(".app-shell");
const sidebarToggle = document.getElementById("sidebarToggle");

const exportDialog = document.getElementById("exportDialog");
const exportTitle = document.getElementById("exportTitle");
const exportSubtitle = document.getElementById("exportSubtitle");
const startExportButton = document.getElementById("startExport");
const exportProgress = document.getElementById("exportProgress");
const exportProgressText = document.getElementById("exportProgressText");
const exportProgressPercent = document.getElementById("exportProgressPercent");
const exportProgressBar = document.getElementById("exportProgressBar");
const exportWarning = document.getElementById("exportWarning");

let chats = [];
let cssSaveTimer = null;
let currentExportChat = null;
let exportRunning = false;
let exportDbPromise = null;

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

function applySidebarState(collapsed) {
  appShell.classList.toggle("sidebar-collapsed", Boolean(collapsed));
  sidebarToggle.setAttribute("aria-label", collapsed ? "Expand settings sidebar" : "Collapse settings sidebar");
  sidebarToggle.title = collapsed ? "Expand sidebar" : "Collapse sidebar";
}

async function loadSettings() {
  const data = await chrome.storage.local.get(DEFAULTS);
  rememberToggle.checked = Boolean(data.rememberingEnabled);
  showingToggle.checked = Boolean(data.showingEnabled);
  quickCss.value = data.quickCss || "";
  applySidebarState(Boolean(data.sidebarCollapsed));
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
  if (chat.isThread || [10, 11, 12].includes(Number(chat.channelType))) return "thread";
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

    const actions = document.createElement("div");
    actions.className = "chat-actions";

    const exportButton = document.createElement("button");
    exportButton.type = "button";
    exportButton.className = "secondary-button export-button";
    exportButton.textContent = "Export";
    exportButton.addEventListener("click", () => openExportDialog(chat));
    actions.appendChild(exportButton);

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "danger-button";
    deleteButton.textContent = "Delete";
    deleteButton.addEventListener("click", async () => {
      const accepted = await showConfirm(
        "Delete this chat's saved data?",
        `${displayChatName(chat)}\n\nThis removes its saved messages, edit history, deleted-message records, and cached attachments. This cannot be undone.`,
        "Delete chat data"
      );
      if (!accepted) return;
      deleteButton.disabled = true;
      await sendBackground({ type: "DMH_DELETE_CHAT", channelId: chat.channelId });
      await Promise.all([loadChats(), loadStats()]);
    });
    actions.appendChild(deleteButton);

    row.appendChild(actions);
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

/* --------------------------- Built-in exporter --------------------------- */

function openExportDb() {
  if (exportDbPromise) return exportDbPromise;
  exportDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(EXPORT_DB_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open Message Memory storage."));
  });
  return exportDbPromise;
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed."));
  });
}

function compareSnowflakes(a, b) {
  const aa = String(a || "");
  const bb = String(b || "");
  if (aa.length !== bb.length) return aa.length - bb.length;
  return aa.localeCompare(bb);
}

async function getSavedChannelMessages(channelId) {
  const db = await openExportDb();
  const tx = db.transaction("messages", "readonly");
  const index = tx.objectStore("messages").index("channelId");
  const records = await idbRequest(index.getAll(IDBKeyRange.only(String(channelId))));
  return records.sort((a, b) => compareSnowflakes(a.id, b.id));
}

async function getSavedChannels() {
  const db = await openExportDb();
  const tx = db.transaction("channels", "readonly");
  return idbRequest(tx.objectStore("channels").getAll());
}

async function getMediaItem(key) {
  if (!key) return null;
  const db = await openExportDb();
  const tx = db.transaction("media", "readonly");
  return idbRequest(tx.objectStore("media").get(key));
}

function attachmentMediaKey(message, attachment, index) {
  return attachment?._dmhMediaKey || `${message.channelId}:${message.id}:${attachment?.id || index}`;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Could not read cached file."));
    reader.readAsDataURL(blob);
  });
}

function attachmentKind(attachment) {
  const type = String(attachment?.contentType || attachment?.content_type || "").toLowerCase();
  const name = String(attachment?.filename || "").toLowerCase();
  if (type.startsWith("image/") || /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(name)) return "image";
  if (type.startsWith("video/") || /\.(mp4|webm|mov|m4v)$/i.test(name)) return "video";
  if (type.startsWith("audio/") || /\.(mp3|wav|ogg|m4a|flac|aac)$/i.test(name)) return "audio";
  return "file";
}

function shouldEmbedAttachment(attachment, options) {
  const kind = attachmentKind(attachment);
  if (kind === "image") return options.images;
  if (kind === "video" || kind === "audio") return options.media;
  return options.files;
}

function setExportProgress(done, total, text) {
  const safeTotal = Math.max(1, total);
  const percent = Math.max(0, Math.min(100, Math.round((done / safeTotal) * 100)));
  exportProgress.hidden = false;
  exportProgressText.textContent = text;
  exportProgressPercent.textContent = `${percent}%`;
  exportProgressBar.style.width = `${percent}%`;
}

function resetExportProgress() {
  exportProgress.hidden = true;
  exportProgressText.textContent = "Preparing export…";
  exportProgressPercent.textContent = "";
  exportProgressBar.style.width = "0%";
  exportWarning.hidden = true;
  exportWarning.textContent = "";
}

function openExportDialog(chat) {
  currentExportChat = chat;
  exportTitle.textContent = `Export ${displayChatName(chat)}`;
  exportSubtitle.textContent = `${formatNumber(chat.messageCount)} saved messages · ${formatBytes(chat.mediaBytes)} cached attachments`;
  resetExportProgress();
  startExportButton.disabled = false;
  startExportButton.textContent = "Export HTML";
  exportDialog.showModal();
}

function getExportOptions() {
  return {
    deleted: document.getElementById("exportDeleted").checked,
    edits: document.getElementById("exportEdits").checked,
    images: document.getElementById("exportImages").checked,
    media: document.getElementById("exportMedia").checked,
    files: document.getElementById("exportFiles").checked,
    threads: document.getElementById("exportThreads").checked
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.startsWith("data:")) return raw;
  try {
    const url = new URL(raw);
    return ["http:", "https:"].includes(url.protocol) ? raw : "";
  } catch {
    return "";
  }
}

function linkifyText(value) {
  const raw = String(value ?? "");
  const regex = /https?:\/\/[^\s<]+/g;
  let out = "";
  let lastIndex = 0;
  let match;
  const addText = text => escapeHtml(text).replace(/\n/g, "<br>");
  while ((match = regex.exec(raw))) {
    out += addText(raw.slice(lastIndex, match.index));
    const full = match[0];
    const clean = full.replace(/[),.!?;:]+$/g, "");
    const tail = full.slice(clean.length);
    out += `<a href="${escapeHtml(clean)}" target="_blank" rel="noreferrer">${escapeHtml(clean)}</a>${addText(tail)}`;
    lastIndex = match.index + full.length;
  }
  out += addText(raw.slice(lastIndex));
  return out;
}

function exportAuthorName(record) {
  return record?.author?.globalName || record?.author?.global_name || record?.author?.username || "Unknown user";
}

function formatExportTime(value, fallbackSnowflake) {
  let date = value ? new Date(value) : null;
  if ((!date || Number.isNaN(date.getTime())) && fallbackSnowflake) {
    try {
      date = new Date(Number((BigInt(String(fallbackSnowflake)) >> 22n) + 1420070400000n));
    } catch {}
  }
  if (!date || Number.isNaN(date.getTime())) return "Unknown time";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit"
  }).format(date);
}

function sanitizeFilename(value) {
  const clean = String(value || "Discord chat")
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 130);
  return clean || "Discord chat";
}

function renderReply(record) {
  const reply = record?.referencedMessage;
  if (!reply) return "";
  const author = reply.author?.globalName || reply.author?.global_name || reply.author?.username || "Unknown user";
  const content = reply.content || "Attachment or unavailable message";
  return `<div class="reply"><span>${escapeHtml(author)}</span>${linkifyText(String(content).slice(0, 240))}</div>`;
}

function renderEditHistory(record, options) {
  if (!options.edits || !Array.isArray(record.editHistory) || !record.editHistory.length) return "";
  return `<div class="edit-history">${record.editHistory.map(edit => {
    const text = edit.content || (Array.isArray(edit.attachments) && edit.attachments.length ? "[attachment changed]" : "[empty message]");
    return `<div class="edit-version"><div class="edit-version-content">${linkifyText(text)}</div><div class="edit-version-time">${escapeHtml(formatExportTime(edit.editedAt || edit.capturedAt))}</div></div>`;
  }).join("")}</div>`;
}

function renderEmbed(embed) {
  if (!embed || typeof embed !== "object") return "";
  const title = embed.title ? `<div class="embed-title">${escapeHtml(embed.title)}</div>` : "";
  const desc = embed.description ? `<div class="embed-description">${linkifyText(embed.description)}</div>` : "";
  const fields = Array.isArray(embed.fields) ? embed.fields.map(field => `<div class="embed-field"><strong>${escapeHtml(field?.name || "")}</strong><div>${linkifyText(field?.value || "")}</div></div>`).join("") : "";
  const imageUrl = safeUrl(embed.image?.url || embed.thumbnail?.url || "");
  const image = imageUrl ? `<img class="embed-image" src="${escapeHtml(imageUrl)}" alt="Embedded media" loading="lazy">` : "";
  if (!title && !desc && !fields && !image) return "";
  return `<div class="embed">${title}${desc}${fields ? `<div class="embed-fields">${fields}</div>` : ""}${image}</div>`;
}

function renderPoll(poll) {
  if (!poll || typeof poll !== "object") return "";
  const question = poll.question?.text || poll.question || "Poll";
  const answers = Array.isArray(poll.answers) ? poll.answers.map(answer => {
    const text = answer?.poll_media?.text || answer?.pollMedia?.text || answer?.text || "Answer";
    return `<li>${escapeHtml(text)}</li>`;
  }).join("") : "";
  return `<div class="poll"><strong>${escapeHtml(question)}</strong>${answers ? `<ul>${answers}</ul>` : ""}</div>`;
}

function renderReactions(reactions) {
  if (!Array.isArray(reactions) || !reactions.length) return "";
  const pills = reactions.map(reaction => {
    const emoji = reaction?.emoji?.name || reaction?.emoji?.id || "reaction";
    const count = reaction?.count || 1;
    return `<span class="reaction">${escapeHtml(emoji)} <b>${escapeHtml(count)}</b></span>`;
  }).join("");
  return `<div class="reactions">${pills}</div>`;
}

function renderAttachments(record, mediaMap) {
  const attachments = Array.isArray(record.attachments) ? record.attachments : [];
  if (!attachments.length) return "";
  return `<div class="attachments">${attachments.map((attachment, index) => {
    const key = attachmentMediaKey(record, attachment, index);
    const embedded = mediaMap.get(key) || "";
    const external = safeUrl(attachment.url || attachment.proxyUrl || attachment.proxy_url || "");
    const src = embedded || external;
    const kind = attachmentKind(attachment);
    const filename = attachment.filename || "attachment";
    const size = formatBytes(attachment.size || 0);
    const linkedBadge = !embedded && external ? '<span class="attachment-source">Discord link</span>' : "";
    if (kind === "image" && src) {
      return `<figure class="attachment image-attachment"><a href="${escapeHtml(src)}" target="_blank"><img src="${escapeHtml(src)}" alt="${escapeHtml(filename)}" loading="lazy"></a><figcaption>${escapeHtml(filename)}${size ? ` · ${escapeHtml(size)}` : ""}${linkedBadge}</figcaption></figure>`;
    }
    if (kind === "video" && src) {
      return `<div class="attachment media-attachment"><video controls preload="metadata" src="${escapeHtml(src)}"></video><div>${escapeHtml(filename)}${size ? ` · ${escapeHtml(size)}` : ""}${linkedBadge}</div></div>`;
    }
    if (kind === "audio" && src) {
      return `<div class="attachment audio-attachment"><div class="file-name">${escapeHtml(filename)}${size ? ` · ${escapeHtml(size)}` : ""}${linkedBadge}</div><audio controls preload="metadata" src="${escapeHtml(src)}"></audio></div>`;
    }
    if (src) {
      return `<a class="attachment file-attachment" href="${escapeHtml(src)}" ${embedded ? `download="${escapeHtml(filename)}"` : 'target="_blank" rel="noreferrer"'}><span class="file-icon">FILE</span><span><strong>${escapeHtml(filename)}</strong><small>${escapeHtml(size || "Attachment")}${linkedBadge}</small></span></a>`;
    }
    return `<div class="attachment file-attachment unavailable"><span class="file-icon">FILE</span><span><strong>${escapeHtml(filename)}</strong><small>${escapeHtml(size || "Attachment")} · cached file unavailable</small></span></div>`;
  }).join("")}</div>`;
}

function renderThreadButton(record, threadMap) {
  let threadId = record?.thread?.id ? String(record.thread.id) : null;
  if (!threadId && threadMap.has(String(record.id))) threadId = String(record.id);
  if (!threadId || !threadMap.has(threadId)) return "";
  const thread = threadMap.get(threadId);
  const name = thread.meta.channelName || record.thread?.name || "Thread";
  return `<button class="thread-button" type="button" data-thread-open="${escapeHtml(threadId)}"><span>Thread</span>${escapeHtml(name)}<b>${formatNumber(thread.messages.length)}</b></button>`;
}

function renderMessage(record, options, mediaMap, threadMap = new Map()) {
  if (record.deleted && !options.deleted) return "";
  const edited = Array.isArray(record.editHistory) && record.editHistory.length;
  const editedVisible = Boolean(options.edits && edited);
  const classes = ["message", record.deleted ? "deleted" : "", editedVisible ? "edited" : ""].filter(Boolean).join(" ");
  const author = exportAuthorName(record);
  const initials = author.split(/\s+/).map(part => part[0]).join("").slice(0, 2).toUpperCase() || "?";
  const status = `${record.deleted ? '<span class="status deleted-status">DELETED</span>' : ""}${editedVisible ? '<span class="status edited-status">EDITED</span>' : ""}`;
  const bodyText = record.content ? linkifyText(record.content) : "";
  const emptyNotice = !record.content && !record.attachments?.length && !record.embeds?.length ? '<span class="empty-message">[empty or unavailable message]</span>' : "";
  const embeds = Array.isArray(record.embeds) ? record.embeds.map(renderEmbed).join("") : "";
  const stickers = Array.isArray(record.stickers) && record.stickers.length ? `<div class="stickers">${record.stickers.map(sticker => `<span>Sticker: ${escapeHtml(sticker?.name || sticker?.id || "sticker")}</span>`).join("")}</div>` : "";
  return `<article class="${classes}" id="message-${escapeHtml(record.id)}">
    <div class="avatar">${escapeHtml(initials)}</div>
    <div class="message-main">
      <div class="message-header"><strong>${escapeHtml(author)}</strong><time>${escapeHtml(formatExportTime(record.timestamp, record.id))}</time><div class="statuses">${status}</div></div>
      ${renderReply(record)}
      ${renderEditHistory(record, options)}
      <div class="message-content">${bodyText}${emptyNotice}</div>
      ${renderAttachments(record, mediaMap)}
      ${embeds}
      ${stickers}
      ${renderPoll(record.poll)}
      ${renderReactions(record.reactions)}
      ${renderThreadButton(record, threadMap)}
    </div>
  </article>`;
}

function renderThreadPanels(threads, options, mediaMap) {
  if (!threads.length) return "";
  return threads.map(thread => {
    const body = thread.messages.map(record => renderMessage(record, options, mediaMap, new Map())).join("") || '<div class="thread-empty">No saved messages in this thread.</div>';
    return `<section class="thread-panel" data-thread-panel="${escapeHtml(thread.meta.channelId)}" hidden>
      <div class="thread-panel-title"><span>THREAD</span><strong>${escapeHtml(thread.meta.channelName || `Thread ${thread.meta.channelId}`)}</strong><small>${formatNumber(thread.messages.length)} saved messages</small></div>
      <div class="thread-messages">${body}</div>
    </section>`;
  }).join("");
}

function exportDocumentCss() {
  return `
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0b0d10;color:#dbdee1}*{box-sizing:border-box}html,body{margin:0;min-height:100%;background:#0b0d10;color:#dbdee1}body{overflow-x:hidden}a{color:#00a8fc;text-decoration:none}a:hover{text-decoration:underline}.topbar{position:sticky;top:0;z-index:20;display:flex;justify-content:space-between;gap:24px;align-items:center;padding:18px 24px;border-bottom:1px solid #23262d;background:rgba(11,13,16,.94);backdrop-filter:blur(16px)}.topbar h1{margin:0;color:#f2f3f5;font-size:18px}.topbar p{margin:4px 0 0;color:#8a919b;font-size:11px}.export-meta{color:#7e8590;font-size:10px;text-align:right}.layout{max-width:1050px;margin:0 auto;padding:18px 20px 70px}.thread-index{display:flex;flex-wrap:wrap;gap:7px;margin:0 0 14px;padding:12px;border:1px solid #262a31;border-radius:9px;background:#111318}.thread-index button,.thread-button{border:1px solid #343943;border-radius:7px;background:#1a1d23;color:#d8dbe0;cursor:pointer}.thread-index button{padding:7px 9px;font-size:10px}.message{position:relative;display:grid;grid-template-columns:42px minmax(0,1fr);gap:10px;margin:2px 0;padding:8px 12px;border:1px solid transparent;border-radius:8px}.message:hover{background:#111318}.message.deleted{border-color:rgba(242,63,67,.72);background:linear-gradient(90deg,rgba(242,63,67,.08),rgba(242,63,67,.025))}.message.edited:not(.deleted){border-color:rgba(240,178,50,.7);background:linear-gradient(90deg,rgba(240,178,50,.075),rgba(240,178,50,.02))}.avatar{width:40px;height:40px;display:grid;place-items:center;border-radius:50%;background:#262b33;color:#f2f3f5;font-size:12px;font-weight:800}.message-main{min-width:0}.message-header{display:flex;align-items:baseline;gap:8px;min-height:20px}.message-header strong{color:#f2f3f5;font-size:14px}.message-header time{color:#777e88;font-size:10px}.statuses{display:flex;gap:4px;margin-left:auto}.status{display:inline-flex;padding:1px 5px;border:1px solid;border-radius:999px;font-size:8px;font-weight:800;letter-spacing:.05em}.deleted-status{border-color:rgba(242,63,67,.7);color:#ff6b70;background:rgba(242,63,67,.1)}.edited-status{border-color:rgba(240,178,50,.75);color:#f0b232;background:rgba(240,178,50,.09)}.message-content{font-size:14px;line-height:1.4;overflow-wrap:anywhere}.empty-message{color:#6f7680;font-style:italic}.reply{margin:0 0 4px;padding-left:9px;border-left:2px solid #4e545e;color:#8c939d;font-size:11px}.reply span{margin-right:6px;color:#b5bac1;font-weight:700}.edit-history{display:grid;gap:5px;margin:4px 0 6px}.edit-version{width:fit-content;max-width:100%;min-width:180px;padding:5px 9px;border:1px solid rgba(240,178,50,.28);border-left-width:2px;border-radius:6px;background:rgba(240,178,50,.035)}.edit-version-content{font-size:13px;line-height:1.35}.edit-version-time{margin-top:2px;color:#8d8b78;font-size:9px}.attachments{display:grid;gap:7px;margin-top:7px}.attachment{max-width:min(640px,100%)}.image-attachment{margin:0}.image-attachment img{display:block;max-width:100%;max-height:520px;border-radius:8px;border:1px solid #282c33;background:#08090b}.image-attachment figcaption,.media-attachment>div{margin-top:4px;color:#8c939d;font-size:10px}.media-attachment video{display:block;max-width:100%;max-height:520px;border-radius:8px;background:#050607}.audio-attachment{padding:8px 10px;border:1px solid #2d323a;border-radius:8px;background:#15181d}.audio-attachment audio{width:min(480px,100%);margin-top:6px}.file-attachment{display:flex;align-items:center;gap:10px;width:fit-content;min-width:260px;padding:9px 10px;border:1px solid #30353e;border-radius:8px;background:#171a20}.file-attachment:hover{text-decoration:none;background:#1c2027}.file-icon{display:grid;place-items:center;width:34px;height:38px;border-radius:5px;background:#5865f2;color:#fff;font-size:8px;font-weight:900}.file-attachment strong{display:block;color:#00a8fc;font-size:11px}.file-attachment small{display:block;margin-top:2px;color:#858c96;font-size:9px}.attachment-source{display:inline-block;margin-left:6px;color:#68707b;font-size:8px}.unavailable{opacity:.62}.embed{max-width:540px;margin-top:7px;padding:9px 11px;border-left:4px solid #4f545c;border-radius:4px;background:#17191e}.embed-title{font-size:13px;font-weight:700}.embed-description{margin-top:4px;font-size:12px;line-height:1.45}.embed-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:7px}.embed-field{font-size:10px}.embed-field strong{display:block;margin-bottom:2px}.embed-image{display:block;max-width:100%;max-height:360px;margin-top:8px;border-radius:5px}.poll{width:fit-content;max-width:500px;margin-top:7px;padding:9px 11px;border:1px solid #30353e;border-radius:8px;background:#15181d;font-size:11px}.poll ul{margin:5px 0 0;padding-left:18px}.reactions{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}.reaction{padding:2px 7px;border:1px solid #30353e;border-radius:999px;background:#191c21;font-size:10px}.stickers{margin-top:6px;color:#a8adb5;font-size:10px}.thread-button{display:flex;align-items:center;gap:7px;width:fit-content;margin-top:7px;padding:6px 8px;font-size:10px}.thread-button span{color:#858c96;font-size:8px;font-weight:800}.thread-button b{margin-left:4px;color:#848b95}.thread-drawer{position:fixed;z-index:50;top:0;right:0;width:min(620px,92vw);height:100vh;display:grid;grid-template-rows:auto minmax(0,1fr);border-left:1px solid #343840;background:#0e1014;box-shadow:-24px 0 70px rgba(0,0,0,.45);transform:translateX(105%);transition:transform 160ms ease}.thread-drawer.open{transform:translateX(0)}.thread-drawer-header{display:flex;justify-content:space-between;align-items:center;padding:13px 15px;border-bottom:1px solid #262a31;background:#13161b}.thread-drawer-header strong{font-size:12px}.thread-close{width:30px;height:30px;border:1px solid #353a43;border-radius:7px;background:#1b1e24;color:#c9cdd3;cursor:pointer}.thread-drawer-body{overflow:auto;padding:10px}.thread-panel-title{padding:8px 10px 12px;border-bottom:1px solid #252930}.thread-panel-title span{display:block;color:#7d86ff;font-size:8px;font-weight:900;letter-spacing:.1em}.thread-panel-title strong{display:block;margin-top:3px;font-size:15px}.thread-panel-title small{display:block;margin-top:3px;color:#7c838d;font-size:9px}.thread-empty{padding:30px;text-align:center;color:#777e88}.thread-backdrop{position:fixed;z-index:49;inset:0;background:rgba(0,0,0,.45);opacity:0;visibility:hidden;transition:120ms ease}.thread-backdrop.open{opacity:1;visibility:visible}@media(max-width:700px){.topbar{align-items:flex-start;padding:14px 15px}.export-meta{display:none}.layout{padding:12px 8px 50px}.message{grid-template-columns:34px minmax(0,1fr);padding:8px}.avatar{width:32px;height:32px}.embed-fields{grid-template-columns:1fr}.statuses{position:absolute;right:8px;top:7px}.message-header{padding-right:60px}}
`;
}

function renderExportHtml(chat, messages, threads, options, mediaMap) {
  const threadMap = new Map(threads.map(thread => [String(thread.meta.channelId), thread]));
  const messageHtml = messages.map(record => renderMessage(record, options, mediaMap, threadMap)).join("");
  const threadsIndex = threads.length ? `<div class="thread-index"><strong>Saved threads:</strong>${threads.map(thread => `<button type="button" data-thread-open="${escapeHtml(thread.meta.channelId)}">${escapeHtml(thread.meta.channelName || `Thread ${thread.meta.channelId}`)} · ${formatNumber(thread.messages.length)}</button>`).join("")}</div>` : "";
  const threadPanels = renderThreadPanels(threads, options, mediaMap);
  const title = displayChatName(chat);
  const exportedAt = formatExportTime(new Date().toISOString());
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} - Discord export</title><style>${exportDocumentCss()}</style></head>
<body>
<header class="topbar"><div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(displayChatKind(chat))} · Channel ID ${escapeHtml(chat.channelId)}</p></div><div class="export-meta">${formatNumber(messages.length)} saved messages<br>Exported ${escapeHtml(exportedAt)} by Discord Message Memory</div></header>
<main class="layout">${threadsIndex}<div class="messages">${messageHtml || '<div class="thread-empty">No saved messages matched the export options.</div>'}</div></main>
${threads.length ? `<div id="threadBackdrop" class="thread-backdrop"></div><aside id="threadDrawer" class="thread-drawer" aria-hidden="true"><div class="thread-drawer-header"><strong>Thread</strong><button id="threadClose" class="thread-close" type="button">×</button></div><div class="thread-drawer-body">${threadPanels}</div></aside>` : ""}
<script>(function(){const drawer=document.getElementById('threadDrawer');if(!drawer)return;const backdrop=document.getElementById('threadBackdrop');const close=document.getElementById('threadClose');function shut(){drawer.classList.remove('open');backdrop.classList.remove('open');drawer.setAttribute('aria-hidden','true');}function open(id){document.querySelectorAll('[data-thread-panel]').forEach(p=>p.hidden=p.getAttribute('data-thread-panel')!==id);drawer.classList.add('open');backdrop.classList.add('open');drawer.setAttribute('aria-hidden','false');}document.addEventListener('click',e=>{const b=e.target.closest('[data-thread-open]');if(b)open(b.getAttribute('data-thread-open'));});close.addEventListener('click',shut);backdrop.addEventListener('click',shut);document.addEventListener('keydown',e=>{if(e.key==='Escape')shut();});})();</script>
</body></html>`;
}

async function collectThreadExports(chat, options) {
  if (!options.threads) return [];
  const channels = await getSavedChannels();
  const children = channels.filter(channel => String(channel.parentId || "") === String(chat.channelId) && (channel.isThread || [10, 11, 12].includes(Number(channel.channelType))));
  const threads = [];
  for (const meta of children) {
    const messages = await getSavedChannelMessages(meta.channelId);
    threads.push({ meta, messages });
  }
  return threads.sort((a, b) => String(a.meta.channelName || "").localeCompare(String(b.meta.channelName || "")));
}

async function collectEmbeddedMedia(allMessageGroups, options) {
  const jobs = [];
  for (const messages of allMessageGroups) {
    for (const message of messages) {
      const attachments = Array.isArray(message.attachments) ? message.attachments : [];
      attachments.forEach((attachment, index) => {
        if (shouldEmbedAttachment(attachment, options)) jobs.push({ message, attachment, index });
      });
      if (options.edits && Array.isArray(message.editHistory)) {
        // Historical attachment metadata is preserved, but cached blobs are keyed to
        // the live message attachment keys. Current/last known attachment files are
        // embedded; prior deleted versions still retain their filename metadata.
      }
    }
  }

  const mediaMap = new Map();
  let missing = 0;
  if (!jobs.length) return { mediaMap, missing };
  let done = 0;
  setExportProgress(0, jobs.length, `Embedding cached attachments (0/${jobs.length})…`);

  for (const job of jobs) {
    const key = attachmentMediaKey(job.message, job.attachment, job.index);
    try {
      const item = await getMediaItem(key);
      if (item?.blob) {
        const dataUrl = await blobToDataUrl(item.blob);
        if (dataUrl) mediaMap.set(key, dataUrl);
      } else {
        missing += 1;
      }
    } catch {
      missing += 1;
    }
    done += 1;
    setExportProgress(done, jobs.length, `Embedding cached attachments (${done}/${jobs.length})…`);
  }
  return { mediaMap, missing };
}

async function runExport() {
  if (!currentExportChat || exportRunning) return;
  exportRunning = true;
  startExportButton.disabled = true;
  startExportButton.textContent = "Exporting…";
  resetExportProgress();
  const options = getExportOptions();

  try {
    setExportProgress(0, 1, "Reading saved messages…");
    const messages = await getSavedChannelMessages(currentExportChat.channelId);
    const threads = await collectThreadExports(currentExportChat, options);
    const groups = [messages, ...threads.map(thread => thread.messages)];
    const { mediaMap, missing } = await collectEmbeddedMedia(groups, options);

    setExportProgress(1, 1, "Building standalone HTML…");
    const html = renderExportHtml(currentExportChat, messages, threads, options, mediaMap);
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const date = new Date().toISOString().slice(0, 10);
    anchor.href = url;
    anchor.download = `${sanitizeFilename(displayChatName(currentExportChat))} - ${date}.html`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);

    setExportProgress(1, 1, `Export ready · ${formatBytes(blob.size)}`);
    startExportButton.textContent = "Export again";
    if (missing) {
      exportWarning.hidden = false;
      exportWarning.textContent = `${missing} attachment${missing === 1 ? " was" : "s were"} not cached locally. The export uses the saved Discord link when one is available.`;
    } else {
      exportWarning.hidden = true;
    }
  } catch (error) {
    exportWarning.hidden = false;
    exportWarning.textContent = `Export failed: ${String(error?.message || error)}`;
    startExportButton.textContent = "Try again";
  } finally {
    startExportButton.disabled = false;
    exportRunning = false;
  }
}

/* ----------------------------- Page events ------------------------------ */

sidebarToggle.addEventListener("click", async () => {
  const collapsed = !appShell.classList.contains("sidebar-collapsed");
  applySidebarState(collapsed);
  await chrome.storage.local.set({ sidebarCollapsed: collapsed });
});

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
startExportButton.addEventListener("click", runExport);
exportDialog.addEventListener("close", () => {
  if (!exportRunning) currentExportChat = null;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.hookStatus) updateHookStatus(changes.hookStatus.newValue);
  if (changes.rememberingEnabled) rememberToggle.checked = Boolean(changes.rememberingEnabled.newValue);
  if (changes.showingEnabled) showingToggle.checked = Boolean(changes.showingEnabled.newValue);
  if (changes.sidebarCollapsed) applySidebarState(Boolean(changes.sidebarCollapsed.newValue));
});

(async () => {
  await loadSettings();
  await Promise.all([loadChats(), loadStats()]);
})();
