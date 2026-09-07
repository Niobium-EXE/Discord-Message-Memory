(() => {
  "use strict";

  const PAGE_SOURCE = "discord-message-memory-page";
  const CONTENT_SOURCE = "discord-message-memory-content";
  const SETTINGS_DEFAULTS = {
    rememberingEnabled: true,
    showingEnabled: true,
    quickCss: ""
  };

  let settings = { ...SETTINGS_DEFAULTS };
  let currentChannelId = null;
  let historyCache = new Map();
  let refreshTimer = null;
  let scanTimer = null;
  let routeTimer = null;
  let hookHeartbeatTimer = null;
  let observer = null;
  let customStyleElement = null;
  let lastRoute = location.href;

  const mediaObjectUrls = new Map();
  const mediaLoadPromises = new Map();

  function postToPage(type, payload = {}) {
    window.postMessage({ source: CONTENT_SOURCE, type, ...payload }, "*");
  }

  async function sendBackground(message, retry = true) {
    try {
      const response = await chrome.runtime.sendMessage(message);
      if (response?.ok === false && response?.error) throw new Error(response.error);
      return response;
    } catch (error) {
      if (retry) {
        await new Promise(resolve => setTimeout(resolve, 180));
        return sendBackground(message, false);
      }
      chrome.storage.local.set({
        storageStatus: {
          ok: false,
          error: String(error?.message || error),
          updatedAt: Date.now()
        }
      }).catch(() => {});
      throw error;
    }
  }

  function parseCurrentContext() {
    const match = location.pathname.match(/^\/channels\/(@me|\d+)\/(\d+)/);
    if (!match) return null;
    const locationId = match[1];
    const channelId = match[2];
    return {
      channelId,
      guildId: locationId === "@me" ? null : locationId,
      channelScope: locationId === "@me" ? "private" : "server"
    };
  }

  function parseCurrentChannelId() {
    return parseCurrentContext()?.channelId || null;
  }

  function parseMessageElement(element) {
    if (!(element instanceof Element)) return null;
    const id = element.id || "";
    const match = id.match(/^chat-messages-(\d+)-(\d+)/);
    if (!match) return null;
    return { channelId: match[1], id: match[2] };
  }

  function compareSnowflakes(a, b) {
    const aa = String(a || "");
    const bb = String(b || "");
    if (aa.length !== bb.length) return aa.length - bb.length;
    return aa.localeCompare(bb);
  }

  function snowflakeTime(id) {
    try { return Number((BigInt(id) >> 22n) + 1420070400000n); } catch { return 0; }
  }

  function formatTimestamp(value) {
    if (!value) return "";
    try {
      const date = new Date(value);
      return new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        year: date.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined,
        hour: "numeric",
        minute: "2-digit"
      }).format(date);
    } catch { return String(value); }
  }

  function formatBytes(bytes) {
    const value = Number(bytes || 0);
    if (!value) return "";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let size = value;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
      size /= 1024;
      unit += 1;
    }
    return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
  }

  function authorName(record) {
    return record?.author?.globalName || record?.author?.username || "Unknown user";
  }

  function sanitizeSnapshot(element) {
    const clone = element.cloneNode(true);
    clone.removeAttribute("data-dmh-observed");
    clone.removeAttribute("data-dmh-decorated");
    clone.removeAttribute("data-dmh-restored");
    clone.classList.remove("messagelogger-deleted", "dmh-message-edited", "dmh-synthetic-message");

    clone.querySelectorAll("[data-dmh-injected], .dmh-edit-history-wrap, .dmh-deleted-badge, .dmh-edit-marker").forEach(node => node.remove());
    clone.querySelectorAll("script, style, iframe, object, embed").forEach(node => node.remove());
    clone.querySelectorAll("*").forEach(node => {
      for (const attr of [...node.attributes]) {
        if (/^on/i.test(attr.name)) node.removeAttribute(attr.name);
        if (attr.name.startsWith("data-dmh-")) node.removeAttribute(attr.name);
      }
      if (node.classList.contains("messagelogger-deleted-attachment")) node.classList.remove("messagelogger-deleted-attachment");
    });
    return clone.outerHTML;
  }

  function guessContentType(filename = "") {
    const ext = filename.split(".").pop()?.toLowerCase();
    const map = {
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif",
      mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
      mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4"
    };
    return map[ext] || "application/octet-stream";
  }

  function normalizeSystemText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function extractCallSystemText(clean, authorName, timeNode) {
    let text = normalizeSystemText(clean?.innerText || clean?.textContent || "");
    if (!text) return null;
    const lower = text.toLowerCase();
    if (!lower.includes("started a call") && !lower.includes("missed a call") && !lower.includes("call that lasted")) return null;

    const renderedTime = normalizeSystemText(timeNode?.textContent || "");
    if (renderedTime && text.endsWith(renderedTime)) text = text.slice(0, -renderedTime.length).trim();

    // Discord sometimes repeats accessible timestamp text in the cloned row. Keep
    // only the user-facing call sentence when we can identify it.
    const startIndex = text.toLowerCase().indexOf("started a call");
    if (startIndex >= 0) {
      const tail = text.slice(startIndex).match(/^started a call(?: that lasted .*?)(?:\.|$)/i)?.[0];
      if (tail) return tail.trim();
    }
    const missedIndex = text.toLowerCase().indexOf("missed a call");
    if (missedIndex >= 0) {
      const tail = text.slice(missedIndex).match(/^missed a call(?:\.|$)/i)?.[0];
      if (tail) return tail.trim();
    }
    return text;
  }

  function snapshotFallbackRecord(element, ids) {
    const context = parseCurrentContext();

    // Read text/author/time from a clean clone rather than the live row. Message
    // Memory decorates the live DOM with badges and inline history, and reading
    // that decorated DOM back into storage can recursively save our own UI.
    const clean = element.cloneNode(true);
    clean.querySelectorAll("[data-dmh-injected], .dmh-edit-history-wrap, .dmh-deleted-badge, .dmh-edit-marker").forEach(node => node.remove());
    const contentNode = clean.querySelector(`[id^="message-content-${ids.id}"]`) || clean.querySelector('[id^="message-content-"]');
    const authorNode = clean.querySelector(`[id^="message-username-${ids.id}"]`) || clean.querySelector('[id^="message-username-"]') || clean.querySelector("h3 span");
    const timeNode = clean.querySelector("time[datetime]");
    const authorName = authorNode?.textContent?.trim() || "Unknown user";
    const callSystemText = extractCallSystemText(clean, authorName, timeNode);
    // The Flux message normally gives us the author's id + avatar hash. Keep a DOM
    // avatar URL as a fallback so exports can still show profile pictures if a
    // Discord build only exposes the rendered row to us.
    const avatarNode = element.querySelector('img[class*="avatar"], img[src*="cdn.discordapp.com/avatars/"], img[src*="media.discordapp.net/avatars/"]');
    const avatarUrl = avatarNode?.currentSrc || avatarNode?.src || null;
    const attachments = [];
    const seen = new Set();

    element.querySelectorAll('a[href*="/attachments/"], img[src*="/attachments/"], video[src*="/attachments/"], audio[src*="/attachments/"]').forEach(node => {
      const url = node.href || node.src;
      if (!url || seen.has(url)) return;
      seen.add(url);
      let filename = "attachment";
      try { filename = decodeURIComponent(new URL(url).pathname.split("/").pop() || filename); } catch {}
      let durationSecs = null;
      try {
        if (node instanceof HTMLMediaElement && Number.isFinite(node.duration) && node.duration >= 0) durationSecs = node.duration;
        if (durationSecs == null) {
          const media = element.querySelector(`audio[src="${CSS.escape(url)}"], video[src="${CSS.escape(url)}"]`);
          if (media instanceof HTMLMediaElement && Number.isFinite(media.duration) && media.duration >= 0) durationSecs = media.duration;
        }
      } catch {}
      attachments.push({
        id: null,
        filename,
        url,
        proxyUrl: null,
        contentType: guessContentType(filename),
        size: 0,
        durationSecs
      });
    });

    return {
      channelId: ids.channelId,
      guildId: context?.channelId === ids.channelId ? context.guildId : null,
      channelScope: context?.channelId === ids.channelId ? context.channelScope : "private",
      channelMeta: {
        channelId: ids.channelId,
        guildId: context?.channelId === ids.channelId ? context.guildId : null,
        scope: context?.channelId === ids.channelId ? context.channelScope : "private"
      },
      id: ids.id,
      content: contentNode?.innerText || contentNode?.textContent || "",
      author: authorNode ? { username: authorName, avatarUrl } : (avatarUrl ? { username: "Unknown user", avatarUrl } : null),
      timestamp: timeNode?.getAttribute("datetime") || null,
      ...(callSystemText ? { type: 3, systemEventKind: "call", systemEventText: callSystemText } : {}),
      attachments,
      snapshotHtml: sanitizeSnapshot(element)
    };
  }

  async function captureMessageElement(element) {
    if (!settings.rememberingEnabled) return;
    if (element.dataset.dmhRestored === "true") return;
    const ids = parseMessageElement(element);
    if (!ids) return;

    if (element.dataset.dmhObserved !== "true") {
      element.dataset.dmhObserved = "true";
      const context = parseCurrentContext();
      postToPage("REQUEST_MESSAGE", {
        ...ids,
        guildId: context?.channelId === ids.channelId ? context.guildId : null,
        channelScope: context?.channelId === ids.channelId ? context.channelScope : null
      });
    }

    const record = snapshotFallbackRecord(element, ids);
    sendBackground({ type: "DMH_SAVE_SNAPSHOT", record })
      .then(() => {
        if (record.attachments?.length) {
          return sendBackground({ type: "DMH_CACHE_MESSAGE_ATTACHMENTS", channelId: record.channelId, id: record.id });
        }
      })
      .catch(() => {});
  }

  function ensureCustomCssElement() {
    if (customStyleElement?.isConnected) return customStyleElement;
    customStyleElement = document.createElement("style");
    customStyleElement.id = "dmh-quick-css";
    (document.head || document.documentElement).appendChild(customStyleElement);
    return customStyleElement;
  }

  function applyQuickCss() {
    ensureCustomCssElement().textContent = settings.quickCss || "";
  }

  function clearMediaUrls() {
    for (const url of mediaObjectUrls.values()) {
      try { URL.revokeObjectURL(url); } catch {}
    }
    mediaObjectUrls.clear();
    mediaLoadPromises.clear();
  }

  function base64ToBytes(data) {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function loadCachedMedia(mediaKey) {
    if (!mediaKey) return Promise.reject(new Error("No cached media key"));
    if (mediaObjectUrls.has(mediaKey)) return Promise.resolve(mediaObjectUrls.get(mediaKey));
    if (mediaLoadPromises.has(mediaKey)) return mediaLoadPromises.get(mediaKey);

    const promise = new Promise((resolve, reject) => {
      const port = chrome.runtime.connect({ name: "dmh-media" });
      const chunks = [];
      let contentType = "application/octet-stream";
      let finished = false;

      const fail = error => {
        if (finished) return;
        finished = true;
        try { port.disconnect(); } catch {}
        mediaLoadPromises.delete(mediaKey);
        reject(error instanceof Error ? error : new Error(String(error)));
      };

      port.onDisconnect.addListener(() => {
        if (!finished) fail(new Error(chrome.runtime.lastError?.message || "Media stream disconnected"));
      });

      port.onMessage.addListener(message => {
        if (message?.type === "META") {
          contentType = message.contentType || contentType;
        } else if (message?.type === "CHUNK") {
          chunks.push(base64ToBytes(message.data));
        } else if (message?.type === "ERROR") {
          fail(new Error(message.error || "Cached media unavailable"));
        } else if (message?.type === "END") {
          if (finished) return;
          finished = true;
          const blob = new Blob(chunks, { type: contentType });
          const url = URL.createObjectURL(blob);
          mediaObjectUrls.set(mediaKey, url);
          mediaLoadPromises.delete(mediaKey);
          try { port.disconnect(); } catch {}
          resolve(url);
        }
      });

      port.postMessage({ type: "GET_MEDIA", key: mediaKey });
    });

    mediaLoadPromises.set(mediaKey, promise);
    return promise;
  }

  function findAttachmentMatch(node, attachments) {
    const source = node.getAttribute?.("src") || node.getAttribute?.("href") || "";
    for (const attachment of attachments || []) {
      if (!attachment?._dmhMediaKey) continue;
      if (attachment.id && source.includes(String(attachment.id))) return attachment;
      if (attachment.filename && source.includes(encodeURIComponent(attachment.filename))) return attachment;
      if (attachment.filename && source.includes(attachment.filename)) return attachment;
    }
    return null;
  }

  function markDeletedAttachments(root, record) {
    const attachments = record.attachments || [];
    if (!attachments.length) return;
    const nodes = root.querySelectorAll("a[href], img[src], video[src], audio[src], source[src]");
    for (const node of nodes) {
      const attachment = findAttachmentMatch(node, attachments);
      if (!attachment) continue;
      node.classList.add("messagelogger-deleted-attachment");
      node.setAttribute("data-dmh-decorated-attachment", "true");
      node.setAttribute("data-dmh-media-key", attachment._dmhMediaKey);
      const wrapper = node.closest('[class*="attachment"], [class*="mosaicItem"], [class*="mediaAttachmentsContainer"]');
      if (wrapper) {
        wrapper.classList.add("messagelogger-deleted-attachment");
        wrapper.setAttribute("data-dmh-decorated-attachment", "true");
      }
    }
  }

  function hydrateCachedAttachments(root, record) {
    const attachments = record.attachments || [];
    if (!attachments.length) return;

    const candidates = root.querySelectorAll("a[href], img[src], video[src], audio[src], source[src]");
    for (const node of candidates) {
      const attachment = findAttachmentMatch(node, attachments);
      if (!attachment?._dmhMediaKey) continue;
      node.setAttribute("data-dmh-media-key", attachment._dmhMediaKey);
      loadCachedMedia(attachment._dmhMediaKey).then(url => {
        if (!node.isConnected) return;
        if (node instanceof HTMLAnchorElement) {
          node.href = url;
          node.download = attachment.filename || "attachment";
        } else {
          node.src = url;
          if (node instanceof HTMLVideoElement || node instanceof HTMLAudioElement) node.load();
        }
      }).catch(() => {
        // The original Discord URL remains in place if caching failed.
      });
    }
  }

  function addDeletedBadge(root) {
    if (root.querySelector(".dmh-deleted-badge")) return;

    const badge = document.createElement("span");
    badge.className = "dmh-deleted-badge dmh-deleted-badge-floating";
    badge.textContent = "DELETED";
    badge.setAttribute("data-dmh-injected", "true");
    badge.setAttribute("aria-label", "Deleted message");

    // Keep this entirely outside Discord's author/content nodes. That avoids
    // compact-mode collisions and also keeps exporters from accidentally
    // treating the visible DELETED label as part of the actual message text.
    root.appendChild(badge);
  }

  function editHistoryRenderKey(record) {
    const history = Array.isArray(record.editHistory) ? record.editHistory : [];
    // Keep this compact: it is only used to avoid tearing down/rebuilding our UI
    // on every MutationObserver pass. Rebuilding continuously can fight Discord's
    // virtualized scroller and make it feel like the user cannot scroll downward.
    let hash = 2166136261;
    for (const edit of history) {
      const text = `${edit?.editedAt || ""}\u001f${edit?.content || ""}\u001e`;
      for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
    }
    return `${history.length}:${hash >>> 0}`;
  }

  function removeEditHistoryRender(root, messageId) {
    // Clean up both current in-message history and sibling history left behind by
    // v1.0.7 so upgrading does not leave duplicate rows in Discord's list.
    root.querySelectorAll(":scope .dmh-edit-history-wrap, :scope .dmh-edit-marker").forEach(node => node.remove());
    const parent = root.parentNode;
    if (parent) {
      for (const child of [...parent.children]) {
        if (child.getAttribute?.("data-dmh-edit-history-for") === String(messageId)) child.remove();
      }
    }
    root.classList.remove("dmh-message-edited");
    delete root.dataset.dmhEditRenderKey;
  }

  function renderEditHistory(root, record) {
    const history = Array.isArray(record.editHistory) ? record.editHistory : [];
    if (!history.length) {
      if (root.classList.contains("dmh-message-edited") || root.querySelector(":scope .dmh-edit-history-wrap, :scope .dmh-edit-marker")) {
        removeEditHistoryRender(root, record.id);
      }
      return;
    }

    const currentContent = root.querySelector(`[id^="message-content-${record.id}"]`) || root.querySelector('[id^="message-content-"]');
    if (!currentContent) return;

    const renderKey = editHistoryRenderKey(record);
    const existingWrap = root.querySelector(":scope .dmh-edit-history-wrap");
    const existingMarker = root.querySelector(":scope .dmh-edit-marker");
    if (
      root.dataset.dmhEditRenderKey === renderKey &&
      root.classList.contains("dmh-message-edited") &&
      existingWrap &&
      existingMarker
    ) {
      return;
    }

    removeEditHistoryRender(root, record.id);
    root.classList.add("dmh-message-edited");
    root.dataset.dmhEditRenderKey = renderKey;

    // One badge and one yellow outer box for the entire edited message. Previous
    // versions live *inside this same Discord LI*, so they no longer add rogue LI
    // children to Discord's virtualized list (the source of the scroll-down bug).
    const marker = document.createElement("span");
    marker.className = "messagelogger-edit-marker dmh-edit-marker dmh-edited-badge-floating";
    marker.textContent = "EDITED";
    marker.title = `${history.length} previous version${history.length === 1 ? "" : "s"} saved`;
    marker.setAttribute("data-dmh-injected", "true");
    marker.setAttribute("aria-label", marker.title);
    root.appendChild(marker);

    const wrap = document.createElement("div");
    wrap.className = "dmh-edit-history-wrap";
    wrap.setAttribute("data-dmh-injected", "true");
    wrap.setAttribute("data-dmh-edit-history-for", String(record.id));
    wrap.setAttribute("aria-label", `Saved edit history for message ${record.id}`);

    for (const edit of history) {
      const entry = document.createElement("div");
      entry.className = "messagelogger-edited dmh-edit-entry";
      entry.setAttribute("data-dmh-injected", "true");

      const body = document.createElement("span");
      body.className = "dmh-edit-content";
      body.textContent = edit.content || "";
      entry.appendChild(body);

      const time = document.createElement("span");
      time.className = "dmh-edit-history-time";
      time.textContent = formatTimestamp(edit.editedAt);
      entry.appendChild(time);

      wrap.appendChild(entry);
    }

    // Keep the history in the same real Discord message LI and place it directly
    // with the message content instead of trying to calculate a large compact-mode
    // indent. The measured indent could overshoot on some Discord layouts/themes,
    // creating the stretched dark bars seen in v1.0.9.
    const historyHost = currentContent.parentNode;
    wrap.style.setProperty("--dmh-edit-indent", `0px`);
    historyHost.insertBefore(wrap, currentContent);
  }

  function decorateMessageNode(root, record) {
    if (!root || !record) return;
    root.setAttribute("data-dmh-decorated", "true");
    root.setAttribute("data-dmh-message-id", record.id);
    root.setAttribute("data-dmh-channel-id", record.channelId);

    if (record.deleted) {
      root.classList.add("messagelogger-deleted");
      root.setAttribute("data-deleted", "true");
      addDeletedBadge(root);
      markDeletedAttachments(root, record);
      hydrateCachedAttachments(root, record);
    }

    renderEditHistory(root, record);
  }

  function makeAttachmentElement(record, attachment) {
    const wrapper = document.createElement("div");
    wrapper.className = "dmh-attachment messagelogger-deleted-attachment";
    wrapper.setAttribute("data-dmh-injected", "true");
    wrapper.setAttribute("data-dmh-decorated-attachment", "true");

    const contentType = attachment.contentType || guessContentType(attachment.filename);
    const originalUrl = attachment.url || attachment.proxyUrl || "#";
    let media = null;

    if (contentType.startsWith("image/")) {
      media = document.createElement("img");
      media.alt = attachment.description || attachment.filename || "Deleted image";
      media.loading = "lazy";
      media.src = originalUrl;
      media.className = "dmh-restored-image messagelogger-deleted-attachment";
    } else if (contentType.startsWith("video/")) {
      media = document.createElement("video");
      media.controls = true;
      media.preload = "metadata";
      media.src = originalUrl;
      media.className = "dmh-restored-video messagelogger-deleted-attachment";
    } else if (contentType.startsWith("audio/")) {
      media = document.createElement("audio");
      media.controls = true;
      media.preload = "metadata";
      media.src = originalUrl;
      media.className = "dmh-restored-audio messagelogger-deleted-attachment";
    }

    if (media) {
      media.setAttribute("data-dmh-media-key", attachment._dmhMediaKey || "");
      wrapper.appendChild(media);
    }

    const link = document.createElement("a");
    link.className = "dmh-file-link messagelogger-deleted-attachment";
    link.href = originalUrl;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = attachment.filename || "attachment";
    if (attachment.size) link.append(` · ${formatBytes(attachment.size)}`);
    if (attachment._dmhMediaKey) link.setAttribute("data-dmh-media-key", attachment._dmhMediaKey);
    wrapper.appendChild(link);

    if (attachment._dmhMediaKey) {
      loadCachedMedia(attachment._dmhMediaKey).then(url => {
        if (!wrapper.isConnected) return;
        link.href = url;
        link.download = attachment.filename || "attachment";
        if (media) {
          media.src = url;
          if (media instanceof HTMLVideoElement || media instanceof HTMLAudioElement) media.load();
        }
      }).catch(() => {});
    }

    return wrapper;
  }

  function addEmbedSummary(container, record) {
    for (const embed of record.embeds || []) {
      if (!embed || (!embed.title && !embed.description && !embed.url)) continue;
      const card = document.createElement("div");
      card.className = "dmh-embed";
      card.setAttribute("data-dmh-injected", "true");
      if (embed.title) {
        const title = document.createElement("div");
        title.className = "dmh-embed-title";
        title.textContent = embed.title;
        card.appendChild(title);
      }
      if (embed.description) {
        const description = document.createElement("div");
        description.textContent = embed.description;
        card.appendChild(description);
      }
      if (embed.url) {
        const link = document.createElement("a");
        link.href = embed.url;
        link.target = "_blank";
        link.rel = "noreferrer";
        link.textContent = embed.url;
        card.appendChild(link);
      }
      container.appendChild(card);
    }
  }

  function addPollSummary(container, record) {
    const poll = record.poll;
    if (!poll) return;
    const question = poll.question?.text || poll.question || poll.prompt?.text;
    const answers = poll.answers || [];
    if (!question && !answers.length) return;

    const pollBox = document.createElement("div");
    pollBox.className = "dmh-poll";
    pollBox.setAttribute("data-dmh-injected", "true");
    if (question) {
      const q = document.createElement("strong");
      q.textContent = typeof question === "string" ? question : JSON.stringify(question);
      pollBox.appendChild(q);
    }
    for (const answer of answers) {
      const row = document.createElement("div");
      row.textContent = answer?.poll_media?.text || answer?.pollMedia?.text || answer?.text || "Poll option";
      pollBox.appendChild(row);
    }
    container.appendChild(pollBox);
  }

  function buildSyntheticDeletedMessage(record) {
    const li = document.createElement("li");
    li.id = `chat-messages-${record.channelId}-${record.id}`;
    li.className = "dmh-synthetic-message messagelogger-deleted";
    li.setAttribute("data-dmh-restored", "true");
    li.setAttribute("data-dmh-decorated", "true");
    li.setAttribute("data-list-item-id", `chat-messages___chat-messages-${record.channelId}-${record.id}`);
    li.setAttribute("data-message-id", record.id);
    li.setAttribute("data-channel-id", record.channelId);
    li.setAttribute("data-deleted", "true");

    const avatar = document.createElement("div");
    avatar.className = "dmh-avatar";
    avatar.textContent = authorName(record).slice(0, 1).toUpperCase();
    if (record.author?.id && record.author?.avatar) {
      const ext = String(record.author.avatar).startsWith("a_") ? "gif" : "png";
      const img = document.createElement("img");
      img.alt = "";
      img.src = `https://cdn.discordapp.com/avatars/${record.author.id}/${record.author.avatar}.${ext}?size=80`;
      avatar.textContent = "";
      avatar.appendChild(img);
    }
    li.appendChild(avatar);

    const body = document.createElement("div");
    body.className = "dmh-message-body";

    const header = document.createElement("h3");
    header.className = "dmh-message-header";
    const username = document.createElement("span");
    username.id = `message-username-${record.id}`;
    username.className = "dmh-author";
    username.textContent = authorName(record);
    header.appendChild(username);

    const time = document.createElement("time");
    time.className = "dmh-time";
    if (record.timestamp) time.dateTime = record.timestamp;
    time.textContent = formatTimestamp(record.timestamp || snowflakeTime(record.id));
    header.appendChild(time);
    body.appendChild(header);

    const content = document.createElement("div");
    content.id = `message-content-${record.id}`;
    content.className = "dmh-message-content";
    content.textContent = record.content || "";
    body.appendChild(content);

    if (record.attachments?.length) {
      const attachments = document.createElement("div");
      attachments.className = "dmh-attachments";
      for (const attachment of record.attachments) attachments.appendChild(makeAttachmentElement(record, attachment));
      body.appendChild(attachments);
    }

    addEmbedSummary(body, record);
    addPollSummary(body, record);

    if (record.stickers?.length) {
      const stickers = document.createElement("div");
      stickers.className = "dmh-stickers";
      stickers.textContent = record.stickers.map(sticker => sticker?.name || "Sticker").join(", ");
      body.appendChild(stickers);
    }

    li.appendChild(body);
    addDeletedBadge(li);
    renderEditHistory(li, record);
    return li;
  }

  function buildDeletedMessageNode(record) {
    if (record.snapshotHtml) {
      try {
        const template = document.createElement("template");
        template.innerHTML = record.snapshotHtml.trim();
        const root = template.content.firstElementChild;
        if (root && root.tagName === "LI") {
          root.id = `chat-messages-${record.channelId}-${record.id}`;
          root.setAttribute("data-dmh-restored", "true");
          root.setAttribute("data-dmh-decorated", "true");
          root.setAttribute("data-message-id", record.id);
          root.setAttribute("data-channel-id", record.channelId);
          root.setAttribute("data-deleted", "true");
          root.classList.add("messagelogger-deleted");
          addDeletedBadge(root);
          renderEditHistory(root, record);
          markDeletedAttachments(root, record);
          hydrateCachedAttachments(root, record);
          return root;
        }
      } catch {}
    }
    return buildSyntheticDeletedMessage(record);
  }

  function getVisibleNativeMessageRows(channelId) {
    return [...document.querySelectorAll(`li[id^="chat-messages-${channelId}-"]`)]
      .filter(li => li.dataset.dmhRestored !== "true")
      .map(li => ({ li, ids: parseMessageElement(li) }))
      .filter(item => item.ids);
  }

  function shouldInsertRecord(record, visibleRows) {
    // Historical restores are only safe when Discord has native rows from the
    // active channel around the saved message. Never use a time buffer and never
    // treat a transient empty list as permission to inject a row.
    const activeChannelId = parseCurrentChannelId();
    if (!record || !activeChannelId || String(record.channelId) !== String(activeChannelId)) return false;
    const safeRows = (visibleRows || []).filter(item =>
      item?.ids &&
      item.li?.isConnected &&
      item.li?.dataset?.dmhRestored !== "true" &&
      String(item.ids.channelId) === String(activeChannelId)
    );
    if (!safeRows.length) return false;
    const ids = safeRows.map(item => item.ids.id).sort(compareSnowflakes);
    return compareSnowflakes(record.id, ids[0]) >= 0 && compareSnowflakes(record.id, ids[ids.length - 1]) <= 0;
  }

  function findMessageListContainer(channelId) {
    const existing = document.querySelector(`li[id^="chat-messages-${channelId}-"]`);
    if (existing?.parentElement) return existing.parentElement;

    const candidates = [
      document.querySelector('ol[data-list-id="chat-messages"]'),
      document.querySelector('[data-list-id="chat-messages"]'),
      document.querySelector('main [role="log"] ol'),
      document.querySelector('[role="log"] ol')
    ];
    return candidates.find(node => node instanceof Element) || null;
  }

  function getLiveDeleteAnchor(channelId, messageId) {
    return document.querySelector(`[data-dmh-live-delete-anchor="${channelId}:${messageId}"]`);
  }

  function restoreAtLiveAnchor(record, attempt = 0) {
    const activeChannelId = parseCurrentChannelId();
    if (!record || !activeChannelId || String(record.channelId) !== String(activeChannelId)) {
      const stale = record ? getLiveDeleteAnchor(record.channelId, record.id) : null;
      stale?.remove();
      return false;
    }

    const anchor = getLiveDeleteAnchor(record.channelId, record.id);
    if (!anchor?.parentNode) return false;

    const existing = document.getElementById(`chat-messages-${record.channelId}-${record.id}`);
    if (existing?.dataset?.dmhRestored === "true") {
      anchor.remove();
      return true;
    }

    if (existing && attempt < 8) {
      setTimeout(() => restoreAtLiveAnchor(record, attempt + 1), 16);
      return true;
    }

    if (existing) {
      decorateMessageNode(existing, record);
      anchor.remove();
      return true;
    }

    if (String(parseCurrentChannelId()) !== String(activeChannelId)) {
      anchor.remove();
      return false;
    }

    const node = buildDeletedMessageNode(record);
    node.setAttribute("data-dmh-live-positioned", "true");
    const prev = anchor.getAttribute("data-dmh-anchor-prev");
    const next = anchor.getAttribute("data-dmh-anchor-next");
    if (prev) node.setAttribute("data-dmh-live-prev", prev);
    if (next) node.setAttribute("data-dmh-live-next", next);
    anchor.replaceWith(node);
    return true;
  }

  function insertDeletedRecord(record, visibleRows) {
    const activeChannelId = parseCurrentChannelId();
    if (!record || !activeChannelId || String(record.channelId) !== String(activeChannelId)) return;
    if (restoreAtLiveAnchor(record)) return;
    if (document.getElementById(`chat-messages-${record.channelId}-${record.id}`)) return;
    if (!shouldInsertRecord(record, visibleRows)) return;

    const sorted = [...visibleRows]
      .filter(item => item?.ids && item.li?.isConnected && String(item.ids.channelId) === String(activeChannelId))
      .sort((a, b) => compareSnowflakes(a.ids.id, b.ids.id));
    if (!sorted.length || String(parseCurrentChannelId()) !== String(activeChannelId)) return;

    const before = sorted.find(item => compareSnowflakes(item.ids.id, record.id) > 0)?.li || null;
    const node = buildDeletedMessageNode(record);

    if (before?.parentNode && String(parseCurrentChannelId()) === String(activeChannelId)) {
      before.parentNode.insertBefore(node, before);
      return;
    }

    const tailParent = sorted[sorted.length - 1]?.li?.parentNode;
    if (tailParent && String(parseCurrentChannelId()) === String(activeChannelId)) {
      tailParent.appendChild(node);
    }
    // No generic empty-list fallback: during navigation Discord often mounts an
    // empty chat list before the real channel rows arrive. Live deletes in a truly
    // empty channel still use restoreAtLiveAnchor(), which has the exact position.
  }

  function purgeWrongChannelRestores(channelId) {
    const active = channelId ? String(channelId) : null;
    document.querySelectorAll('[data-dmh-restored="true"]').forEach(node => {
      const ids = parseMessageElement(node);
      if (!active || !ids || String(ids.channelId) !== active) node.remove();
    });
  }

  function pruneHistoricalRestores(channelId, visibleRows) {
    const active = channelId ? String(channelId) : null;
    if (!active) return;
    const safeRows = (visibleRows || []).filter(item =>
      item?.ids && item.li?.isConnected && String(item.ids.channelId) === active && item.li?.dataset?.dmhRestored !== "true"
    );
    if (!safeRows.length) return;

    const ids = safeRows.map(item => item.ids.id).sort(compareSnowflakes);
    const minId = ids[0];
    const maxId = ids[ids.length - 1];
    const nativeIds = new Set(ids.map(String));

    document.querySelectorAll(`li[data-dmh-restored="true"][id^="chat-messages-${active}-"]`).forEach(node => {
      const parsed = parseMessageElement(node);
      if (!parsed) return node.remove();

      // A live deletion may legitimately be just outside the new min/max because
      // it was the newest/oldest visible message. Keep it while one of its captured
      // native neighbors is still present; once both neighbors disappear, it can no
      // longer be trusted to belong to the current virtualized window.
      if (node.getAttribute("data-dmh-live-positioned") === "true") {
        const prev = node.getAttribute("data-dmh-live-prev");
        const next = node.getAttribute("data-dmh-live-next");
        if ((prev && nativeIds.has(prev)) || (next && nativeIds.has(next))) return;
      }

      if (compareSnowflakes(parsed.id, minId) < 0 || compareSnowflakes(parsed.id, maxId) > 0) node.remove();
    });
  }

  function clearDecorations() {
    document.querySelectorAll('[data-dmh-live-delete-anchor]').forEach(node => node.remove());
    document.querySelectorAll('[data-dmh-restored="true"]').forEach(node => node.remove());
    document.querySelectorAll(".dmh-edit-history-wrap, .dmh-deleted-badge, .dmh-edit-marker").forEach(node => node.remove());
    document.querySelectorAll('[data-dmh-decorated="true"]').forEach(node => {
      node.classList.remove("messagelogger-deleted", "dmh-message-edited");
      node.removeAttribute("data-dmh-decorated");
      node.removeAttribute("data-deleted");
      node.removeAttribute("data-dmh-edit-render-key");
    });
    document.querySelectorAll('[data-dmh-decorated-attachment="true"]').forEach(node => {
      node.classList.remove("messagelogger-deleted-attachment");
      node.removeAttribute("data-dmh-decorated-attachment");
    });
    clearMediaUrls();
  }

  async function getHistory(channelId, force = false) {
    const key = String(channelId);
    if (!force && historyCache.has(key)) return historyCache.get(key);
    const records = await sendBackground({ type: "DMH_GET_CHANNEL_HISTORY", channelId }).catch(() => []);
    const safe = (Array.isArray(records) ? records : []).filter(record => record && String(record.channelId) === key);
    historyCache.set(key, safe);
    return safe;
  }

  async function refreshCurrentChannel(force = false) {
    const channelId = parseCurrentChannelId();
    currentChannelId = channelId;
    purgeWrongChannelRestores(channelId);
    if (!channelId || !settings.showingEnabled) {
      clearDecorations();
      return;
    }

    const records = await getHistory(channelId, force);
    if (String(channelId) !== String(parseCurrentChannelId()) || !settings.showingEnabled) return;

    const byId = new Map(records.map(record => [String(record.id), record]));
    const visibleRows = getVisibleNativeMessageRows(channelId);
    pruneHistoricalRestores(channelId, visibleRows);

    for (const { li, ids } of visibleRows) {
      if (String(channelId) !== String(parseCurrentChannelId())) return;
      const record = byId.get(String(ids.id));
      if (record) decorateMessageNode(li, record);
    }

    for (const record of records) {
      if (String(channelId) !== String(parseCurrentChannelId())) return;
      if (record.deleted) insertDeletedRecord(record, visibleRows);
    }
  }

  function scheduleRefresh(force = false) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => refreshCurrentChannel(force).catch(() => {}), 90);
  }

  function scanVisibleMessages() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      const channelId = parseCurrentChannelId();
      if (!channelId) return;
      const rows = document.querySelectorAll(`li[id^="chat-messages-${channelId}-"]`);
      for (const row of rows) captureMessageElement(row);
      scheduleRefresh(false);
    }, 80);
  }

  function onRouteChanged() {
    const nextChannel = parseCurrentChannelId();
    const changed = nextChannel !== currentChannelId;
    currentChannelId = nextChannel;
    if (changed) {
      clearDecorations();
      historyCache.clear();
      if (settings.rememberingEnabled && nextChannel) {
        const context = parseCurrentContext();
        postToPage("REQUEST_CHANNEL_MESSAGES", { channelId: nextChannel, guildId: context?.guildId || null, channelScope: context?.channelScope || null });
      }
      scheduleRefresh(true);
      scanVisibleMessages();
    }
  }

  function handleDiscordEvent(data) {
    if (!settings.rememberingEnabled) return;
    const eventType = data.eventType;

    if (eventType === "MESSAGE_DELETE") {
      (async () => {
        const result = await sendBackground({
          type: "DMH_MARK_DELETED_WITH_RECORD",
          channelId: data.channelId,
          id: data.id,
          record: data.previousRecord || { channelId: data.channelId, id: data.id },
          extra: { guildId: data.guildId, channelMeta: data.channelMeta }
        });

        const record = result?.record;
        historyCache.delete(data.channelId);

        if (record && settings.showingEnabled && data.channelId === parseCurrentChannelId()) {
          // Use the pre-delete placeholder immediately instead of waiting for the
          // slower full-history pass. This is especially important for attachments.
          restoreAtLiveAnchor(record);
          scheduleRefresh(true);
        }

        // Media persistence is intentionally separate from restoring the row. The
        // background worker keeps this request alive until the attachment is cached,
        // but the visible delete no longer waits on a network download.
        if (record?.attachments?.length) {
          sendBackground({ type: "DMH_CACHE_MESSAGE_ATTACHMENTS", channelId: record.channelId, id: record.id }).catch(() => {});
        }
      })().catch(() => {});
      return;
    }

    if (eventType === "MESSAGE_DELETE_BULK") {
      (async () => {
        const result = await sendBackground({
          type: "DMH_MARK_BULK_DELETED_WITH_RECORDS",
          channelId: data.channelId,
          ids: data.ids,
          records: data.previousRecords || [],
          extra: { guildId: data.guildId, channelMeta: data.channelMeta }
        });

        historyCache.delete(data.channelId);
        if (settings.showingEnabled && data.channelId === parseCurrentChannelId()) {
          for (const record of result?.records || []) restoreAtLiveAnchor(record);
          scheduleRefresh(true);
        }

        for (const record of result?.records || []) {
          if (record?.attachments?.length) {
            sendBackground({ type: "DMH_CACHE_MESSAGE_ATTACHMENTS", channelId: record.channelId, id: record.id }).catch(() => {});
          }
        }
      })().catch(() => {});
      return;
    }

    if (data.record) {
      (async () => {
        if (eventType === "MESSAGE_UPDATE" && data.previousRecord) {
          await sendBackground({ type: "DMH_UPSERT_MESSAGE", record: data.previousRecord, eventType: "MESSAGE_SNAPSHOT" });
        }
        await sendBackground({ type: "DMH_UPSERT_MESSAGE", record: data.record, eventType });
        if (data.record.attachments?.length) {
          sendBackground({ type: "DMH_CACHE_MESSAGE_ATTACHMENTS", channelId: data.record.channelId, id: data.record.id }).catch(() => {});
        }
        if (eventType === "MESSAGE_UPDATE") {
          historyCache.delete(data.record.channelId);
          if (data.record.channelId === parseCurrentChannelId()) scheduleRefresh(true);
        }
      })().catch(() => {});
    }
  }

  window.addEventListener("message", event => {
    if (event.source !== window || event.data?.source !== PAGE_SOURCE) return;
    const data = event.data;
    if (data.type === "DISCORD_EVENT") handleDiscordEvent(data);
    if (data.type === "HOOK_STATUS") {
      chrome.storage.local.set({
        hookStatus: {
          connected: Boolean(data.connected),
          dispatchPatched: Boolean(data.dispatchPatched),
          subscribed: Boolean(data.subscribed),
          hookMethod: data.hookMethod || null,
          webpackFound: Boolean(data.webpackFound),
          webpackCaptureMethod: data.webpackCaptureMethod || null,
          runtimeSnifferInstalled: Boolean(data.runtimeSnifferInstalled),
          lastHookEventAt: data.lastHookEventAt || null,
          messageStoreFound: Boolean(data.messageStoreFound),
          channelStoreFound: Boolean(data.channelStoreFound),
          error: data.error || null,
          updatedAt: Date.now()
        }
      }).catch(() => {});
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    let visibilityChanged = false;
    let rememberingChanged = false;

    for (const key of Object.keys(SETTINGS_DEFAULTS)) {
      if (changes[key]) {
        settings[key] = changes[key].newValue ?? SETTINGS_DEFAULTS[key];
        if (key === "showingEnabled") visibilityChanged = true;
        if (key === "rememberingEnabled") rememberingChanged = true;
      }
    }

    if (changes.quickCss) applyQuickCss();
    if (visibilityChanged || rememberingChanged) {
      postToPage("SET_LIVE_RESTORE_ENABLED", { enabled: Boolean(settings.rememberingEnabled && settings.showingEnabled) });
    }
    if (visibilityChanged) {
      if (!settings.showingEnabled) clearDecorations();
      else scheduleRefresh(true);
    }
    if (rememberingChanged && settings.rememberingEnabled) {
      const channelId = parseCurrentChannelId();
      if (channelId) {
        const context = parseCurrentContext();
        postToPage("REQUEST_CHANNEL_MESSAGES", { channelId, guildId: context?.guildId || null, channelScope: context?.channelScope || null });
      }
      scanVisibleMessages();
    }
  });

  async function init() {
    settings = { ...SETTINGS_DEFAULTS, ...(await chrome.storage.local.get(SETTINGS_DEFAULTS)) };
    applyQuickCss();
    currentChannelId = parseCurrentChannelId();
    // Wake the service worker and force the v2 storage migration before the
    // first capture burst. This also repairs malformed v1 databases in-place.
    sendBackground({ type: "DMH_STORAGE_HEALTH" }).catch(() => {});
    postToPage("SET_LIVE_RESTORE_ENABLED", { enabled: Boolean(settings.rememberingEnabled && settings.showingEnabled) });
    postToPage("PING_HOOK");
    if (settings.rememberingEnabled && currentChannelId) {
      const context = parseCurrentContext();
      postToPage("REQUEST_CHANNEL_MESSAGES", { channelId: currentChannelId, guildId: context?.guildId || null, channelScope: context?.channelScope || null });
    }

    observer = new MutationObserver(records => {
      // Ignore mutations that consist only of Message Memory injecting/removing its
      // own UI. Otherwise our edit-history render schedules another scan, which
      // renders again, and can continuously fight Discord's scroll anchoring.
      const isInjectedNode = node => {
        if (!(node instanceof Element)) return node.nodeType === Node.TEXT_NODE && node.parentElement?.closest?.("[data-dmh-injected]");
        return node.matches?.("[data-dmh-injected]") || Boolean(node.closest?.("[data-dmh-injected]"));
      };
      const onlyOurUi = records.length > 0 && records.every(record => {
        const changed = [...record.addedNodes, ...record.removedNodes];
        return changed.length > 0 && changed.every(isInjectedNode);
      });
      if (!onlyOurUi) scanVisibleMessages();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    routeTimer = setInterval(() => {
      if (location.href !== lastRoute) {
        lastRoute = location.href;
        onRouteChanged();
      }
    }, 150);

    // Keep the MAIN-world hook alive for long-running Discord tabs. This refreshes
    // hookStatus (so the toolbar/popup do not go stale) and asks the page hook to
    // verify/rebind Discord's current dispatcher if Discord hot-reloaded it.
    hookHeartbeatTimer = setInterval(() => {
      postToPage("PING_HOOK");
    }, 25_000);

    window.addEventListener("pageshow", () => postToPage("PING_HOOK"));
    window.addEventListener("focus", () => postToPage("PING_HOOK"));
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) postToPage("PING_HOOK");
    });

    scanVisibleMessages();
    scheduleRefresh(true);
  }

  init().catch(() => {});
})();
