(() => {
  "use strict";

  const OUT_SOURCE = "discord-message-memory-page";
  const IN_SOURCE = "discord-message-memory-content";
  const LOAD_EVENTS = [
    "LOAD_MESSAGES_SUCCESS",
    "LOAD_MESSAGES_AROUND_SUCCESS",
    "LOAD_MESSAGES_BEFORE_SUCCESS",
    "LOAD_MESSAGES_AFTER_SUCCESS"
  ];

  let webpackRequire = null;
  let webpackCaptureMethod = "none";
  let runtimeSnifferInstalled = false;
  const webpackCandidates = new Set();
  let dispatcher = null;
  let messageStore = null;
  let channelStore = null;
  let guildStore = null;
  let userStore = null;
  let subscribed = false;
  let dispatchPatched = false;
  let lastHookEventAt = 0;
  let liveRestoreEnabled = false;
  let hookMethod = "none";
  let lastProgressStatusAt = 0;
  const recentEvents = new Map();

  function post(type, payload = {}) {
    window.postMessage({ source: OUT_SOURCE, type, ...payload }, "*");
  }

  function safeGet(object, key) {
    try { return object?.[key]; } catch { return undefined; }
  }

  function candidatesFromExports(exportsObject) {
    const list = [];
    const add = value => {
      if ((typeof value === "object" && value) || typeof value === "function") {
        if (!list.includes(value)) list.push(value);
      }
    };

    add(exportsObject);
    for (const key of ["default", "Z", "ZP", "A", "Ay", "h"]) add(safeGet(exportsObject, key));

    try {
      for (const value of Object.values(exportsObject || {})) add(value);
    } catch {}
    return list;
  }

  function findModule(predicate) {
    if (!webpackRequire?.c) return null;
    for (const mod of Object.values(webpackRequire.c)) {
      const exportsObject = safeGet(mod, "exports");
      for (const candidate of candidatesFromExports(exportsObject)) {
        try {
          if (predicate(candidate)) return candidate;
        } catch {}
      }
    }
    return null;
  }

  function webpackCandidateScore(req) {
    if (typeof req !== "function") return -1;
    let score = 0;
    const modules = safeGet(req, "m");
    const cache = safeGet(req, "c");
    if (modules && typeof modules === "object") score += 10;
    if (cache && typeof cache === "object") {
      score += 20;
      try { score += Math.min(Object.keys(cache).length, 500); } catch {}
    }
    if (safeGet(req, "p") === "/assets/") score += 2000;
    if (typeof safeGet(req, "u") === "function") score += 40;
    if (typeof safeGet(req, "e") === "function") score += 40;
    if (typeof safeGet(req, "l") === "function") score += 20;
    return score;
  }

  function acceptWebpackRequire(req, method) {
    if (typeof req !== "function") return false;
    const modules = safeGet(req, "m");
    const cache = safeGet(req, "c");
    if (!modules || typeof modules !== "object" || !cache || typeof cache !== "object") return false;

    const currentScore = webpackCandidateScore(webpackRequire);
    const nextScore = webpackCandidateScore(req);
    if (!webpackRequire || nextScore > currentScore) {
      webpackRequire = req;
      webpackCaptureMethod = method || "Webpack runtime sniffer";
      return true;
    }
    if (req === webpackRequire) return true;
    return false;
  }

  function inspectWebpackCandidate(req, method = "Webpack runtime sniffer") {
    if (typeof req !== "function") return false;
    // Current Discord's main Webpack instance exposes /assets/ as its public path.
    // Prefer that exact signal, but retain a scored fallback so minor runtime changes
    // do not completely disable the extension.
    if (safeGet(req, "p") === "/assets/") return acceptWebpackRequire(req, method);
    const score = webpackCandidateScore(req);
    if (score >= 100) return acceptWebpackRequire(req, `${method} fallback`);
    return false;
  }

  function watchWebpackCandidatePublicPath(req) {
    if (typeof req !== "function") return;
    if (Object.prototype.hasOwnProperty.call(req, "p")) {
      inspectWebpackCandidate(req);
      return;
    }

    try {
      let armed = true;
      Object.defineProperty(req, "p", {
        configurable: true,
        enumerable: false,
        get() { return undefined; },
        set(value) {
          if (!armed) return;
          armed = false;
          try {
            Object.defineProperty(req, "p", { configurable: true, writable: true, enumerable: true, value });
          } catch {}
          inspectWebpackCandidate(req, value === "/assets/" ? "Webpack runtime sniffer (/assets/)" : "Webpack runtime sniffer");
        }
      });
    } catch {}
  }

  function installWebpackRuntimeSniffer() {
    if (runtimeSnifferInstalled) return true;
    const proto = Function.prototype;
    const existing = Object.getOwnPropertyDescriptor(proto, "m");

    // Vencord's current Webpack interception uses this same general seam: Webpack
    // assigns its module-factory table to require.m while booting. Intercepting that
    // assignment at document_start works even when webpackChunkdiscord_app is absent.
    if (existing) {
      runtimeSnifferInstalled = false;
      return false;
    }

    try {
      Object.defineProperty(proto, "m", {
        configurable: true,
        enumerable: false,
        set(value) {
          try {
            Object.defineProperty(this, "m", { configurable: true, writable: true, enumerable: true, value });
          } catch { return; }

          if (typeof this !== "function" || !value || typeof value !== "object") return;
          webpackCandidates.add(this);
          watchWebpackCandidatePublicPath(this);
          queueMicrotask(() => inspectWebpackCandidate(this));
          setTimeout(() => inspectWebpackCandidate(this), 0);
        }
      });
      runtimeSnifferInstalled = true;
      return true;
    } catch {
      runtimeSnifferInstalled = false;
      return false;
    }
  }

  function inspectWebpackCandidates() {
    for (const candidate of webpackCandidates) inspectWebpackCandidate(candidate);
    return webpackRequire;
  }

  function captureWebpackRequire() {
    // Always rescore candidates. Discord currently creates several Webpack-like
    // runtimes (for example fast-connect/libdiscore) before/alongside the main app.
    // The main runtime's /assets/ public path gives it a much higher score.
    inspectWebpackCandidates();
    if (webpackRequire?.c && safeGet(webpackRequire, "p") === "/assets/") return webpackRequire;

    // Legacy/fallback capture for Discord builds that still expose the old chunk array.
    const chunk = window.webpackChunkdiscord_app;
    if (!chunk?.push) return null;
    try {
      const token = `dmh_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      let captured = null;
      chunk.push([[token], {}, req => { captured = req; }]);
      chunk.pop();
      if (captured) acceptWebpackRequire(captured, "webpackChunkdiscord_app fallback");
    } catch {}
    return webpackRequire;
  }

  function looksLikeDispatcher(value) {
    return Boolean(value &&
      typeof safeGet(value, "dispatch") === "function" &&
      typeof safeGet(value, "subscribe") === "function" &&
      typeof safeGet(value, "unsubscribe") === "function");
  }

  function dispatcherFromStore(store) {
    const candidate = safeGet(store, "_dispatcher");
    return looksLikeDispatcher(candidate) ? candidate : null;
  }

  function findStoreByName(name) {
    const direct = findModule(store => {
      try {
        if (safeGet(safeGet(store, "constructor"), "displayName") === name) return true;
        if (typeof safeGet(store, "getName") === "function" && store.getName() === name) return true;
      } catch {}
      return false;
    });
    if (direct) return direct;

    // Newer Vencord builds also enumerate Flux.Store.getAll() first because some
    // store instances are easier to locate there than by their export shape.
    const flux = findModule(value => typeof safeGet(safeGet(value, "Store"), "getAll") === "function");
    try {
      const stores = flux?.Store?.getAll?.();
      if (stores && typeof stores[Symbol.iterator] === "function") {
        for (const store of stores) {
          try { if (store?.getName?.() === name || store?.constructor?.displayName === name) return store; } catch {}
        }
      }
    } catch {}
    return null;
  }

  function discoverStores() {
    captureWebpackRequire();
    if (!webpackRequire) return false;

    if (!messageStore) {
      messageStore = findStoreByName("MessageStore") || findModule(m =>
        typeof safeGet(m, "getMessage") === "function" &&
        typeof safeGet(m, "getMessages") === "function"
      );
    }

    // Discord Flux stores expose the exact dispatcher instance they are registered
    // with as _dispatcher. Prefer this over finding an arbitrary export which happens
    // to have dispatch/subscribe-shaped methods.
    if (!dispatcher) dispatcher = dispatcherFromStore(messageStore);
    if (!dispatcher) {
      const storeWithDispatcher = findModule(m => dispatcherFromStore(m));
      dispatcher = dispatcherFromStore(storeWithDispatcher);
    }
    if (!dispatcher) dispatcher = findModule(looksLikeDispatcher);

    if (!channelStore) {
      channelStore = findStoreByName("ChannelStore") || findModule(m =>
        typeof safeGet(m, "getChannel") === "function" &&
        (typeof safeGet(m, "getDMFromUserId") === "function" || typeof safeGet(m, "getMutableGuildChannelsForGuild") === "function" || typeof safeGet(m, "getAllThreadsForParent") === "function")
      ) || findModule(m => typeof safeGet(m, "getChannel") === "function");
    }

    if (!guildStore) {
      guildStore = findStoreByName("GuildStore") || findModule(m => typeof safeGet(m, "getGuild") === "function" && typeof safeGet(m, "getGuilds") === "function");
    }

    if (!userStore) {
      userStore = findStoreByName("UserStore") || findModule(m =>
        typeof safeGet(m, "getCurrentUser") === "function" && typeof safeGet(m, "getUser") === "function"
      );
    }

    return Boolean(dispatcher);
  }

  function toIso(value) {
    if (!value) return null;
    if (typeof value === "string") return value;
    if (typeof value === "number") {
      try { return new Date(value).toISOString(); } catch { return String(value); }
    }
    try {
      if (typeof value.toISOString === "function") return value.toISOString();
    } catch {}
    return String(value);
  }

  function plain(value, depth = 0, seen = new WeakSet()) {
    if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "function" || typeof value === "symbol") return undefined;
    if (depth > 5) return undefined;
    if (value instanceof Date) return value.toISOString();

    if (typeof value === "object") {
      if (seen.has(value)) return undefined;
      seen.add(value);
    }

    if (Array.isArray(value)) {
      return value.slice(0, 250).map(item => plain(item, depth + 1, seen)).filter(item => item !== undefined);
    }

    const out = {};
    let keys = [];
    try { keys = Object.keys(value).slice(0, 250); } catch { return undefined; }
    for (const key of keys) {
      if (["token", "email", "phone"].includes(key)) continue;
      try {
        const converted = plain(value[key], depth + 1, seen);
        if (converted !== undefined) out[key] = converted;
      } catch {}
    }
    return out;
  }

  function normalizeAuthor(author) {
    if (!author) return null;
    return {
      id: safeGet(author, "id") || null,
      username: safeGet(author, "username") || safeGet(author, "name") || null,
      globalName: safeGet(author, "global_name") || safeGet(author, "globalName") || null,
      discriminator: safeGet(author, "discriminator") || null,
      avatar: safeGet(author, "avatar") || null,
      avatarDecorationData: plain(safeGet(author, "avatar_decoration_data") || safeGet(author, "avatarDecorationData")),
      bot: Boolean(safeGet(author, "bot")),
      system: Boolean(safeGet(author, "system"))
    };
  }

  function normalizeAttachment(attachment) {
    if (!attachment) return null;
    return {
      id: safeGet(attachment, "id") || null,
      filename: safeGet(attachment, "filename") || safeGet(attachment, "name") || "attachment",
      title: safeGet(attachment, "title") || null,
      description: safeGet(attachment, "description") || null,
      size: Number(safeGet(attachment, "size") || 0),
      url: safeGet(attachment, "url") || null,
      proxyUrl: safeGet(attachment, "proxy_url") || safeGet(attachment, "proxyUrl") || null,
      contentType: safeGet(attachment, "content_type") || safeGet(attachment, "contentType") || null,
      width: safeGet(attachment, "width") ?? null,
      height: safeGet(attachment, "height") ?? null,
      durationSecs: safeGet(attachment, "duration_secs") ?? safeGet(attachment, "durationSecs") ?? null,
      waveform: safeGet(attachment, "waveform") || null,
      flags: safeGet(attachment, "flags") ?? null,
      spoiler: Boolean(safeGet(attachment, "spoiler"))
    };
  }

  function classifyChannel(channel, guildId = null) {
    const type = Number(safeGet(channel, "type"));
    if (type === 1) return "dm";
    if (type === 3) return "group_dm";
    if (guildId) return "server";
    // Discord omits guild_id for private channels. If the channel store is not
    // available yet, keep it explicitly private rather than treating it as a guild.
    return "private";
  }

  function getChannelMeta(channelId, guildIdHint = null) {
    let channel = null;
    try { channel = channelStore?.getChannel?.(channelId) || null; } catch {}

    const guildId = guildIdHint || safeGet(channel, "guild_id") || safeGet(channel, "guildId") || null;
    let guild = null;
    try { guild = guildId ? guildStore?.getGuild?.(guildId) : null; } catch {}

    let currentUser = null;
    try { currentUser = userStore?.getCurrentUser?.() || null; } catch {}
    const currentUserId = safeGet(currentUser, "id") ? String(safeGet(currentUser, "id")) : null;
    const selfName = safeGet(currentUser, "globalName") || safeGet(currentUser, "global_name") || safeGet(currentUser, "username") || null;

    const recipientNames = [];
    const recipientIds = [];
    const addRecipient = value => {
      if (value == null) return;
      let user = value;
      if (typeof value === "string" || typeof value === "number") {
        const id = String(value);
        try { user = userStore?.getUser?.(id) || { id }; } catch { user = { id }; }
      }
      const idRaw = safeGet(user, "id");
      const id = idRaw != null ? String(idRaw) : null;
      if (id && currentUserId && id === currentUserId) return;
      const name = safeGet(user, "globalName") || safeGet(user, "global_name") || safeGet(user, "username") || null;
      if (id && !recipientIds.includes(id)) recipientIds.push(id);
      if (name && !recipientNames.includes(name)) recipientNames.push(name);
    };

    try {
      const recipients = safeGet(channel, "rawRecipients") || safeGet(channel, "recipients");
      if (Array.isArray(recipients)) recipients.forEach(addRecipient);
      else if (recipients && typeof recipients[Symbol.iterator] === "function") {
        for (const recipient of recipients) addRecipient(recipient);
      }
      addRecipient(safeGet(channel, "recipientId") || safeGet(channel, "recipient_id"));
    } catch {}

    let channelName = safeGet(channel, "name") || null;
    if (!channelName && recipientNames.length) channelName = recipientNames.join(", ");

    const parentId = safeGet(channel, "parent_id") || safeGet(channel, "parentId") || null;
    const type = safeGet(channel, "type") ?? null;
    const numericType = Number(type);
    const isThread = numericType === 10 || numericType === 11 || numericType === 12;

    return {
      channelId,
      guildId,
      channelName,
      guildName: safeGet(guild, "name") || null,
      selfName,
      selfUserId: currentUserId,
      recipientNames,
      recipientIds,
      channelType: type,
      parentId: parentId ? String(parentId) : null,
      isThread,
      scope: classifyChannel(channel, guildId)
    };
  }

  function normalizeMessage(message, channelIdHint = null, guildIdHint = null, partial = false) {
    if (!message) return null;
    const id = safeGet(message, "id");
    const channelId = safeGet(message, "channel_id") || safeGet(message, "channelId") || channelIdHint;
    if (!id || !channelId) return null;
    const channelMeta = getChannelMeta(String(channelId), guildIdHint);
    const guildId = safeGet(message, "guild_id") || safeGet(message, "guildId") || guildIdHint || channelMeta.guildId || null;
    const resolvedChannelMeta = guildId && !channelMeta.guildId ? getChannelMeta(String(channelId), String(guildId)) : channelMeta;

    const contentRaw = safeGet(message, "content");
    const timestampRaw = safeGet(message, "timestamp");
    const editedRaw = safeGet(message, "edited_timestamp") ?? safeGet(message, "editedTimestamp");
    const authorRaw = safeGet(message, "author");
    const attachmentsRaw = safeGet(message, "attachments");
    const embedsRaw = safeGet(message, "embeds");
    const stickersRaw = safeGet(message, "sticker_items") ?? safeGet(message, "stickerItems") ?? safeGet(message, "stickers");
    const componentsRaw = safeGet(message, "components");
    const pollRaw = safeGet(message, "poll");
    const mentionsRaw = safeGet(message, "mentions");
    const mentionRolesRaw = safeGet(message, "mention_roles") ?? safeGet(message, "mentionRoles");
    const reactionsRaw = safeGet(message, "reactions");
    const referencedRaw = safeGet(message, "referenced_message") ?? safeGet(message, "referencedMessage");
    const messageReferenceRaw = safeGet(message, "message_reference") ?? safeGet(message, "messageReference");
    const flagsRaw = safeGet(message, "flags");
    const typeRaw = safeGet(message, "type");
    const pinnedRaw = safeGet(message, "pinned");
    const ttsRaw = safeGet(message, "tts");
    const threadRaw = safeGet(message, "thread");

    const record = {
      id: String(id),
      channelId: String(channelId),
      guildId: guildId ? String(guildId) : null,
      content: contentRaw ?? "",
      timestamp: toIso(timestampRaw),
      editedTimestamp: toIso(editedRaw),
      author: normalizeAuthor(authorRaw),
      attachments: Array.isArray(attachmentsRaw) ? attachmentsRaw.map(normalizeAttachment).filter(Boolean) : [],
      embeds: plain(embedsRaw) || [],
      stickers: plain(stickersRaw) || [],
      components: plain(componentsRaw) || [],
      poll: plain(pollRaw) || null,
      mentions: plain(mentionsRaw) || [],
      mentionRoles: plain(mentionRolesRaw) || [],
      reactions: plain(reactionsRaw) || [],
      referencedMessage: plain(referencedRaw) || null,
      messageReference: plain(messageReferenceRaw) || null,
      thread: plain(threadRaw) || null,
      flags: flagsRaw ?? 0,
      type: typeRaw ?? 0,
      pinned: Boolean(pinnedRaw),
      tts: Boolean(ttsRaw),
      channelScope: resolvedChannelMeta.scope || (guildId ? "server" : "private"),
      channelMeta: resolvedChannelMeta
    };

    if (partial) {
      if (contentRaw === undefined) delete record.content;
      if (timestampRaw === undefined) delete record.timestamp;
      if (editedRaw === undefined) delete record.editedTimestamp;
      if (authorRaw === undefined) delete record.author;
      if (attachmentsRaw === undefined) delete record.attachments;
      if (embedsRaw === undefined) delete record.embeds;
      if (stickersRaw === undefined) delete record.stickers;
      if (componentsRaw === undefined) delete record.components;
      if (pollRaw === undefined) delete record.poll;
      if (mentionsRaw === undefined) delete record.mentions;
      if (mentionRolesRaw === undefined) delete record.mentionRoles;
      if (reactionsRaw === undefined) delete record.reactions;
      if (referencedRaw === undefined) delete record.referencedMessage;
      if (messageReferenceRaw === undefined) delete record.messageReference;
      if (threadRaw === undefined) delete record.thread;
      if (flagsRaw === undefined) delete record.flags;
      if (typeRaw === undefined) delete record.type;
      if (pinnedRaw === undefined) delete record.pinned;
      if (ttsRaw === undefined) delete record.tts;
    }

    return record;
  }

  function normalizeDeletePayload(payload) {
    const nested = safeGet(payload, "message");
    const id = safeGet(payload, "id") || safeGet(nested, "id");
    const channelId = safeGet(payload, "channelId") || safeGet(payload, "channel_id") || safeGet(nested, "channel_id") || safeGet(nested, "channelId");
    const guildId = safeGet(payload, "guildId") || safeGet(payload, "guild_id") || safeGet(nested, "guild_id") || safeGet(nested, "guildId") || null;
    return { id: id ? String(id) : null, channelId: channelId ? String(channelId) : null, guildId: guildId ? String(guildId) : null };
  }

  function emitMessage(eventType, message, hints = {}) {
    const record = normalizeMessage(message, hints.channelId, hints.guildId, eventType === "MESSAGE_UPDATE");
    if (record) post("DISCORD_EVENT", { eventType, record });
  }

  function getArrayFromMessageCollection(collection) {
    if (!collection) return [];
    if (Array.isArray(collection)) return collection;
    try { if (typeof collection.toArray === "function") return collection.toArray(); } catch {}
    try { if (typeof collection.values === "function") return [...collection.values()]; } catch {}
    try {
      if (collection._map && typeof collection._map.values === "function") return [...collection._map.values()];
    } catch {}
    return [];
  }

  function eventFingerprint(eventType, payload) {
    const nested = safeGet(payload, "message") || payload || {};
    const channelId = safeGet(payload, "channelId") || safeGet(payload, "channel_id") || safeGet(nested, "channelId") || safeGet(nested, "channel_id") || "";
    const id = safeGet(payload, "id") || safeGet(nested, "id") || "";
    const ids = safeGet(payload, "ids");
    const edited = safeGet(nested, "edited_timestamp") || safeGet(nested, "editedTimestamp") || "";
    const content = safeGet(nested, "content");
    const contentSig = typeof content === "string" ? `${content.length}:${content.slice(0, 32)}` : "";
    return `${eventType}|${channelId}|${id}|${Array.isArray(ids) ? ids.join(",") : ""}|${edited}|${contentSig}`;
  }

  function rememberEvent(fingerprint, ttl = 750) {
    const now = Date.now();
    for (const [key, time] of recentEvents) {
      if (now - time > 5000) recentEvents.delete(key);
    }
    const previous = recentEvents.get(fingerprint);
    if (previous && now - previous < ttl) return false;
    recentEvents.set(fingerprint, now);
    return true;
  }

  function postHookEvent(eventType, payload, body) {
    const fingerprint = eventFingerprint(eventType, payload);
    if (!rememberEvent(fingerprint)) return;
    lastHookEventAt = Date.now();
    post("DISCORD_EVENT", body);
  }

  function activeRouteChannelId() {
    try {
      const match = location.pathname.match(/^\/channels\/(?:@me|\d+)\/(\d+)/);
      return match?.[1] || null;
    } catch { return null; }
  }

  function createLiveDeleteAnchor(channelId, messageId) {
    if (!liveRestoreEnabled || !channelId || !messageId) return null;
    // Anchors are only meaningful for the conversation actually visible in this
    // tab. Background server/DM delete events should still be saved, but must not
    // touch the active Discord DOM.
    if (String(activeRouteChannelId() || "") !== String(channelId)) return null;

    const key = `${channelId}:${messageId}`;
    const existing = document.querySelector(`[data-dmh-live-delete-anchor="${key}"]`);
    if (existing) {
      return { key, height: Number(existing.getAttribute("data-dmh-anchor-height") || 0) || null };
    }

    const target = document.getElementById(`chat-messages-${channelId}-${messageId}`);
    if (!(target instanceof HTMLElement) || !target.parentNode) return null;

    try {
      const rect = target.getBoundingClientRect();
      const computed = getComputedStyle(target);
      const height = Math.max(1, Math.ceil(rect.height));
      const anchor = document.createElement(target.tagName === "LI" ? "li" : "div");
      anchor.setAttribute("data-dmh-live-delete-anchor", key);
      anchor.setAttribute("data-dmh-anchor-height", String(height));

      // Remember the native message rows immediately around this one. The content
      // script uses these as a stable locality hint so a live-restored row can stay
      // at the edge of the viewport without later "travelling" with Discord's
      // virtualized list.
      const siblingMessageId = node => {
        if (!(node instanceof Element)) return null;
        const match = String(node.id || "").match(new RegExp(`^chat-messages-${channelId}-(\\d+)`));
        return match?.[1] || null;
      };
      let prev = target.previousElementSibling;
      let next = target.nextElementSibling;
      let prevId = null;
      let nextId = null;
      for (let i = 0; prev && i < 8 && !prevId; i++, prev = prev.previousElementSibling) prevId = siblingMessageId(prev);
      for (let i = 0; next && i < 8 && !nextId; i++, next = next.nextElementSibling) nextId = siblingMessageId(next);
      if (prevId) anchor.setAttribute("data-dmh-anchor-prev", prevId);
      if (nextId) anchor.setAttribute("data-dmh-anchor-next", nextId);

      anchor.setAttribute("aria-hidden", "true");
      anchor.style.cssText = [
        "display:block!important",
        `height:${height}px!important`,
        `min-height:${height}px!important`,
        "width:100%!important",
        "padding:0!important",
        "border:0!important",
        `margin:${computed.marginTop} ${computed.marginRight} ${computed.marginBottom} ${computed.marginLeft}!important`,
        "box-sizing:border-box!important",
        "visibility:hidden!important",
        "pointer-events:none!important",
        "overflow:hidden!important",
        "list-style:none!important",
        "flex:none!important"
      ].join(";");

      target.parentNode.insertBefore(anchor, target);
      setTimeout(() => {
        if (anchor.isConnected) anchor.remove();
      }, 5000);
      return { key, height };
    } catch {
      return null;
    }
  }

  function clearLiveDeleteAnchors() {
    document.querySelectorAll("[data-dmh-live-delete-anchor]").forEach(node => node.remove());
  }

  function handleCreate(payload) {
    const message = safeGet(payload, "message") || payload;
    const record = normalizeMessage(message, safeGet(payload, "channelId") || safeGet(payload, "channel_id"), safeGet(payload, "guildId") || safeGet(payload, "guild_id"), false);
    if (record) postHookEvent("MESSAGE_CREATE", payload, { eventType: "MESSAGE_CREATE", record });
  }

  function handleUpdate(payload, previousRecord = null) {
    const message = safeGet(payload, "message") || payload;
    const record = normalizeMessage(message, safeGet(payload, "channelId") || safeGet(payload, "channel_id"), safeGet(payload, "guildId") || safeGet(payload, "guild_id"), true);
    if (record) postHookEvent("MESSAGE_UPDATE", payload, { eventType: "MESSAGE_UPDATE", record, previousRecord });
  }

  function handleDelete(payload, previousRecord = null, liveAnchor = null) {
    const data = normalizeDeletePayload(payload);
    if (!data.id || !data.channelId) return;
    postHookEvent("MESSAGE_DELETE", payload, {
      eventType: "MESSAGE_DELETE",
      channelId: data.channelId,
      id: data.id,
      guildId: data.guildId,
      previousRecord,
      liveAnchor,
      channelMeta: getChannelMeta(data.channelId, data.guildId)
    });
  }

  function handleBulkDelete(payload, previousRecords = [], liveAnchors = []) {
    const channelId = safeGet(payload, "channelId") || safeGet(payload, "channel_id");
    const guildId = safeGet(payload, "guildId") || safeGet(payload, "guild_id") || null;
    const idsRaw = safeGet(payload, "ids");
    const ids = Array.isArray(idsRaw) ? idsRaw : (idsRaw && typeof idsRaw[Symbol.iterator] === "function" ? [...idsRaw] : []);
    if (!channelId || !ids.length) return;
    postHookEvent("MESSAGE_DELETE_BULK", payload, {
      eventType: "MESSAGE_DELETE_BULK",
      channelId: String(channelId),
      ids: ids.map(String),
      guildId: guildId ? String(guildId) : null,
      previousRecords,
      liveAnchors,
      channelMeta: getChannelMeta(String(channelId), guildId ? String(guildId) : null)
    });
  }

  function handleLoadedMessages(payload, eventType) {
    const channelId = safeGet(payload, "channelId") || safeGet(payload, "channel_id");
    const guildId = safeGet(payload, "guildId") || safeGet(payload, "guild_id");
    const possible = [
      safeGet(payload, "messages"),
      safeGet(payload, "messageRecords"),
      safeGet(payload, "result")?.messages
    ];
    for (const collection of possible) {
      const messages = getArrayFromMessageCollection(collection);
      if (!messages.length) continue;
      for (const message of messages) emitMessage(eventType, message, { channelId, guildId });
      break;
    }
  }

  function snapshotBeforeDelete(payload) {
    const data = normalizeDeletePayload(payload);
    if (!data.id || !data.channelId || !messageStore) return null;
    try {
      const oldMessage = messageStore.getMessage?.(data.channelId, data.id);
      return oldMessage ? normalizeMessage(oldMessage, data.channelId, data.guildId, false) : null;
    } catch { return null; }
  }

  function snapshotBeforeBulkDelete(payload) {
    const channelId = safeGet(payload, "channelId") || safeGet(payload, "channel_id");
    const guildId = safeGet(payload, "guildId") || safeGet(payload, "guild_id") || null;
    const idsRaw = safeGet(payload, "ids");
    const ids = Array.isArray(idsRaw) ? idsRaw : (idsRaw && typeof idsRaw[Symbol.iterator] === "function" ? [...idsRaw] : []);
    if (!channelId || !messageStore) return [];
    const records = [];
    for (const id of ids) {
      try {
        const oldMessage = messageStore.getMessage?.(String(channelId), String(id));
        const record = oldMessage ? normalizeMessage(oldMessage, String(channelId), guildId ? String(guildId) : null, false) : null;
        if (record) records.push(record);
      } catch {}
    }
    return records;
  }

  function snapshotBeforeUpdate(payload) {
    const nested = safeGet(payload, "message") || payload;
    const id = safeGet(nested, "id") || safeGet(payload, "id");
    const channelId = safeGet(nested, "channel_id") || safeGet(nested, "channelId") || safeGet(payload, "channel_id") || safeGet(payload, "channelId");
    if (!id || !channelId || !messageStore) return null;
    try {
      const oldMessage = messageStore.getMessage?.(String(channelId), String(id));
      return oldMessage ? normalizeMessage(oldMessage, String(channelId), null, false) : null;
    } catch { return null; }
  }

  function observeFluxAction(payload, phase = "pre") {
    if (!payload || typeof payload !== "object") return;
    const type = safeGet(payload, "type");
    if (!type || typeof type !== "string") return;

    if (phase === "pre") {
      if (type === "MESSAGE_DELETE") {
        const data = normalizeDeletePayload(payload);
        const liveAnchor = data.id && data.channelId ? createLiveDeleteAnchor(data.channelId, data.id) : null;
        handleDelete(payload, snapshotBeforeDelete(payload), liveAnchor);
        return;
      }
      if (type === "MESSAGE_DELETE_BULK") {
        const channelId = safeGet(payload, "channelId") || safeGet(payload, "channel_id");
        const idsRaw = safeGet(payload, "ids");
        const ids = Array.isArray(idsRaw) ? idsRaw : (idsRaw && typeof idsRaw[Symbol.iterator] === "function" ? [...idsRaw] : []);
        const liveAnchors = channelId ? ids.map(id => createLiveDeleteAnchor(String(channelId), String(id))).filter(Boolean) : [];
        handleBulkDelete(payload, snapshotBeforeBulkDelete(payload), liveAnchors);
        return;
      }
      if (type === "MESSAGE_UPDATE") {
        handleUpdate(payload, snapshotBeforeUpdate(payload));
        return;
      }
      if (type === "MESSAGE_CREATE") {
        handleCreate(payload);
        return;
      }
      if (LOAD_EVENTS.includes(type)) handleLoadedMessages(payload, type);
    }
  }

  function patchDispatchMethod(methodName) {
    if (!dispatcher || typeof safeGet(dispatcher, methodName) !== "function") return false;
    const original = dispatcher[methodName];
    if (original?.__dmhWrapped) return true;

    function wrappedDispatch(...args) {
      try { observeFluxAction(args[0], "pre"); } catch {}
      return original.apply(this, args);
    }
    try { Object.defineProperty(wrappedDispatch, "__dmhWrapped", { value: true }); } catch {}

    try {
      dispatcher[methodName] = wrappedDispatch;
      return dispatcher[methodName] === wrappedDispatch || Boolean(dispatcher[methodName]?.__dmhWrapped);
    } catch {
      try {
        Object.defineProperty(dispatcher, methodName, { configurable: true, writable: true, value: wrappedDispatch });
        return true;
      } catch {}
    }
    return false;
  }

  function installDispatchPatch() {
    if (dispatchPatched || !dispatcher) return dispatchPatched;
    const dispatchOk = patchDispatchMethod("dispatch");
    const dirtyOk = typeof safeGet(dispatcher, "dirtyDispatch") === "function" ? patchDispatchMethod("dirtyDispatch") : false;
    dispatchPatched = dispatchOk || dirtyOk;
    if (dispatchPatched) hookMethod = dispatcherFromStore(messageStore) === dispatcher ? "MessageStore._dispatcher dispatch patch" : "Flux dispatch patch";
    return dispatchPatched;
  }

  function subscribe() {
    if (subscribed || !dispatcher) return false;
    try {
      dispatcher.subscribe("MESSAGE_CREATE", handleCreate);
      dispatcher.subscribe("MESSAGE_UPDATE", handleUpdate);
      dispatcher.subscribe("MESSAGE_DELETE", handleDelete);
      dispatcher.subscribe("MESSAGE_DELETE_BULK", handleBulkDelete);
      for (const eventType of LOAD_EVENTS) {
        dispatcher.subscribe(eventType, payload => handleLoadedMessages(payload, eventType));
      }
      subscribed = true;
      if (hookMethod === "none") hookMethod = "Flux subscriptions";
      post("HOOK_STATUS", {
        connected: true,
        dispatchPatched,
        subscribed: true,
        hookMethod,
        webpackFound: Boolean(webpackRequire),
        webpackCaptureMethod,
        runtimeSnifferInstalled,
        lastHookEventAt,
        messageStoreFound: Boolean(messageStore),
        channelStoreFound: Boolean(channelStore)
      });
      return true;
    } catch (error) {
      post("HOOK_STATUS", { connected: dispatchPatched, dispatchPatched, subscribed: false, hookMethod, webpackFound: Boolean(webpackRequire), webpackCaptureMethod, runtimeSnifferInstalled, error: String(error?.message || error) });
      return false;
    }
  }

  function postProgressStatus(force = false) {
    const now = Date.now();
    if (!force && now - lastProgressStatusAt < 1500) return;
    lastProgressStatusAt = now;
    post("HOOK_STATUS", {
      connected: dispatchPatched || subscribed,
      dispatchPatched,
      subscribed,
      hookMethod,
      webpackFound: Boolean(webpackRequire),
      webpackCaptureMethod,
      runtimeSnifferInstalled,
      lastHookEventAt,
      messageStoreFound: Boolean(messageStore),
      channelStoreFound: Boolean(channelStore)
    });
  }

  function bootstrap() {
    if (!discoverStores()) {
      postProgressStatus();
      return false;
    }
    installDispatchPatch();
    subscribe();
    return dispatchPatched || subscribed;
  }

  window.addEventListener("message", event => {
    if (event.source !== window || event.data?.source !== IN_SOURCE) return;
    const data = event.data;

    if (data.type === "SET_LIVE_RESTORE_ENABLED") {
      liveRestoreEnabled = Boolean(data.enabled);
      if (!liveRestoreEnabled) clearLiveDeleteAnchors();
      return;
    }

    if (data.type === "REQUEST_MESSAGE") {
      bootstrap();
      try {
        const message = messageStore?.getMessage?.(data.channelId, data.id);
        if (message) emitMessage("MESSAGE_SNAPSHOT", message, { channelId: data.channelId, guildId: data.guildId || null });
      } catch {}
      return;
    }

    if (data.type === "REQUEST_CHANNEL_MESSAGES") {
      bootstrap();
      try {
        const collection = messageStore?.getMessages?.(data.channelId);
        for (const message of getArrayFromMessageCollection(collection)) {
          emitMessage("MESSAGE_SNAPSHOT", message, { channelId: data.channelId, guildId: data.guildId || null });
        }
      } catch {}
      return;
    }

    if (data.type === "PING_HOOK") {
      bootstrap();
      post("HOOK_STATUS", {
        connected: dispatchPatched || subscribed,
        dispatchPatched,
        subscribed,
        hookMethod,
        webpackFound: Boolean(webpackRequire),
        webpackCaptureMethod,
        runtimeSnifferInstalled,
        lastHookEventAt,
        messageStoreFound: Boolean(messageStore),
        channelStoreFound: Boolean(channelStore)
      });
    }
  });

  installWebpackRuntimeSniffer();
  bootstrap();
  const retryTimer = setInterval(() => {
    bootstrap();
    if (!(dispatchPatched || subscribed)) postProgressStatus();
    if ((dispatchPatched || subscribed) && messageStore && channelStore) clearInterval(retryTimer);
  }, 500);
})();
