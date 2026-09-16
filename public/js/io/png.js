/**
 * 纯 JS PNG 编码器（零依赖，浏览器 / Node 通用）
 * ---------------------------------------------------------------
 * 使用 DEFLATE "stored" 块（不压缩），产出完全合规的 PNG。
 * 像素画体积极小，未压缩带来的体积损失可忽略，换来的是
 * 在浏览器与 Node 中使用同一套代码，且不依赖 Canvas / zlib。
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes, start = 0, end = bytes.length) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes) {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

class ByteWriter {
  constructor() { this.chunks = []; this.length = 0; }
  push(bytes) { this.chunks.push(bytes); this.length += bytes.length; }
  u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0); this.push(b); }
  concat() {
    const out = new Uint8Array(this.length);
    let o = 0;
    for (const c of this.chunks) { out.set(c, o); o += c.length; }
    return out;
  }
}

/**
 * 组装一个 PNG chunk。
 * 注意：CRC 只覆盖 type + data，**不包含**长度字段（PNG 规范 5.3）。
 */
function chunk(type, data) {
  const typeBytes = new Uint8Array([...type].map((ch) => ch.charCodeAt(0)));
  const payload = concatBytes(typeBytes, data);
  const crcW = new ByteWriter();
  crcW.u32(crc32(payload));
  const w = new ByteWriter();
  w.u32(data.length);
  w.push(payload);
  w.push(crcW.concat());
  return w.concat();
}

function concatBytes(...arrs) {
  const total = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

/** 把原始数据包装成 zlib 流（stored blocks） */
function zlibStore(raw) {
  const blocks = [];
  const MAX = 65535;
  let off = 0;
  if (raw.length === 0) {
    blocks.push(new Uint8Array([0x01, 0x00, 0x00, 0xff, 0xff]));
  }
  while (off < raw.length) {
    const len = Math.min(MAX, raw.length - off);
    const final = off + len >= raw.length ? 1 : 0;
    const head = new Uint8Array(5);
    head[0] = final;
    head[1] = len & 0xff;
    head[2] = (len >>> 8) & 0xff;
    head[3] = ~len & 0xff;
    head[4] = (~len >>> 8) & 0xff;
    blocks.push(head, raw.subarray(off, off + len));
    off += len;
  }
  const body = concatBytes(...blocks);
  const tail = new Uint8Array(4);
  new DataView(tail.buffer).setUint32(0, adler32(raw));
  return concatBytes(new Uint8Array([0x78, 0x01]), body, tail);
}

/**
 * 编码 RGBA 像素数据为 PNG
 * @param {Uint8ClampedArray|Uint8Array} rgba
 * @param {number} width
 * @param {number} height
 * @returns {Uint8Array}
 */
export function encodePNG(rgba, width, height) {
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray ? rgba.subarray(y * stride, (y + 1) * stride) : rgba.slice(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return concatBytes(
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibStore(raw)),
    chunk('IEND', new Uint8Array(0)),
  );
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** 环境无关的 base64 编码 @param {Uint8Array} bytes */
export function toBase64(bytes) {
  let out = '';
  const n = bytes.length;
  for (let i = 0; i < n; i += 3) {
    const b0 = bytes[i], b1 = i + 1 < n ? bytes[i + 1] : 0, b2 = i + 2 < n ? bytes[i + 2] : 0;
    out += B64[b0 >> 2] + B64[((b0 & 3) << 4) | (b1 >> 4)] +
      (i + 1 < n ? B64[((b1 & 15) << 2) | (b2 >> 6)] : '=') +
      (i + 2 < n ? B64[b2 & 63] : '=');
  }
  return out;
}

/**
 * 最近邻放大到指定尺寸后编码 PNG
 * @param {Uint8ClampedArray} rgba
 * @param {number} width @param {number} height
 * @param {number} outWidth @param {number} outHeight
 */
export function encodePNGScaled(rgba, width, height, outWidth, outHeight) {
  if (outWidth === width && outHeight === height) return encodePNG(rgba, width, height);
  const out = new Uint8ClampedArray(outWidth * outHeight * 4);
  for (let y = 0; y < outHeight; y++) {
    const sy = Math.min(height - 1, Math.floor((y * height) / outHeight));
    for (let x = 0; x < outWidth; x++) {
      const sx = Math.min(width - 1, Math.floor((x * width) / outWidth));
      const si = (sy * width + sx) * 4;
      const di = (y * outWidth + x) * 4;
      out[di] = rgba[si];
      out[di + 1] = rgba[si + 1];
      out[di + 2] = rgba[si + 2];
      out[di + 3] = rgba[si + 3];
    }
  }
  return encodePNG(out, outWidth, outHeight);
}

/** 上传给视觉模型的 data URL */
export function toDataURL(rgba, width, height, longEdge = 384) {
  const scale = Math.max(1, Math.round(longEdge / Math.max(width, height)));
  const ow = width * scale, oh = height * scale;
  const png = encodePNGScaled(rgba, width, height, ow, oh);
  return `data:image/png;base64,${toBase64(png)}`;
}
