const DB_NAME = "discord-message-memory";
const DB_VERSION = 1;
const DEFAULT_SETTINGS = {
  rememberingEnabled: true,
  showingEnabled: true,
  quickCss: "",
  sidebarCollapsed: false
};

let dbPromise;

const mediaJobs = new Map();
let activeMediaDownloads = 0;
const mediaWaiters = [];

async function acquireMediaSlot() {
  if (activeMediaDownloads < 3) {
    activeMediaDownloads += 1;
    return;
  }
  await new Promise(resolve => mediaWaiters.push(resolve));
  activeMediaDownloads += 1;
}

function releaseMediaSlot() {
  activeMediaDownloads = Math.max(0, activeMediaDownloads - 1);
  const next = mediaWaiters.shift();
  if (next) next();
}

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains("messages")) {
        const store = db.createObjectStore("messages", { keyPath: "key" });
        store.createIndex("channelId", "channelId", { unique: false });
        store.createIndex("guildId", "guildId", { unique: false });
      }

      if (!db.objectStoreNames.contains("media")) {
        const store = db.createObjectStore("media", { keyPath: "key" });
        store.createIndex("channelId", "channelId", { unique: false });
        store.createIndex("messageKey", "messageKey", { unique: false });
      }

      if (!db.objectStoreNames.contains("channels")) {
        db.createObjectStore("channels", { keyPath: "channelId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Transaction aborted"));
  });
}

function messageKey(channelId, messageId) {
  return `${channelId}:${messageId}`;
}

function mediaKey(channelId, messageId, attachmentId, index = 0) {
  return `${channelId}:${messageId}:${attachmentId || index}`;
}

function compareSnowflakes(a, b) {
  const aa = String(a || "");
  const bb = String(b || "");
  if (aa.length !== bb.length) return aa.length - bb.length;
  return aa.localeCompare(bb);
}

function shallowDefinedMerge(base, incoming) {
  const out = { ...(base || {}) };
  for (const [key, value] of Object.entries(incoming || {})) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function mergeAuthorData(existing, incoming) {
  if (!existing) return incoming || null;
  if (!incoming) return existing;
  const merged = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    // DOM snapshots are mainly an enrichment fallback. Do not replace good Flux
    // author values with null/empty values, but do fill fields such as avatarUrl.
    if ((merged[key] === undefined || merged[key] === null || merged[key] === "") && value !== undefined && value !== null && value !== "") {
      merged[key] = value;
    }
  }
  return merged;
}

function normalizeAttachmentKeys(record) {
  const attachments = Array.isArray(record.attachments) ? record.attachments : [];
  return attachments.map((attachment, index) => ({
    ...attachment,
    _dmhMediaKey: mediaKey(record.channelId, record.id, attachment?.id, index)
  }));
}

function attachmentSignature(attachments) {
  return JSON.stringify((Array.isArray(attachments) ? attachments : []).map(item => ({
    id: item?.id || null,
    filename: item?.filename || null,
    size: item?.size || 0,
    url: item?.url || null,
    proxyUrl: item?.proxyUrl || item?.proxy_url || null,
    contentType: item?.contentType || item?.content_type || null,
    width: item?.width ?? null,
    height: item?.height ?? null,
    durationSecs: item?.durationSecs ?? item?.duration_secs ?? null
  })));
}

async function upsertChannelMeta(record) {
  if (!record?.channelId) return;
  const db = await openDb();
  const tx = db.transaction("channels", "readwrite");
  const store = tx.objectStore("channels");
  const old = await requestToPromise(store.get(record.channelId));
  const meta = record.channelMeta || {};
  store.put({
    channelId: record.channelId,
    guildId: record.guildId || meta.guildId || old?.guildId || null,
    channelName: meta.channelName || old?.channelName || null,
    guildName: meta.guildName || old?.guildName || null,
    selfName: meta.selfName || old?.selfName || null,
    selfUserId: meta.selfUserId || old?.selfUserId || null,
    recipientNames: Array.isArray(meta.recipientNames) && meta.recipientNames.length ? meta.recipientNames : (old?.recipientNames || []),
    recipientIds: Array.isArray(meta.recipientIds) && meta.recipientIds.length ? meta.recipientIds : (old?.recipientIds || []),
    channelType: meta.channelType ?? old?.channelType ?? null,
    parentId: meta.parentId || old?.parentId || null,
    isThread: meta.isThread ?? old?.isThread ?? false,
    scope: meta.scope || record.channelScope || old?.scope || (record.guildId ? "server" : "private"),
    lastSeenAt: Date.now()
  });
  await txDone(tx);
}

