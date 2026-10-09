/* ZIP/ZIP64 exporter. Fully local: no external libraries or remote code.
 * ZIP64 removes the traditional 4 GiB / 65535-entry limits. A File System
 * Access writable stream is preferred for large archives, avoiding creation of
 * one giant in-memory Blob. Blob fallback is retained for other browsers.
 */
(function (global) {
  "use strict";
  const enc = new TextEncoder();
  const U32 = 0xffffffffn;
  const U16 = 0xffff;
  const CRC_TABLE = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let n = i;
    for (let j = 0; j < 8; j++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0);
    CRC_TABLE[i] = n >>> 0;
  }
  function u16(v, at, n) { v.setUint16(at, n, true); }
  function u32(v, at, n) { v.setUint32(at, Number(n), true); }
  function u64(v, at, n) { v.setBigUint64(at, BigInt(n), true); }
  function dateFields(date) {
    const d = date instanceof Date && Number.isFinite(date.getTime()) ? date : new Date();
    const year = Math.min(2107, Math.max(1980, d.getFullYear()));
    return [((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31),
      ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()];
  }
  async function crcBlob(blob) {
    let crc = 0xffffffff;
    for (let pos = 0; pos < blob.size; pos += 2 * 1024 * 1024) {
      const chunk = new Uint8Array(await blob.slice(pos, pos + 2 * 1024 * 1024).arrayBuffer());
      for (let i = 0; i < chunk.length; i++) crc = CRC_TABLE[(crc ^ chunk[i]) & 255] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }
  async function compressedBlob(blob) {
    if (typeof CompressionStream !== "function") return null;
    try {
      const compressed = await new Response(blob.stream().pipeThrough(new CompressionStream("deflate-raw"))).blob();
      return compressed.size < blob.size ? compressed : null;
    } catch { return null; }
  }
  function zip64Extra(values) {
    if (!values.length) return new Uint8Array(0);
    const extra = new Uint8Array(4 + values.length * 8);
    const v = new DataView(extra.buffer);
    u16(v, 0, 0x0001);
    u16(v, 2, values.length * 8);
    values.forEach((n, i) => u64(v, 4 + 8 * i, n));
    return extra;
  }
  class ZipWriter {
    constructor({ writable = null } = {}) {
      this.writable = writable;
      this.parts = writable ? null : [];
      this.directory = [];
      this.offset = 0n;
      this.names = new Set();
      this.ended = false;
    }
    async write(...parts) {
      for (const part of parts) {
        if (this.writable) await this.writable.write(part);
        else this.parts.push(part);
      }
    }
    async add(filename, input, { modified = new Date(), compress = true } = {}) {
      if (this.ended) throw new Error("ZIP has already been finished.");
      const name = String(filename || "file").replace(/\\/g, "/").replace(/^\/+/, "");
      if (!name || name.split("/").includes("..") || this.names.has(name)) throw new Error(`Invalid or duplicate ZIP filename: ${name}`);
      const file = input instanceof Blob ? input : new Blob([input]);
      const rawSize = BigInt(file.size);
      const filenameBytes = enc.encode(name);
      if (filenameBytes.length > U16) throw new Error(`ZIP filename too long: ${name}`);
      const crc = await crcBlob(file);
      // Compress small/medium entries; avoid another giant temporary Blob for
      // big files when streaming directly to disk.
      const zipped = compress && (!this.writable || file.size < 256 * 1024 * 1024)
        ? await compressedBlob(file) : null;
      const payload = zipped || file;
      const method = zipped ? 8 : 0;
      const size = BigInt(payload.size);
      const zip64Sizes = size >= U32 || rawSize >= U32;
      const localExtra = zip64Sizes ? zip64Extra([rawSize, size]) : new Uint8Array(0);
      const [time, date] = dateFields(modified);
      const header = new Uint8Array(30);
      const v = new DataView(header.buffer);
      u32(v, 0, 0x04034b50); u16(v, 4, zip64Sizes ? 45 : 20); u16(v, 6, 0x0800);
      u16(v, 8, method); u16(v, 10, time); u16(v, 12, date);
      u32(v, 14, crc); u32(v, 18, zip64Sizes ? U32 : size); u32(v, 22, zip64Sizes ? U32 : rawSize);
      u16(v, 26, filenameBytes.length); u16(v, 28, localExtra.length);
      const offset = this.offset;
      await this.write(header, filenameBytes, localExtra, payload);
      this.directory.push({ filenameBytes, crc, method, time, date, size, rawSize, offset, zip64Sizes });
      this.offset += BigInt(header.length + filenameBytes.length + localExtra.length) + size;
      this.names.add(name);
    }
    async finish() {
      if (this.ended) throw new Error("ZIP has already been finished.");
      this.ended = true;
      const directoryStart = this.offset;
      let directorySize = 0n;
      let anyZip64 = false;
      for (const entry of this.directory) {
        const overflowSize = entry.size >= U32;
        const overflowRaw = entry.rawSize >= U32;
        const overflowOffset = entry.offset >= U32;
        const values = [];
        if (overflowRaw) values.push(entry.rawSize);
        if (overflowSize) values.push(entry.size);
        if (overflowOffset) values.push(entry.offset);
        const extra = zip64Extra(values);
        const usesZip64 = values.length > 0;
        anyZip64 ||= usesZip64;
        const header = new Uint8Array(46);
        const v = new DataView(header.buffer);
        u32(v, 0, 0x02014b50); u16(v, 4, usesZip64 ? 45 : 20); u16(v, 6, usesZip64 ? 45 : 20);
        u16(v, 8, 0x0800); u16(v, 10, entry.method); u16(v, 12, entry.time); u16(v, 14, entry.date);
        u32(v, 16, entry.crc); u32(v, 20, overflowSize ? U32 : entry.size);
        u32(v, 24, overflowRaw ? U32 : entry.rawSize);
        u16(v, 28, entry.filenameBytes.length); u16(v, 30, extra.length); u16(v, 32, 0);
        u16(v, 34, 0); u16(v, 36, 0); u32(v, 38, 0); u32(v, 42, overflowOffset ? U32 : entry.offset);
        await this.write(header, entry.filenameBytes, extra);
        directorySize += BigInt(header.length + entry.filenameBytes.length + extra.length);
      }
      const totalEntries = BigInt(this.directory.length);
      const needsZip64 = anyZip64 || totalEntries >= BigInt(U16) || directorySize >= U32 || directoryStart >= U32 || directoryStart + directorySize + 22n > U32;
      if (needsZip64) {
        const end64 = new Uint8Array(56);
        const v = new DataView(end64.buffer);
        u32(v, 0, 0x06064b50); u64(v, 4, 44n);
        u16(v, 12, 45); u16(v, 14, 45); u32(v, 16, 0); u32(v, 20, 0);
        u64(v, 24, totalEntries); u64(v, 32, totalEntries);
        u64(v, 40, directorySize); u64(v, 48, directoryStart);
        const locator = new Uint8Array(20);
        const lv = new DataView(locator.buffer);
        u32(lv, 0, 0x07064b50); u32(lv, 4, 0);
        u64(lv, 8, directoryStart + directorySize); u32(lv, 16, 1);
        await this.write(end64, locator);
      }
      const end = new Uint8Array(22);
      const v = new DataView(end.buffer);
      u32(v, 0, 0x06054b50);
      u16(v, 8, totalEntries >= BigInt(U16) ? U16 : Number(totalEntries));
      u16(v, 10, totalEntries >= BigInt(U16) ? U16 : Number(totalEntries));
      u32(v, 12, directorySize >= U32 ? U32 : directorySize);
      u32(v, 16, directoryStart >= U32 ? U32 : directoryStart);
      u16(v, 20, 0);
      await this.write(end);
      const size = directoryStart + directorySize + (needsZip64 ? 98n : 22n);
      if (this.writable) {
        await this.writable.close();
        this.writable = null;
        return { size, blob: null, streamed: true };
      }
      return { size, blob: new Blob(this.parts, { type: "application/zip" }), streamed: false };
    }
    async abort() {
      if (this.writable) {
        try { await this.writable.abort(); } catch {}
      }
      this.ended = true;
      this.parts = [];
    }
  }
  global.DmhZipWriter = ZipWriter;
})(globalThis);
