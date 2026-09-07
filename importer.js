(() => {
  "use strict";

  const textDecoder = new TextDecoder("utf-8");

  function unique(values) {
    const out = [];
    const seen = new Set();
    for (const value of values || []) {
      const item = String(value || "").trim();
      if (!item) continue;
      const key = item.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return out;
  }

  function textWithBreaks(element) {
    if (!element) return "";
    const clone = element.cloneNode(true);
    clone.querySelectorAll("br").forEach(node => node.replaceWith("\n"));
    clone.querySelectorAll(".empty-message").forEach(node => node.remove());
    return String(clone.textContent || "").replace(/\u00a0/g, " ").trim();
  }

  function parseHeaders(block) {
    const headers = {};
    let current = null;
    for (const rawLine of String(block || "").replace(/\r\n/g, "\n").split("\n")) {
      if (/^[ \t]/.test(rawLine) && current) {
        headers[current] += ` ${rawLine.trim()}`;
        continue;
      }
      const index = rawLine.indexOf(":");
      if (index < 1) continue;
      current = rawLine.slice(0, index).trim().toLowerCase();
      headers[current] = rawLine.slice(index + 1).trim();
    }
    return headers;
  }

  function splitHeaderBody(value) {
    const crlf = value.indexOf("\r\n\r\n");
    if (crlf >= 0) return [value.slice(0, crlf), value.slice(crlf + 4)];
    const lf = value.indexOf("\n\n");
    if (lf >= 0) return [value.slice(0, lf), value.slice(lf + 2)];
    return [value, ""];
  }

  function contentTypeBase(value) {
    return String(value || "application/octet-stream").split(";", 1)[0].trim().toLowerCase() || "application/octet-stream";
  }

  function contentTypeCharset(value) {
    const match = String(value || "").match(/charset\s*=\s*"?([^";\s]+)/i);
    return match?.[1] || "utf-8";
  }

  function base64Bytes(value) {
    const clean = String(value || "").replace(/\s+/g, "");
    if (!clean) return new Uint8Array();
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function quotedPrintableBytes(value) {
    const source = String(value || "").replace(/=\r?\n/g, "");
    const bytes = [];
    for (let i = 0; i < source.length; i += 1) {
      if (source[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(source.slice(i + 1, i + 3))) {
        bytes.push(parseInt(source.slice(i + 1, i + 3), 16));
        i += 2;
      } else {
        const encoded = new TextEncoder().encode(source[i]);
        bytes.push(...encoded);
      }
    }
    return new Uint8Array(bytes);
  }

  function partBytes(part) {
    if (part._bytes) return part._bytes;
    const encoding = String(part.headers["content-transfer-encoding"] || "8bit").toLowerCase();
    if (encoding === "base64") part._bytes = base64Bytes(part.body);
    else if (encoding === "quoted-printable") part._bytes = quotedPrintableBytes(part.body);
    else part._bytes = new TextEncoder().encode(part.body.replace(/\r\n/g, "\n"));
    return part._bytes;
  }

  function partText(part) {
    const encoding = String(part.headers["content-transfer-encoding"] || "8bit").toLowerCase();
    if (encoding === "8bit" || encoding === "7bit" || encoding === "binary") return part.body;
    const bytes = partBytes(part);
    try {
      return new TextDecoder(contentTypeCharset(part.headers["content-type"])).decode(bytes);
    } catch {
      return textDecoder.decode(bytes);
    }
  }

  function partBlob(part) {
    if (part._blob) return part._blob;
    part._blob = new Blob([partBytes(part)], { type: contentTypeBase(part.headers["content-type"]) });
    return part._blob;
  }

  function parseMhtml(raw) {
    const [headerBlock] = splitHeaderBody(raw);
    const headers = parseHeaders(headerBlock);
    const contentType = headers["content-type"] || "";
    const boundaryMatch = contentType.match(/boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i);
    if (!boundaryMatch) throw new Error("This MHTML file does not contain a MIME boundary.");
    const boundary = boundaryMatch[1] || boundaryMatch[2];
    const marker = `--${boundary}`;
    const rawParts = raw.split(marker);
    const parts = [];
    for (let rawPart of rawParts.slice(1)) {
      rawPart = rawPart.replace(/^\r?\n/, "");
      if (rawPart.startsWith("--")) break;
      rawPart = rawPart.replace(/\r?\n$/, "");
      const [partHeaderBlock, body] = splitHeaderBody(rawPart);
      const partHeaders = parseHeaders(partHeaderBlock);
      if (!Object.keys(partHeaders).length) continue;
      parts.push({ headers: partHeaders, body });
    }
    const htmlPart = parts.find(part => contentTypeBase(part.headers["content-type"]) === "text/html");
    if (!htmlPart) throw new Error("The MHTML archive does not contain an HTML transcript.");
    const resources = new Map();
    for (const part of parts) {
      const location = String(part.headers["content-location"] || "").trim();
      if (!location) continue;
      resources.set(location, part);
      try { resources.set(decodeURI(location), part); } catch {}
    }
    return { html: partText(htmlPart), resources, parts };
  }

  function dataUrlToBlob(url) {
    const match = String(url || "").match(/^data:([^;,]*)(;base64)?,(.*)$/s);
    if (!match) return null;
    const type = match[1] || "application/octet-stream";
    if (match[2]) return new Blob([base64Bytes(match[3])], { type });
    try {
      return new Blob([decodeURIComponent(match[3])], { type });
    } catch {
      return new Blob([match[3]], { type });
    }
  }

  function guessContentType(filename = "") {
    const ext = String(filename).split(".").pop()?.toLowerCase();
    const map = {
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", svg: "image/svg+xml",
      mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", m4v: "video/x-m4v",
      mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", opus: "audio/ogg", m4a: "audio/mp4", flac: "audio/flac",
      pdf: "application/pdf", txt: "text/plain", json: "application/json", zip: "application/zip"
    };
    return map[ext] || "application/octet-stream";
  }

  function filenameFromUrl(url, fallback = "attachment") {
    try {
      const path = new URL(url).pathname;
      return decodeURIComponent(path.split("/").pop() || fallback);
    } catch {
      return fallback;
    }
  }

  function attachmentIdFromUrl(url) {
    const match = String(url || "").match(/\/attachments\/\d+\/(\d+)\//);
    return match?.[1] || null;
  }

  function mediaKey(channelId, messageId, attachmentId, index) {
    return `${channelId}:${messageId}:${attachmentId || index}`;
  }

  function snowflakeIso(id) {
    try {
      const ms = Number((BigInt(String(id)) >> 22n) + 1420070400000n);
      return new Date(ms).toISOString();
    } catch {
      return null;
    }
  }

  function parseDiscordSource(source) {
    const match = String(source || "").match(/\/channels\/(@me|\d+)\/(\d+)/);
    if (!match) return { channelId: null, guildId: null, privateSource: false };
    return { channelId: match[2], guildId: match[1] === "@me" ? null : match[1], privateSource: match[1] === "@me" };
  }

  function resourceFor(resources, url) {
    if (!url) return null;
    if (resources.has(url)) return resources.get(url);
    try {
      const decoded = decodeURI(url);
      if (resources.has(decoded)) return resources.get(decoded);
    } catch {}
    return null;
  }

  function attachmentBlob(resources, primaryUrl, fallbackUrl) {
    for (const url of [primaryUrl, fallbackUrl]) {
      if (!url) continue;
      if (String(url).startsWith("data:")) {
        const blob = dataUrlToBlob(url);
        if (blob) return blob;
      }
      const part = resourceFor(resources, url);
      if (part) return partBlob(part);
    }
    return null;
  }

  function makeMediaItem(record, attachment, index, blob) {
    if (!blob) return null;
    const key = attachment._dmhMediaKey || mediaKey(record.channelId, record.id, attachment.id, index);
    return {
      key,
      channelId: record.channelId,
      messageKey: `${record.channelId}:${record.id}`,
      messageId: record.id,
      attachmentId: attachment.id || null,
      filename: attachment.filename || "attachment",
      contentType: attachment.contentType || blob.type || "application/octet-stream",
      size: blob.size,
      sourceUrl: attachment.url || null,
      cachedAt: Date.now(),
      blob
    };
  }

  function parseLocalAttachments(element, record, resources) {
    const candidates = [];
    const seen = new Set();
    const push = (url, filename, sourceUrl = null) => {
      url = String(url || "").trim();
      if (!url) return;
      const canonical = sourceUrl || url;
      const key = canonical || url;
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push({ url, sourceUrl: canonical, filename: filename || filenameFromUrl(canonical) });
    };

    element.querySelectorAll(".section").forEach(section => {
      const heading = section.querySelector("b")?.textContent?.trim().toLowerCase();
      if (heading !== "attachments") return;
      section.querySelectorAll("a[href]").forEach(anchor => push(anchor.getAttribute("href"), anchor.textContent?.trim()));
    });

    element.querySelectorAll(".gallery:not(.stickers) figure").forEach(figure => {
      const anchor = figure.querySelector("a[href]");
      const media = figure.querySelector("img[src],video[src],audio[src]");
      const external = anchor?.getAttribute("href") || "";
      const src = media?.getAttribute("src") || "";
      push(external || src, figure.querySelector("figcaption")?.textContent?.trim() || filenameFromUrl(external || src), external || src);
    });
    element.querySelectorAll("video[src],audio[src]").forEach(media => {
      if (media.closest(".gallery.stickers")) return;
      const parentLink = media.closest("a[href]")?.getAttribute("href") || "";
      push(parentLink || media.getAttribute("src"), filenameFromUrl(parentLink || media.getAttribute("src")), parentLink || media.getAttribute("src"));
    });
    element.querySelectorAll("a.media-link[href]").forEach(anchor => push(anchor.getAttribute("href"), anchor.textContent?.trim()));

    const attachments = [];
    const media = [];
    candidates.forEach((candidate, index) => {
      const displayUrl = candidate.sourceUrl || candidate.url;
      const part = resourceFor(resources, candidate.url) || resourceFor(resources, displayUrl);
      const blob = attachmentBlob(resources, candidate.url, displayUrl);
      const filename = (candidate.filename || filenameFromUrl(displayUrl)).split(" · ")[0].trim() || `attachment-${index + 1}`;
      const id = attachmentIdFromUrl(displayUrl);
      const contentType = part ? contentTypeBase(part.headers["content-type"]) : (blob?.type || guessContentType(filename));
      const attachment = {
        id,
        filename,
        url: String(displayUrl).startsWith("data:") ? null : displayUrl,
        proxyUrl: null,
        contentType,
        size: blob?.size || 0,
        _dmhMediaKey: mediaKey(record.channelId, record.id, id, index)
      };
      const audio = [...element.querySelectorAll("audio[src]")].find(node => node.getAttribute("src") === candidate.url);
      if (audio?.dataset?.duration) attachment.durationSecs = Number(audio.dataset.duration) || null;
      attachments.push(attachment);
      const item = makeMediaItem(record, attachment, index, blob);
      if (item) media.push(item);
    });
    return { attachments, media };
  }

  function parseLocalEditHistory(element, fallbackTime) {
    const history = [];
    element.querySelectorAll(".edit-history-entry").forEach(entry => {
      const timeNode = entry.querySelector("time");
      const editedAt = timeNode?.getAttribute("datetime") || timeNode?.textContent?.trim() || fallbackTime || null;
      history.push({
        content: textWithBreaks(entry.querySelector(".edit-history-content")),
        attachments: [],
        editedAt,
        capturedAt: editedAt ? Date.parse(editedAt) || Date.now() : Date.now()
      });
    });
    return history;
  }

  function parseLocalMessage(element, context) {
    const id = String(element.getAttribute("data-message-id") || "").trim();
    if (!id) return null;
    const isThreadMessage = element.getAttribute("data-thread-message") === "true";
    const threadId = String(element.getAttribute("data-thread-id") || "").trim();
    const channelId = isThreadMessage && threadId ? threadId : context.channelId;
    if (!channelId) return null;

    const group = element.closest(".message-group, .thread-message-group") || element.parentElement;
    const authorName = group?.querySelector(".group-header strong")?.textContent?.trim() || "Unknown";
    const avatar = group?.querySelector(".avatar-column img.avatar, img.avatar")?.getAttribute("src") || "";
    const timeNode = element.querySelector(":scope > .message-meta time, .message-meta time");
    const timestamp = timeNode?.getAttribute("datetime") || snowflakeIso(id);
    const deleted = element.getAttribute("data-deleted") === "true" || element.getAttribute("data-deleted-between-exports") === "true" || element.classList.contains("deleted-message") || element.classList.contains("between-export-deleted");
    const editHistory = parseLocalEditHistory(element, context.exportedAt);
    const parentId = String(element.getAttribute("data-thread-parent-message-id") || "").trim();
    const threadName = String(element.getAttribute("data-thread-name") || "").trim();

    const record = {
      key: `${channelId}:${id}`,
      channelId,
      guildId: context.guildId,
      channelScope: isThreadMessage ? "server" : context.scope,
      id,
      content: textWithBreaks(element.querySelector(":scope > .content, .content")),
      author: { username: authorName, ...(avatar ? { avatarUrl: avatar } : {}) },
      timestamp,
      editHistory,
      deleted,
      deletedAt: deleted ? context.exportedAt : null,
      firstSeenAt: timestamp ? Date.parse(timestamp) || Date.now() : Date.now(),
      lastSeenAt: context.exportedAt ? Date.parse(context.exportedAt) || Date.now() : Date.now(),
      importedOnly: true,
      importSource: "local-discord-exporter",
      importExportedAt: context.exportedAt || new Date().toISOString(),
      channelMeta: isThreadMessage ? {
        channelId,
        guildId: context.guildId,
        channelName: threadName || `Thread ${channelId}`,
        parentId: context.channelId,
        isThread: true,
        channelType: 11,
        scope: "server"
      } : null
    };

    if (!isThreadMessage && threadId) record.thread = { id: threadId, name: threadName || "Thread", parentMessageId: id };

    const reply = element.querySelector(".reply");
    if (reply) record.referencedMessage = { content: textWithBreaks(reply) };

    const stickers = [...element.querySelectorAll(".gallery.stickers img")].map(img => ({
      name: img.getAttribute("alt") || "sticker",
      url: img.getAttribute("src") || null
    }));
    if (stickers.length) record.stickers = stickers;

    const { attachments, media } = parseLocalAttachments(element, record, context.resources);
    record.attachments = attachments;
    return { record, media };
  }

  async function parseLocalDiscordExporterFile(file) {
    const raw = await file.text();
    if (!/^From:\s*<Saved by Local Discord History Exporter>/im.test(raw) && !raw.includes('id="dhe-export-meta"')) {
      throw new Error("This does not look like a Local Discord History Exporter MHTML file.");
    }
    const archive = parseMhtml(raw);
    const doc = new DOMParser().parseFromString(archive.html, "text/html");
    const metaNode = doc.querySelector("#dhe-export-meta");
    let meta = {};
    try { meta = JSON.parse(metaNode?.textContent || "{}"); } catch {}
    const source = meta.source || doc.querySelector('a[href*="discord.com/channels/"]')?.getAttribute("href") || "";
    const sourceInfo = parseDiscordSource(source);
    if (!sourceInfo.channelId) throw new Error("Could not determine the Discord channel ID from this export.");
    const exportedAt = meta.exportedAt || (file.lastModified ? new Date(file.lastModified).toISOString() : new Date().toISOString());

    const authorNames = unique([...doc.querySelectorAll(".group-header strong")].map(node => node.textContent).filter(name => name && name.trim().toLowerCase() !== "unknown"));
    let scope = sourceInfo.privateSource ? (authorNames.length > 2 ? "group_dm" : "dm") : "server";
    const channelType = scope === "dm" ? 1 : scope === "group_dm" ? 3 : 0;
    const title = doc.querySelector("#dhe-transcript > h1, main h1, body > h1, h1")?.textContent?.trim() || `Channel ${sourceInfo.channelId}`;
    const mainMeta = {
      channelId: sourceInfo.channelId,
      guildId: sourceInfo.guildId,
      channelName: scope === "dm" || scope === "group_dm" ? (authorNames.join(", ") || title) : title,
      guildName: null,
      recipientNames: scope === "dm" || scope === "group_dm" ? authorNames : [],
      recipientIds: [],
      channelType,
      parentId: null,
      isThread: false,
      scope,
      lastSeenAt: exportedAt ? Date.parse(exportedAt) || Date.now() : Date.now(),
      importSource: "local-discord-exporter"
    };

    const context = { ...sourceInfo, channelId: sourceInfo.channelId, scope, exportedAt, resources: archive.resources };
    const messages = [];
    const media = [];
    const threadMeta = new Map();
    for (const element of doc.querySelectorAll(".message[data-message-id]")) {
      const parsed = parseLocalMessage(element, context);
      if (!parsed) continue;
      if (parsed.record.channelId === sourceInfo.channelId) messages.push(parsed.record);
      else {
        if (!threadMeta.has(parsed.record.channelId)) threadMeta.set(parsed.record.channelId, parsed.record.channelMeta);
        messages.push(parsed.record);
      }
      media.push(...parsed.media);
    }

    const channels = [mainMeta, ...threadMeta.values()].filter(Boolean);
    return {
      kind: "local-discord-exporter",
      fileName: file.name,
      source,
      exportedAt,
      channels,
      messages,
      media,
      warnings: []
    };
  }

  function parseMessageMemoryAttachment(wrapper, record, index) {
    let src = "";
    let filename = "";
    let contentType = "";
    let durationSecs = null;
    if (wrapper.classList.contains("image-attachment")) {
      src = wrapper.querySelector("img[src]")?.getAttribute("src") || wrapper.querySelector("a[href]")?.getAttribute("href") || "";
      filename = (wrapper.querySelector("figcaption")?.textContent || "image").split(" · ")[0].trim();
      contentType = guessContentType(filename);
    } else if (wrapper.classList.contains("media-attachment")) {
      const video = wrapper.querySelector("video[src]");
      src = video?.getAttribute("src") || "";
      filename = (wrapper.querySelector("div")?.textContent || "video").split(" · ")[0].trim();
      contentType = guessContentType(filename) || "video/mp4";
    } else if (wrapper.classList.contains("audio-attachment")) {
      const audio = wrapper.querySelector("audio[src]");
      src = audio?.getAttribute("src") || "";
      filename = (wrapper.querySelector(".file-name")?.textContent || "audio").split(" · ")[0].trim();
      contentType = guessContentType(filename) || "audio/mpeg";
      const saved = wrapper.getAttribute("data-saved-duration");
      if (saved != null && Number.isFinite(Number(saved))) durationSecs = Number(saved);
    } else if (wrapper.classList.contains("file-attachment")) {
      src = wrapper.getAttribute("href") || "";
      filename = wrapper.querySelector("strong")?.textContent?.trim() || filenameFromUrl(src);
      contentType = guessContentType(filename);
    }
    if (!src) return null;
    const blob = src.startsWith("data:") ? dataUrlToBlob(src) : null;
    const id = attachmentIdFromUrl(src);
    const key = wrapper.getAttribute("data-dmh-media-key") || mediaKey(record.channelId, record.id, id, index);
    const attachment = {
      id,
      filename: filename || `attachment-${index + 1}`,
      url: src.startsWith("data:") ? null : src,
      proxyUrl: null,
      contentType: blob?.type || contentType || "application/octet-stream",
      size: blob?.size || 0,
      ...(durationSecs !== null ? { durationSecs } : {}),
      _dmhMediaKey: key
    };
    return { attachment, media: makeMediaItem(record, attachment, index, blob) };
  }

  function parseMessageMemoryDomRecord(element, channelId, channelMeta, exportedAt) {
    const id = String(element.getAttribute("data-message-id") || element.id?.replace(/^message-/, "") || "").trim();
    if (!id) return null;
    const record = {
      key: `${channelId}:${id}`,
      channelId,
      guildId: channelMeta.guildId || null,
      channelScope: channelMeta.scope || (channelMeta.guildId ? "server" : "private"),
      id,
      content: textWithBreaks(element.querySelector(".message-content")),
      timestamp: element.querySelector(".message-header time")?.getAttribute("datetime") || snowflakeIso(id),
      deleted: element.classList.contains("deleted") || element.getAttribute("data-deleted") === "true",
      deletedAt: null,
      editHistory: [],
      attachments: [],
      firstSeenAt: Date.parse(snowflakeIso(id) || "") || Date.now(),
      lastSeenAt: Date.parse(exportedAt || "") || Date.now(),
      importedOnly: true,
      importSource: "discord-message-memory-export",
      importExportedAt: exportedAt || new Date().toISOString()
    };
    if (record.deleted) record.deletedAt = exportedAt || new Date().toISOString();
    if (element.classList.contains("call-event")) {
      record.type = 3;
      record.systemEventKind = "call";
      record.systemEventText = textWithBreaks(element.querySelector(".call-event-content span:last-child")) || textWithBreaks(element.querySelector(".call-event-content"));
    }

    const authorName = element.querySelector(".message-header strong")?.textContent?.trim() || "Unknown user";
    const avatar = element.querySelector(".avatar img[src]")?.getAttribute("src") || "";
    record.author = { username: authorName, ...(avatar ? { avatarUrl: avatar } : {}) };

    element.querySelectorAll(".edit-version").forEach(version => {
      const editedAt = version.getAttribute("data-edited-at") || version.querySelector("time")?.getAttribute("datetime") || version.querySelector(".edit-version-time")?.textContent?.trim() || exportedAt;
      record.editHistory.push({
        content: textWithBreaks(version.querySelector(".edit-version-content")),
        attachments: [],
        editedAt,
        capturedAt: Date.parse(editedAt || "") || Date.now()
      });
    });

    const reply = element.querySelector(".reply");
    if (reply) {
      const clone = reply.cloneNode(true);
      const authorNode = clone.querySelector("span");
      const replyAuthor = authorNode?.textContent?.trim() || "Unknown user";
      authorNode?.remove();
      record.referencedMessage = { author: { username: replyAuthor }, content: textWithBreaks(clone) };
    }

    const media = [];
    element.querySelectorAll(".attachment").forEach((wrapper, index) => {
      const parsed = parseMessageMemoryAttachment(wrapper, record, index);
      if (!parsed) return;
      record.attachments.push(parsed.attachment);
      if (parsed.media) media.push(parsed.media);
    });

    const stickers = [...element.querySelectorAll(".stickers span")].map(node => ({ name: node.textContent.replace(/^Sticker:\s*/i, "").trim() || "sticker" }));
    if (stickers.length) record.stickers = stickers;

    const reactions = [...element.querySelectorAll(".reactions .reaction")].map(node => {
      const text = node.textContent.trim();
      const countMatch = text.match(/\s+(\d+)$/);
      return { emoji: { name: countMatch ? text.slice(0, countMatch.index).trim() : text }, count: countMatch ? Number(countMatch[1]) : 1 };
    });
    if (reactions.length) record.reactions = reactions;

    const threadButton = element.querySelector("[data-thread-open]");
    if (threadButton) record.thread = { id: threadButton.getAttribute("data-thread-open"), name: threadButton.childNodes[1]?.textContent?.trim() || "Thread" };
    return { record, media };
  }

  function sanitizePortableRecord(record, channelId, importedAt) {
    const cloned = JSON.parse(JSON.stringify(record || {}));
    cloned.channelId = String(cloned.channelId || channelId || "");
    cloned.id = String(cloned.id || "");
    cloned.key = `${cloned.channelId}:${cloned.id}`;
    cloned.importedOnly = true;
    cloned.importSource = "discord-message-memory-export";
    cloned.importExportedAt = importedAt || new Date().toISOString();
    cloned.firstSeenAt = cloned.firstSeenAt || Date.parse(cloned.timestamp || snowflakeIso(cloned.id) || "") || Date.now();
    cloned.lastSeenAt = Math.max(Number(cloned.lastSeenAt || 0), Date.parse(importedAt || "") || Date.now());
    cloned.editHistory = Array.isArray(cloned.editHistory) ? cloned.editHistory : [];
    cloned.attachments = Array.isArray(cloned.attachments) ? cloned.attachments : [];
    return cloned;
  }

  async function parseMessageMemoryExportFile(file) {
    const html = await file.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const marker = doc.querySelector("#dmh-export-data") || [...doc.querySelectorAll(".export-meta")].some(node => /Discord Message Memory/i.test(node.textContent));
    if (!marker) throw new Error("This does not look like a Discord Message Memory HTML export.");

    let portable = null;
    const portableNode = doc.querySelector("#dmh-export-data");
    if (portableNode) {
      try { portable = JSON.parse(portableNode.textContent || "null"); } catch (error) { throw new Error(`The Message Memory metadata block is damaged: ${error.message}`); }
    }

    const exportedText = doc.querySelector(".export-meta")?.textContent || "";
    const exportedAt = portable?.exportedAt || (file.lastModified ? new Date(file.lastModified).toISOString() : new Date().toISOString());
    const channelIdFromHeader = (doc.querySelector(".topbar p")?.textContent || "").match(/Channel ID\s+(\d+)/i)?.[1] || null;
    const mainChat = portable?.chat || null;
    const mainChannelId = String(mainChat?.channelId || channelIdFromHeader || "").trim();
    if (!mainChannelId) throw new Error("Could not determine the channel ID in this Message Memory export.");

    const title = doc.querySelector(".topbar h1")?.textContent?.trim() || mainChat?.channelName || `Channel ${mainChannelId}`;
    const kindText = (doc.querySelector(".topbar p")?.textContent || "").toLowerCase();
    const scope = mainChat?.scope || (kindText.includes("direct message") ? "dm" : kindText.includes("group dm") ? "group_dm" : kindText.includes("server") ? "server" : "private");
    const mainMeta = {
      channelId: mainChannelId,
      guildId: mainChat?.guildId || null,
      channelName: mainChat?.channelName || title,
      guildName: mainChat?.guildName || null,
      selfName: mainChat?.selfName || null,
      selfUserId: mainChat?.selfUserId || null,
      recipientNames: mainChat?.recipientNames || [],
      recipientIds: mainChat?.recipientIds || [],
      channelType: mainChat?.channelType ?? (scope === "dm" ? 1 : scope === "group_dm" ? 3 : 0),
      parentId: mainChat?.parentId || null,
      isThread: Boolean(mainChat?.isThread),
      scope,
      lastSeenAt: Date.parse(exportedAt || "") || Date.now(),
      importSource: "discord-message-memory-export"
    };

    const channels = [mainMeta];
    const messages = [];
    const media = [];

    if (portable?.messages && Array.isArray(portable.messages)) {
      for (const raw of portable.messages) messages.push(sanitizePortableRecord(raw, mainChannelId, exportedAt));
      for (const thread of portable.threads || []) {
        const meta = { ...(thread.meta || {}), channelId: String(thread.meta?.channelId || ""), parentId: thread.meta?.parentId || mainChannelId, isThread: true, importSource: "discord-message-memory-export" };
        if (meta.channelId) channels.push(meta);
        for (const raw of thread.messages || []) messages.push(sanitizePortableRecord(raw, meta.channelId, exportedAt));
      }

      // Pull the actual embedded avatar/media bytes from the human-readable DOM
      // without duplicating those large data URLs in the JSON metadata block.
      const recordByKey = new Map(messages.map(record => [`${record.channelId}:${record.id}`, record]));
      doc.querySelectorAll("article.message[id^='message-']").forEach(article => {
        const id = article.getAttribute("data-message-id") || article.id.replace(/^message-/, "");
        let channelId = article.getAttribute("data-channel-id") || mainChannelId;
        const panel = article.closest("[data-thread-panel]");
        if (panel) channelId = panel.getAttribute("data-thread-panel") || channelId;
        const record = recordByKey.get(`${channelId}:${id}`);
        if (!record) return;
        const avatar = article.querySelector(".avatar img[src^='data:']")?.getAttribute("src");
        if (avatar) record.author = { ...(record.author || {}), avatarUrl: avatar };
        article.querySelectorAll(".attachment[data-dmh-media-key]").forEach((wrapper, index) => {
          const parsed = parseMessageMemoryAttachment(wrapper, record, index);
          if (parsed?.media) media.push(parsed.media);
        });
      });
    } else {
      doc.querySelectorAll("main .messages > article.message").forEach(article => {
        const parsed = parseMessageMemoryDomRecord(article, mainChannelId, mainMeta, exportedAt);
        if (!parsed) return;
        messages.push(parsed.record);
        media.push(...parsed.media);
      });
      doc.querySelectorAll("[data-thread-panel]").forEach(panel => {
        const threadId = String(panel.getAttribute("data-thread-panel") || "").trim();
        if (!threadId) return;
        const threadName = panel.querySelector(".thread-panel-title strong")?.textContent?.trim() || `Thread ${threadId}`;
        const threadMeta = { channelId: threadId, guildId: mainMeta.guildId, channelName: threadName, parentId: mainChannelId, isThread: true, channelType: 11, scope: mainMeta.guildId ? "server" : "private", lastSeenAt: mainMeta.lastSeenAt, importSource: "discord-message-memory-export" };
        channels.push(threadMeta);
        panel.querySelectorAll("article.message").forEach(article => {
          const parsed = parseMessageMemoryDomRecord(article, threadId, threadMeta, exportedAt);
          if (!parsed) return;
          messages.push(parsed.record);
          media.push(...parsed.media);
        });
      });
    }

    return {
      kind: "discord-message-memory-export",
      fileName: file.name,
      exportedAt,
      channels,
      messages,
      media,
      warnings: portable ? [] : ["This is an older Message Memory HTML export, so some metadata that was not visible in the transcript may not be recoverable."]
    };
  }

  window.DMHImporter = {
    parseLocalDiscordExporterFile,
    parseMessageMemoryExportFile,
    dataUrlToBlob,
    snowflakeIso
  };
})();