async function getMessage(channelId, messageId) {
  const db = await openDb();
  const tx = db.transaction("messages", "readonly");
  return requestToPromise(tx.objectStore("messages").get(messageKey(channelId, messageId)));
}

async function upsertMessage(incoming, eventType = "MESSAGE_CREATE") {
  if (!incoming?.channelId || !incoming?.id) return { ok: false, reason: "missing-id" };

  const db = await openDb();
  const key = messageKey(incoming.channelId, incoming.id);
  const tx = db.transaction("messages", "readwrite");
  const store = tx.objectStore("messages");
  const old = await requestToPromise(store.get(key));

  let editHistory = Array.isArray(old?.editHistory) ? [...old.editHistory] : [];
  if (eventType === "MESSAGE_UPDATE" && old) {
    const contentChanged = incoming.content !== undefined && incoming.content !== old.content;
    const attachmentChanged = incoming.attachments !== undefined && attachmentSignature(incoming.attachments) !== attachmentSignature(old.attachments);
    if (contentChanged || attachmentChanged) {
      const last = editHistory[editHistory.length - 1];
      const historical = {
        content: old.content ?? "",
        attachments: old.attachments || [],
        editedAt: incoming.editedTimestamp || new Date().toISOString(),
        capturedAt: Date.now()
      };
      if (!last || last.content !== historical.content || JSON.stringify(last.attachments) !== JSON.stringify(historical.attachments)) {
        editHistory.push(historical);
      }
    }
  }

  const merged = shallowDefinedMerge(old, incoming);
  merged.key = key;
  merged.channelId = incoming.channelId;
  merged.id = incoming.id;
  merged.firstSeenAt = old?.firstSeenAt || Date.now();
  merged.lastSeenAt = Date.now();
  merged.editHistory = editHistory;
  merged.deleted = old?.deleted || Boolean(incoming.deleted);
  merged.deletedAt = incoming.deletedAt || old?.deletedAt || null;
  merged.snapshotHtml = incoming.snapshotHtml || old?.snapshotHtml || null;
  merged.attachments = normalizeAttachmentKeys(merged);

  store.put(merged);
  await txDone(tx);
  await upsertChannelMeta(merged);

  // Keep attachments inside the extension rather than relying on Discord's expiring CDN URLs.
  await cacheAttachments(merged).catch(() => {});
  return { ok: true, record: merged };
}

async function saveSnapshot(payload) {
  if (!payload?.channelId || !payload?.id) return { ok: false };
  const db = await openDb();
  const key = messageKey(payload.channelId, payload.id);
  const tx = db.transaction("messages", "readwrite");
  const store = tx.objectStore("messages");
  const old = await requestToPromise(store.get(key));
  const merged = {
    ...(old || {}),
    key,
    channelId: payload.channelId,
    id: payload.id,
    content: old?.content ?? payload.content ?? "",
    author: mergeAuthorData(old?.author, payload.author),
    timestamp: old?.timestamp || payload.timestamp || null,
    firstSeenAt: old?.firstSeenAt || Date.now(),
    lastSeenAt: Date.now(),
    snapshotHtml: payload.snapshotHtml || old?.snapshotHtml || null,
    editHistory: old?.editHistory || [],
    deleted: old?.deleted || false,
    deletedAt: old?.deletedAt || null,
    attachments: normalizeAttachmentKeys({
      channelId: payload.channelId,
      id: payload.id,
      attachments: old?.attachments || payload.attachments || []
    })
  };
  store.put(merged);
  await txDone(tx);
  await cacheAttachments(merged).catch(() => {});
  return { ok: true, record: merged };
}

