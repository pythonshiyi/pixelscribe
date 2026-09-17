/**
 * 极简 Aseprite (.aseprite) 写出器（零依赖，浏览器 / Node 通用）
 * ---------------------------------------------------------------
 * 只写最常见的组合：单个正常图层 + 每帧一个 raw RGBA cel（32bpp）。
 * 足以在 Aseprite / Libresprite 中打开并继续编辑。
 *
 * 格式参考 ase-file-specs：Header(128B) → 每帧 FrameHeader(16B) → Chunks
 *   Layer chunk = 0x2004，Cel chunk = 0x2005
 * ChunkSize 含 6 字节头部（4 字节 size + 2 字节 type）。
 *
 * @param {number} width @param {number} height
 * @param {Uint8ClampedArray[]} frames 每帧 RGBA（长度 = w*h*4）
 * @param {{layerName?:string, durations?:number[]}} [opts]
 * @returns {Uint8Array}
 */

function toUTF8(str) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
  return Uint8Array.from(Buffer.from(str, 'utf8'));
}

class Writer {
  constructor() { this.bytes = []; }
  u8(v) { this.bytes.push(v & 0xff); }
  u16(v) { this.bytes.push(v & 0xff, (v >> 8) & 0xff); }
  u32(v) { this.bytes.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff); }
  raw(arr) { for (const b of arr) this.bytes.push(b & 0xff); }
  get length() { return this.bytes.length; }
  toUint8() { return Uint8Array.from(this.bytes); }
}

function chunk(type, data) {
  const w = new Writer();
  w.u32(6 + data.length); // 含 size+type
  w.u16(type);
  w.raw(data);
  return w.bytes;
}

function layerChunkData(name) {
  const w = new Writer();
  w.u16(0x0003);       // flags: visible + editable
  w.u16(0);            // layer type: normal image
  w.u16(0);            // child level
  w.u16(0); w.u16(0);  // default width/height (0 = image size)
  w.u16(0);            // blend mode: normal
  w.u8(255);           // opacity
  w.u8(0); w.u8(0); w.u8(0); // reserved
  const bytes = toUTF8(name);
  w.u16(bytes.length);
  w.raw(bytes);
  return w.bytes;
}

function celChunkData(rgba, width, height) {
  const w = new Writer();
  w.u16(0);      // layer index
  w.u16(0);      // x
  w.u16(0);      // y
  w.u8(255);     // opacity
  w.u16(0);      // cel type: raw
  for (let i = 0; i < 7; i++) w.u8(0); // reserved
  // straight RGBA，Aseprite 32bpp 为 R,G,B,A
  w.raw(rgba);
  return w.bytes;
}

export function encodeAseprite(width, height, frames, opts = {}) {
  const layerName = opts.layerName || 'Layer';
  const durations = opts.durations || [];
  const w = width | 0, h = height | 0;
  const count = frames.length;

  // ── Header ──
  const head = new Writer();
  head.u32(0);              // file size（稍后回填）
  head.u16(0xa5e0);         // magic
  head.u16(count);          // frames
  head.u16(w); head.u16(h); // size
  head.u16(32);             // color depth = RGBA
  head.u32(1);              // flags: layer opacity valid
  head.u16(durations[0] || 100); // deprecated speed
  head.u32(0); head.u32(0);
  head.u8(0); head.u8(0); head.u8(0); head.u8(0); // transparent index + ignore
  head.u16(0);              // num colors (0 = 256)
  head.u8(1); head.u8(1);   // pixel width/height
  head.u16(0); head.u16(0); head.u16(0); head.u16(0); // grid
  for (let i = 0; i < 84; i++) head.u8(0); // reserved
  // head 应为 128 字节
  if (head.length !== 128) throw new Error(`Aseprite header size ${head.length} != 128`);

  // ── Frames ──
  const frameBytesList = [];
  for (let f = 0; f < count; f++) {
    const chunks = [];
    if (f === 0) chunks.push(chunk(0x2004, layerChunkData(layerName)));
    chunks.push(chunk(0x2005, celChunkData(frames[f], w, h)));
    const chunkBytes = [];
    for (const c of chunks) for (const b of c) chunkBytes.push(b);
    const frameSize = 16 + chunkBytes.length;

    const fw = new Writer();
    fw.u32(frameSize);
    fw.u16(0xf1fa);
    fw.u16(chunks.length);
    fw.u16(durations[f] || 100);
    fw.u8(0); fw.u8(0);
    fw.u32(chunks.length);
    frameBytesList.push([...fw.bytes, ...chunkBytes]);
  }

  const total = head.length + frameBytesList.reduce((s, a) => s + a.length, 0);
  // 回填文件大小（小端）
  head.bytes[0] = total & 0xff;
  head.bytes[1] = (total >>> 8) & 0xff;
  head.bytes[2] = (total >>> 16) & 0xff;
  head.bytes[3] = (total >>> 24) & 0xff;

  const out = new Writer();
  out.raw(head.bytes);
  for (const a of frameBytesList) out.raw(a);
  return out.toUint8();
}
