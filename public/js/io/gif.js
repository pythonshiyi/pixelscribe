/**
 * 纯 JS GIF89a 编码器（零依赖，浏览器 / Node 通用）
 * ---------------------------------------------------------------
 * 支持：全局调色板、多帧、每帧延时、循环、透明色（GIF89a 透明索引）。
 * 像素画帧数少、尺寸小，这里不做帧间增量优化（每帧整幅），换取实现简单与确定性。
 *
 * 用法：
 *   encodeGIF(frames, { width, height, palette, delays, loop })
 *   frames: Uint8ClampedArray[]（每帧 RGBA）
 *   palette: RGBA[]（可含透明色；编码时自动吸附到最近的不透明色）
 */

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

/** 最近色匹配（感知加权，忽略透明色） */
function nearestIndex(r, g, b, colors) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < colors.length; i++) {
    const c = colors[i];
    const dr = c.r - r, dg = c.g - g, db = c.b - b;
    const d = dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/** 把 RGBA 帧量化成调色板索引（alpha<aCut → transparentIndex） */
export function quantizeFrame(rgba, colors, transparentIndex, aCut = 128) {
  const n = rgba.length / 4;
  const idx = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (rgba[i * 4 + 3] < aCut) { idx[i] = transparentIndex; continue; }
    idx[i] = nearestIndex(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2], colors);
  }
  return idx;
}

/** LSB-first 位写入器 */
class BitWriter {
  constructor() { this.bytes = []; this.cur = 0; this.n = 0; }
  write(code, len) {
    for (let i = 0; i < len; i++) {
      if (code & (1 << i)) this.cur |= (1 << this.n);
      this.n++;
      if (this.n === 8) { this.bytes.push(this.cur); this.cur = 0; this.n = 0; }
    }
  }
  flush() { if (this.n > 0) { this.bytes.push(this.cur); this.cur = 0; this.n = 0; } return this.bytes; }
}

/**
 * GIF LZW 压缩。
 * @param {Uint8Array} indices 调色板索引
 * @param {number} minCodeSize 最小码长（通常 = 颜色表位数，>=2）
 * @returns {number[]} 压缩后的字节
 */
export function lzwEncode(indices, minCodeSize) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  const out = new BitWriter();
  let codeSize = minCodeSize + 1;
  let next = eoiCode + 1;
  let dict = new Map();
  out.write(clearCode, codeSize);
  if (indices.length === 0) { out.write(eoiCode, codeSize); return out.flush(); }
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    const found = dict.get(key);
    if (found !== undefined) { prefix = found; continue; }
    out.write(prefix, codeSize);
    dict.set(key, next);
    next++;
    if (next === 4096) {
      out.write(clearCode, codeSize);
      dict = new Map();
      next = eoiCode + 1;
      codeSize = minCodeSize + 1;
    } else if (next > (1 << codeSize) && codeSize < 12) {
      // 解码器落后编码器一步，码长增长用 `>` 才能与标准解码器对齐
      codeSize++;
    }
    prefix = k;
  }
  out.write(prefix, codeSize);
  out.write(eoiCode, codeSize);
  return out.flush();
}

/** 把字节数组切成 GIF 数据子块（每块 <=255，以 0 结尾） */
function subBlocks(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i += 255) {
    const chunk = bytes.slice(i, i + 255);
    out.push(chunk.length, ...chunk);
  }
  out.push(0);
  return out;
}

/**
 * 编码多帧 GIF89a。
 * @param {Uint8ClampedArray[]} frames 每帧 RGBA
 * @param {{width:number,height:number,palette?:{r:number,g:number,b:number,a:number}[],
 *          delays?:number[], loop?:number, alphaCut?:number}} opts
 * @returns {Uint8Array}
 */
export function encodeGIF(frames, opts) {
  const width = opts.width | 0;
  const height = opts.height | 0;
  const alphaCut = opts.alphaCut == null ? 128 : opts.alphaCut;
  const paletteIn = (opts.palette || []).filter((c) => c.a !== 0);
  // 最多 255 个不透明色，保留一个索引给透明色
  const colors = paletteIn.slice(0, 255);
  if (!colors.length) colors.push({ r: 0, g: 0, b: 0, a: 255 });
  const transparentIndex = colors.length; // 紧随其后
  // 颜色表容量必须是 2 的幂（GIF LZW 最小码长 >= 2）
  let bits = 2;
  while ((1 << bits) < colors.length + 1) bits++;
  const tableEntries = 1 << bits;

  const delays = opts.delays || [];
  const loop = opts.loop == null ? 0 : opts.loop;

  const out = [];
  const push = (...v) => { for (const x of v) out.push(x & 0xff); };
  const push16 = (v) => push(v & 0xff, (v >> 8) & 0xff);

  // Header
  for (const ch of 'GIF89a') push(ch.charCodeAt(0));

  // Logical Screen Descriptor
  push16(width); push16(height);
  push(0x80 | 0x70 | (bits - 1)); // GCT=1, color res=7, sort=0, size
  push(0); // background color index
  push(0); // pixel aspect ratio

  // Global Color Table
  for (let i = 0; i < tableEntries; i++) {
    const c = colors[i];
    if (c) push(c.r, c.g, c.b); else push(0, 0, 0);
  }

  // Netscape loop extension
  push(0x21, 0xff, 0x0b);
  for (const ch of 'NETSCAPE2.0') push(ch.charCodeAt(0));
  push(0x03, 0x01); push16(loop); push(0x00);

  for (let f = 0; f < frames.length; f++) {
    const rgba = frames[f];
    const idx = quantizeFrame(rgba, colors, transparentIndex, alphaCut);
    const delayCs = Math.max(2, Math.round((delays[f] || 100) / 10));

    // Graphic Control Extension（disposal=2 清背景，透明安全）
    push(0x21, 0xf9, 0x04);
    push((2 << 2) | 0x01); // disposal=2, transparent flag=1
    push16(delayCs);
    push(transparentIndex);
    push(0x00);

    // Image Descriptor
    push(0x2c);
    push16(0); push16(0); push16(width); push16(height);
    push(0x00); // no local color table, not interlaced

    // Image data
    push(bits);
    const lzw = lzwEncode(idx, bits);
    for (const byte of subBlocks(lzw)) push(byte);
  }

  push(0x3b); // Trailer
  return new Uint8Array(out);
}