async function markDeletedWithRecord(incoming, extra = {}) {
  const channelId = incoming?.channelId || extra.channelId;
  const id = incoming?.id || extra.id;
  if (!channelId || !id) return { ok: false };

  const db = await openDb();
  const key = messageKey(channelId, id);
  const tx = db.transaction("messages", "readwrite");
  const store = tx.objectStore("messages");
  const old = await requestToPromise(store.get(key));
  const merged = shallowDefinedMerge(old, incoming || {});

  merged.key = key;
  merged.channelId = String(channelId);
  merged.id = String(id);
  merged.guildId = incoming?.guildId || extra.guildId || old?.guildId || null;
  merged.channelMeta = incoming?.channelMeta || extra.channelMeta || old?.channelMeta || null;
  merged.firstSeenAt = old?.firstSeenAt || Date.now();
  merged.lastSeenAt = Date.now();
  merged.deleted = true;
  merged.deletedAt = new Date().toISOString();
  merged.editHistory = Array.isArray(old?.editHistory) ? old.editHistory : (Array.isArray(incoming?.editHistory) ? incoming.editHistory : []);
  merged.snapshotHtml = incoming?.snapshotHtml || old?.snapshotHtml || null;
  merged.attachments = normalizeAttachmentKeys(merged);

  store.put(merged);
  await txDone(tx);
  await upsertChannelMeta(merged);

  // Deliberately do not wait for attachment downloads here. A live deletion must
  // be able to restore its row immediately; media caching is queued separately.
  return { ok: true, record: merged };
}

async function markBulkDeletedWithRecords(channelId, ids, previousRecords = [], extra = {}) {
  const byId = new Map((previousRecords || []).filter(Boolean).map(record => [String(record.id), record]));
  const records = [];
  for (const id of ids || []) {
    const messageId = String(id);
    const incoming = byId.get(messageId) || { channelId: String(channelId), id: messageId };
    const result = await markDeletedWithRecord(incoming, { ...extra, channelId: String(channelId), id: messageId });
    if (result?.record) records.push(result.record);
  }
  return { ok: true, count: records.length, records };
}

async function cacheMessageAttachments(channelId, id) {
  const record = await getMessage(channelId, id);
  if (!record) return { ok: false, reason: "missing-message" };
  await cacheAttachments(record).catch(() => {});
  return { ok: true };
}

async function markDeleted(channelId, id, extra = {}) {
  if (!channelId || !id) return { ok: false };
  const db = await openDb();
  const key = messageKey(channelId, id);
  const tx = db.transaction("messages", "readwrite");
  const store = tx.objectStore("messages");
  const old = await requestToPromise(store.get(key));
  const record = {
    ...(old || {}),
    key,
    channelId,
    id,
    guildId: extra.guildId || old?.guildId || null,
    channelMeta: extra.channelMeta || old?.channelMeta || null,
    firstSeenAt: old?.firstSeenAt || Date.now(),
    lastSeenAt: Date.now(),
    deleted: true,
    deletedAt: new Date().toISOString(),
    editHistory: old?.editHistory || [],
    attachments: normalizeAttachmentKeys({ channelId, id, attachments: old?.attachments || [] })
  };
  store.put(record);
  await txDone(tx);
  await upsertChannelMeta(record);
  return { ok: true, record };
}

async function markBulkDeleted(channelId, ids, extra = {}) {
  const results = [];
  for (const id of ids || []) results.push(await markDeleted(channelId, id, extra));
  return { ok: true, count: results.length };
}

async function getChannelHistory(channelId) {
  if (!channelId) return [];
  const db = await openDb();
  const tx = db.transaction("messages", "readonly");
  const index = tx.objectStore("messages").index("channelId");
  const all = await requestToPromise(index.getAll(IDBKeyRange.only(channelId)));
  return all
    .filter(record => record.deleted || (record.editHistory && record.editHistory.length))
    .sort((a, b) => compareSnowflakes(a.id, b.id));
}

