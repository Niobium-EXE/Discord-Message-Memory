/* Tiny self-contained ZIP creator for export-all. No external code or libraries.
 * Uses native deflate-raw if available and standard ZIP "store" otherwise.
 * Each payload is kept as a Blob part rather than concatenating all transcripts
 * into one JavaScript string or ArrayBuffer. CRC is calculated in small slices.
 */
(function (global) {
  "use strict";
  const enc = new TextEncoder();
  const LIMIT = 0xffffffff;
  const CRC_TABLE = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let n = i;
    for (let j = 0; j < 8; j++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0);
    CRC_TABLE[i] = n >>> 0;
  }
  function u16(view, offset, n) { view.setUint16(offset, n, true); }
  function u32(view, offset, n) { view.setUint32(offset, n, true); }
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
  class ZipWriter {
    constructor() { this.parts = []; this.directory = []; this.offset = 0; this.names = new Set(); }
    async add(filename, input, { modified = new Date(), compress = true } = {}) {
      const name = String(filename || "file").replace(/\\/g, "/").replace(/^\/+/, "");
      if (!name || name.includes("../") || name === ".." || this.names.has(name)) throw new Error(`Invalid or duplicate ZIP filename: ${name}`);
      const file = input instanceof Blob ? input : new Blob([input]);
      const rawSize = file.size;
      if (rawSize > LIMIT) throw new Error(`ZIP entry is too large: ${name}. Export large chats individually.`);
      const filenameBytes = enc.encode(name);
      if (filenameBytes.length > 65535) throw new Error(`ZIP filename too long: ${name}`);
      const crc = await crcBlob(file);
      const zipped = compress ? (await compressedBlob(file)) : null;
      const payload = zipped || file;
      const method = zipped ? 8 : 0;
      const size = payload.size;
      const [time, date] = dateFields(modified);
      if (this.offset + 30 + filenameBytes.length + size > LIMIT) {
        throw new Error("Bulk ZIP would exceed 4 GB. Export chats individually or turn off embedded media/files.");
      }
      if (this.directory.length >= 65535) throw new Error("Too many ZIP files. Export chats in smaller groups.");
      const header = new Uint8Array(30);
      const dv = new DataView(header.buffer);
      u32(dv, 0, 0x04034b50); u16(dv, 4, 20); u16(dv, 6, 0x0800); // UTF-8 names
      u16(dv, 8, method); u16(dv, 10, time); u16(dv, 12, date);
      u32(dv, 14, crc); u32(dv, 18, size); u32(dv, 22, rawSize);
      u16(dv, 26, filenameBytes.length); u16(dv, 28, 0);
      this.parts.push(header, filenameBytes, payload);
      this.directory.push({ filenameBytes, crc, method, time, date, size, rawSize, offset: this.offset });
      this.offset += header.length + filenameBytes.length + size;
      this.names.add(name);
    }
    finish() {
      const centralParts = [];
      let centralSize = 0;
      for (const entry of this.directory) {
        const header = new Uint8Array(46);
        const dv = new DataView(header.buffer);
        u32(dv, 0, 0x02014b50); u16(dv, 4, 20); u16(dv, 6, 20);
        u16(dv, 8, 0x0800); u16(dv, 10, entry.method); u16(dv, 12, entry.time); u16(dv, 14, entry.date);
        u32(dv, 16, entry.crc); u32(dv, 20, entry.size); u32(dv, 24, entry.rawSize);
        u16(dv, 28, entry.filenameBytes.length); u16(dv, 30, 0); u16(dv, 32, 0);
        u16(dv, 34, 0); u16(dv, 36, 0); u32(dv, 38, 0); u32(dv, 42, entry.offset);
        centralParts.push(header, entry.filenameBytes);
        centralSize += header.length + entry.filenameBytes.length;
      }
      if (this.offset + centralSize + 22 > LIMIT) throw new Error("ZIP is larger than 4 GB. Try exporting without embedded media.");
      const end = new Uint8Array(22);
      const dv = new DataView(end.buffer);
      u32(dv, 0, 0x06054b50);
      u16(dv, 8, this.directory.length); u16(dv, 10, this.directory.length);
      u32(dv, 12, centralSize); u32(dv, 16, this.offset); u16(dv, 20, 0);
      return new Blob([...this.parts, ...centralParts, end], { type: "application/zip" });
    }
  }
  global.DmhZipWriter = ZipWriter;
})(globalThis);