async function cacheSingleAttachment(record, attachment) {
  const url = attachment?.url || attachment?.proxyUrl || attachment?.proxy_url;
  const key = attachment?._dmhMediaKey;
  if (!url || !key) return;

  if (mediaJobs.has(key)) return mediaJobs.get(key);
  const job = (async () => {
    const db = await openDb();
    const readTx = db.transaction("media", "readonly");
    const existing = await requestToPromise(readTx.objectStore("media").get(key));
    if (existing?.blob) return;

    await acquireMediaSlot();
    try {
      // Another tab may have completed the same attachment while this job waited.
      const secondRead = db.transaction("media", "readonly");
      const nowExisting = await requestToPromise(secondRead.objectStore("media").get(key));
      if (nowExisting?.blob) return;

      try {
        const response = await fetch(url, { credentials: "omit", cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        const writeTx = db.transaction("media", "readwrite");
        writeTx.objectStore("media").put({
          key,
          channelId: record.channelId,
          messageKey: record.key,
          messageId: record.id,
          attachmentId: attachment.id || null,
          filename: attachment.filename || "attachment",
          contentType: attachment.contentType || attachment.content_type || blob.type || "application/octet-stream",
          size: blob.size,
          sourceUrl: url,
          cachedAt: Date.now(),
          blob
        });
        await txDone(writeTx);
      } catch (error) {
        const writeTx = db.transaction("media", "readwrite");
        writeTx.objectStore("media").put({
          key,
          channelId: record.channelId,
          messageKey: record.key,
          messageId: record.id,
          attachmentId: attachment.id || null,
          filename: attachment.filename || "attachment",
          contentType: attachment.contentType || attachment.content_type || "application/octet-stream",
          size: attachment.size || 0,
          sourceUrl: url,
          cachedAt: null,
          lastCacheError: String(error?.message || error),
          blob: null
        });
        await txDone(writeTx);
      }
    } finally {
      releaseMediaSlot();
    }
  })().finally(() => mediaJobs.delete(key));

  mediaJobs.set(key, job);
  return job;
}

async function cacheAttachments(record) {
  const attachments = Array.isArray(record?.attachments) ? record.attachments : [];
  if (!attachments.length) return;
  await Promise.allSettled(attachments.map(attachment => cacheSingleAttachment(record, attachment)));
}

async function listChats() {
  const db = await openDb();
  const [messages, channels, media] = await Promise.all([
    requestToPromise(db.transaction("messages", "readonly").objectStore("messages").getAll()),
    requestToPromise(db.transaction("channels", "readonly").objectStore("channels").getAll()),
    requestToPromise(db.transaction("media", "readonly").objectStore("media").getAll())
  ]);

  const channelMeta = new Map(channels.map(item => [item.channelId, item]));
  const aggregates = new Map();

  for (const record of messages) {
    if (!aggregates.has(record.channelId)) {
      aggregates.set(record.channelId, {
        channelId: record.channelId,
        guildId: record.guildId || null,
        scope: record.channelScope || (record.guildId ? "server" : "private"),
        messageCount: 0,
        deletedCount: 0,
        editedCount: 0,
        mediaCount: 0,
        mediaBytes: 0,
        lastSeenAt: 0,
        authorNames: [],
        authorIds: []
      });
    }
    const agg = aggregates.get(record.channelId);
    agg.messageCount += 1;
    if (record.deleted) agg.deletedCount += 1;
    if (record.editHistory?.length) agg.editedCount += 1;
    agg.lastSeenAt = Math.max(agg.lastSeenAt, record.lastSeenAt || record.firstSeenAt || 0);
    const author = record.author || {};
    const authorName = author.globalName || author.global_name || author.username || null;
    const authorId = author.id != null ? String(author.id) : null;
    if (authorName && !agg.authorNames.includes(authorName)) agg.authorNames.push(authorName);
    if (authorId && !agg.authorIds.includes(authorId)) agg.authorIds.push(authorId);
  }

  for (const item of media) {
    const agg = aggregates.get(item.channelId);
    if (!agg) continue;
    if (item.blob) {
      agg.mediaCount += 1;
      agg.mediaBytes += item.blob.size || item.size || 0;
    }
  }

  return [...aggregates.values()]
    .map(agg => ({ ...agg, ...(channelMeta.get(agg.channelId) || {}) }))
    .sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
}

async function deleteChat(channelId) {
  const db = await openDb();

  const msgTx = db.transaction("messages", "readwrite");
  const msgIndex = msgTx.objectStore("messages").index("channelId");
  const msgKeys = await requestToPromise(msgIndex.getAllKeys(IDBKeyRange.only(channelId)));
  for (const key of msgKeys) msgTx.objectStore("messages").delete(key);
  await txDone(msgTx);

  const mediaTx = db.transaction("media", "readwrite");
  const mediaIndex = mediaTx.objectStore("media").index("channelId");
  const mediaKeys = await requestToPromise(mediaIndex.getAllKeys(IDBKeyRange.only(channelId)));
  for (const key of mediaKeys) mediaTx.objectStore("media").delete(key);
  await txDone(mediaTx);

  const channelTx = db.transaction("channels", "readwrite");
  channelTx.objectStore("channels").delete(channelId);
  await txDone(channelTx);

  return { ok: true, messagesDeleted: msgKeys.length, mediaDeleted: mediaKeys.length };
}

async function deleteAllData() {
  const db = await openDb();
  const tx = db.transaction(["messages", "media", "channels"], "readwrite");
  tx.objectStore("messages").clear();
  tx.objectStore("media").clear();
  tx.objectStore("channels").clear();
  await txDone(tx);
  return { ok: true };
}

async function getStats() {
  const db = await openDb();
  const [messageCount, mediaCount, chats] = await Promise.all([
    requestToPromise(db.transaction("messages", "readonly").objectStore("messages").count()),
    requestToPromise(db.transaction("media", "readonly").objectStore("media").count()),
    listChats()
  ]);
  let usage = null;
  let quota = null;
  try {
    const estimate = await navigator.storage.estimate();
    usage = estimate.usage ?? null;
    quota = estimate.quota ?? null;
  } catch {}

  return {
    messageCount,
    mediaCount,
    channelCount: chats.length,
    mediaBytes: chats.reduce((sum, chat) => sum + (chat.mediaBytes || 0), 0),
    usage,
    quota
  };
}

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  const missing = {};
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (current[key] === undefined) missing[key] = value;
  }
  if (Object.keys(missing).length) await chrome.storage.local.set(missing);
  openDb().catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "DMH_UPSERT_MESSAGE":
        return upsertMessage(message.record, message.eventType);
      case "DMH_SAVE_SNAPSHOT":
        return saveSnapshot(message.record);
      case "DMH_MARK_DELETED_WITH_RECORD":
        return markDeletedWithRecord(message.record || { channelId: message.channelId, id: message.id }, { ...(message.extra || {}), channelId: message.channelId, id: message.id });
      case "DMH_MARK_BULK_DELETED_WITH_RECORDS":
        return markBulkDeletedWithRecords(message.channelId, message.ids, message.records, message.extra);
      case "DMH_CACHE_MESSAGE_ATTACHMENTS":
        return cacheMessageAttachments(message.channelId, message.id);
      case "DMH_MARK_DELETED":
        return markDeleted(message.channelId, message.id, message.extra);
      case "DMH_MARK_BULK_DELETED":
        return markBulkDeleted(message.channelId, message.ids, message.extra);
      case "DMH_GET_MESSAGE":
        return getMessage(message.channelId, message.id);
      case "DMH_GET_CHANNEL_HISTORY":
        return getChannelHistory(message.channelId);
      case "DMH_LIST_CHATS":
        return listChats();
      case "DMH_DELETE_CHAT":
        return deleteChat(message.channelId);
      case "DMH_DELETE_ALL":
        return deleteAllData();
      case "DMH_GET_STATS":
        return getStats();
      default:
        return { ok: false, reason: "unknown-message" };
    }
  })().then(sendResponse).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
  return true;
});

function bytesToBase64(bytes) {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== "dmh-media") return;
  let cancelled = false;
  port.onDisconnect.addListener(() => { cancelled = true; });

  port.onMessage.addListener(async message => {
    if (message?.type !== "GET_MEDIA" || !message.key) return;
    try {
      const db = await openDb();
      const tx = db.transaction("media", "readonly");
      const item = await requestToPromise(tx.objectStore("media").get(message.key));
      if (!item?.blob) {
        port.postMessage({ type: "ERROR", error: item?.lastCacheError || "Cached media is unavailable." });
        return;
      }

      port.postMessage({
        type: "META",
        contentType: item.contentType || item.blob.type || "application/octet-stream",
        filename: item.filename || "attachment",
        size: item.blob.size
      });

      const reader = item.blob.stream().getReader();
      while (!cancelled) {
        const { value, done } = await reader.read();
        if (done) break;
        port.postMessage({ type: "CHUNK", data: bytesToBase64(value) });
      }
      if (!cancelled) port.postMessage({ type: "END" });
    } catch (error) {
      if (!cancelled) port.postMessage({ type: "ERROR", error: String(error?.message || error) });
    }
  });
});
