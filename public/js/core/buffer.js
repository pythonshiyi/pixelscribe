/**
 * 像素缓冲与光栅化图元
 * ---------------------------------------------------------------
 * RGBA8 非预乘，Uint32 视图为小端 0xAABBGGRR。
 * 所有绘制为硬边（不做抗锯齿）——这是像素画的基本要求。
 */

import { over, pack, unpack, TRANSPARENT } from '../util/color.js';

/** @typedef {import('../util/color.js').RGBA} RGBA */

export class PixelBuffer {
  /** @param {number} width @param {number} height */
  constructor(width, height) {
    this.width = width | 0;
    this.height = height | 0;
    this.data = new Uint8ClampedArray(this.width * this.height * 4);
    this.u32 = new Uint32Array(this.data.buffer);
  }

  get length() { return this.u32.length; }

  inBounds(x, y) { return x >= 0 && y >= 0 && x < this.width && y < this.height; }

  /** @returns {number} 打包颜色 */
  getPacked(x, y) {
    if (!this.inBounds(x, y)) return 0;
    return this.u32[y * this.width + x];
  }

  /** @returns {RGBA} */
  get(x, y) { return unpack(this.getPacked(x, y)); }

  setPacked(x, y, u) {
    if (!this.inBounds(x, y)) return;
    this.u32[y * this.width + x] = u >>> 0;
  }

  /** 直接写入（不混合） */
  set(x, y, c) {
    if (!this.inBounds(x, y)) return;
    this.u32[y * this.width + x] = pack(c);
  }

  /**
   * 绘制一个像素（可混合）
   * @param {number} x @param {number} y @param {RGBA} c @param {boolean} [blend]
   */
  plot(x, y, c, blend = true) {
    if (!this.inBounds(x, y)) return;
    const i = y * this.width + x;
    if (!blend || c.a === 255) { this.u32[i] = pack(c); return; }
    if (c.a === 0) return;
    this.u32[i] = pack(over(unpack(this.u32[i]), c));
  }

  clear(c = TRANSPARENT) {
    const u = pack(c);
    this.u32.fill(u);
  }

  /** 用颜色填满整个缓冲 */
  fillAll(c) { this.clear(c); }

  /**
   * 矩形区域填充
   * @param {number} x @param {number} y @param {number} w @param {number} h
   * @param {RGBA} c @param {boolean} [blend]
   */
  fillRect(x, y, w, h, c, blend = true) {
    if (w < 0) { x += w; w = -w; }
    if (h < 0) { y += h; h = -h; }
    const x0 = Math.max(0, x | 0), y0 = Math.max(0, y | 0);
    const x1 = Math.min(this.width, (x | 0) + (w | 0));
    const y1 = Math.min(this.height, (y | 0) + (h | 0));
    if (x1 <= x0 || y1 <= y0) return;
    if (!blend || c.a === 255) {
      const u = pack(c);
      if (c.a === 255) {
        for (let yy = y0; yy < y1; yy++) {
          this.u32.fill(u, yy * this.width + x0, yy * this.width + x1);
        }
        return;
      }
    }
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) this.plot(xx, yy, c, blend);
  }

  /**
   * 区域拷贝（覆盖，不混合）
   * @param {number} sx @param {number} sy @param {number} w @param {number} h @param {number} dx @param {number} dy
   */
  blit(sx, sy, w, h, dx, dy) {
    if (w <= 0 || h <= 0) return;
    const tmp = new Uint32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        tmp[y * w + x] = this.inBounds(sx + x, sy + y) ? this.getPacked(sx + x, sy + y) : 0;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) this.setPacked(dx + x, dy + y, tmp[y * w + x]);
    }
  }

  /** 快照（深拷贝） */
  snapshot() { return new Uint8ClampedArray(this.data); }

  /** @param {Uint8ClampedArray} snap */
  restore(snap) {
    if (snap.length !== this.data.length) throw new Error('快照尺寸不匹配');
    this.data.set(snap);
  }

  /** 统计与另一缓冲不同的像素数 @param {PixelBuffer|Uint8ClampedArray} other */
  diffCount(other) {
    const a = this.u32;
    const b = other instanceof PixelBuffer ? other.u32 : new Uint32Array(other.buffer);
    if (a.length !== b.length) return a.length;
    let n = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
    return n;
  }

  clone() {
    const b = new PixelBuffer(this.width, this.height);
    b.data.set(this.data);
    return b;
  }

  /** 非透明像素数 */
  opaqueCount() {
    let n = 0;
    for (let i = 3; i < this.data.length; i += 4) if (this.data[i] !== 0) n++;
    return n;
  }

  /** 包围盒 {x0,y0,x1,y1}，空则 null */
  bounds() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (this.data[(y * this.width + x) * 4 + 3] !== 0) {
          if (x < x0) x0 = x;
          if (y < y0) y0 = y;
          if (x > x1) x1 = x;
          if (y > y1) y1 = y;
        }
      }
    }
    return x1 < 0 ? null : { x0, y0, x1, y1 };
  }

  /** @returns {ImageData|null} 浏览器环境返回 ImageData */
  toImageData() {
    if (typeof ImageData === 'undefined') return null;
    return new ImageData(new Uint8ClampedArray(this.data), this.width, this.height);
  }

  /** 生成 ASCII 网格（用于回灌模型） */
  toAscii(palette, maxSize = 48) {
    const step = Math.max(1, Math.ceil(Math.max(this.width, this.height) / maxSize));
    const rows = [];
    const used = new Map();
    for (let y = 0; y < this.height; y += step) {
      let line = '';
      for (let x = 0; x < this.width; x += step) {
        const c = this.get(x, y);
        if (c.a === 0) { line += '.'; continue; }
        const hex = `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
        let ch = used.get(hex);
        if (ch === undefined) {
          const i = used.size;
          ch = '0123456789abcdefghijklmnopqrstuvwxyz'[i] ?? '?';
          used.set(hex, ch);
        }
        line += ch;
      }
      rows.push(line);
    }
    const legend = [...used.entries()].map(([hex, ch]) => `${ch}=${hex}`).join(' ');
    return `${legend}\n${rows.join('\n')}`;
  }
}

/* ─────────────────────── 光栅化图元 ─────────────────────── */

/**
 * 带线宽的点阵画点（用于直线加粗）
 * @param {PixelBuffer} buf @param {number} cx @param {number} cy @param {number} w @param {RGBA} c
 */
function plotThick(buf, cx, cy, w, c) {
  if (w <= 1) { buf.plot(cx, cy, c); return; }
  const r = (w - 1) / 2;
  const r2 = r * r + r * 0.5;
  const ir = Math.ceil(r);
  for (let dy = -ir; dy <= ir; dy++) {
    for (let dx = -ir; dx <= ir; dx++) {
      if (dx * dx + dy * dy <= r2) buf.plot(cx + dx, cy + dy, c);
    }
  }
}

/** Bresenham 直线 @param {PixelBuffer} buf */
export function drawLine(buf, x1, y1, x2, y2, c, width = 1) {
  x1 = Math.round(x1); y1 = Math.round(y1); x2 = Math.round(x2); y2 = Math.round(y2);
  let dx = Math.abs(x2 - x1), dy = Math.abs(y2 - y1);
  const sx = x1 < x2 ? 1 : -1, sy = y1 < y2 ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    plotThick(buf, x1, y1, width, c);
    if (x1 === x2 && y1 === y2) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x1 += sx; }
    if (e2 < dx) { err += dx; y1 += sy; }
  }
}

/** 填充椭圆（span 法） @param {PixelBuffer} buf */
export function fillEllipse(buf, cx, cy, rx, ry, c) {
  rx = Math.abs(rx); ry = Math.abs(ry);
  if (rx < 0.5 && ry < 0.5) { buf.plot(Math.round(cx), Math.round(cy), c); return; }
  if (rx < 0.5 || ry < 0.5) {
    drawLine(buf, cx - rx, cy - ry, cx + rx, cy + ry, c);
    return;
  }
  const yMin = Math.ceil(cy - ry), yMax = Math.floor(cy + ry);
  const rx2 = rx * rx, ry2 = ry * ry;
  for (let y = yMin; y <= yMax; y++) {
    const dy = y - cy;
    const t = 1 - (dy * dy) / ry2;
    if (t < 0) continue;
    const half = Math.sqrt(t * rx2);
    const xa = Math.round(cx - half), xb = Math.round(cx + half);
    for (let x = xa; x <= xb; x++) buf.plot(x, y, c);
  }
}

/** 椭圆描边 = 外椭圆 - 内椭圆 @param {PixelBuffer} buf */
export function strokeEllipse(buf, cx, cy, rx, ry, c, width = 1) {
  const tmp = new PixelBuffer(buf.width, buf.height);
  fillEllipse(tmp, cx, cy, rx, ry, c);
  const irx = Math.max(0, Math.abs(rx) - width), iry = Math.max(0, Math.abs(ry) - width);
  for (let y = 0; y < tmp.height; y++) {
    for (let x = 0; x < tmp.width; x++) {
      if (tmp.getPacked(x, y) === 0) continue;
      const dx = (x - cx) / (irx || 0.0001), dy = (y - cy) / (iry || 0.0001);
      if (irx > 0 && iry > 0 && dx * dx + dy * dy <= 1.0) continue;
      buf.plot(x, y, c);
    }
  }
}

/** 圆角矩形 SDF @returns {number} <=0 在内部 */
function rrectSDF(px, py, x, y, w, h, r) {
  const cx = x + w / 2, cy = y + h / 2;
  const hw = w / 2 - r, hh = h / 2 - r;
  const qx = Math.abs(px + 0.5 - cx) - hw;
  const qy = Math.abs(py + 0.5 - cy) - hh;
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

/** 圆角矩形 @param {PixelBuffer} buf */
export function drawRRect(buf, x, y, w, h, r, c, mode = 'fill', width = 1) {
  if (w < 0) { x += w; w = -w; }
  if (h < 0) { y += h; h = -h; }
  r = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.ceil(x + w), y1 = Math.ceil(y + h);
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const d = rrectSDF(px, py, x, y, w, h, r);
      if (d <= 0 && (mode === 'fill' || d > -width)) buf.plot(px, py, c);
    }
  }
}

/** 扫描线填充多边形（奇偶规则） @param {PixelBuffer} buf @param {number[]} pts */
export function fillPoly(buf, pts, c) {
  const n = pts.length / 2;
  if (n < 3) return;
  let yMin = Infinity, yMax = -Infinity;
  for (let i = 0; i < n; i++) {
    const y = pts[i * 2 + 1];
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
  }
  yMin = Math.max(0, Math.floor(yMin));
  yMax = Math.min(buf.height - 1, Math.ceil(yMax));
  const xs = [];
  for (let y = yMin; y <= yMax; y++) {
    xs.length = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const x1 = pts[i * 2], y1 = pts[i * 2 + 1];
      const x2 = pts[j * 2], y2 = pts[j * 2 + 1];
      if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
        xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.round(xs[k]), xb = Math.round(xs[k + 1]);
      for (let x = xa; x <= xb; x++) buf.plot(x, y, c);
    }
  }
}

/** 洪水填充（4 连通，精确匹配） @param {PixelBuffer} buf */
export function floodFill(buf, x, y, c) {
  x = Math.round(x); y = Math.round(y);
  if (!buf.inBounds(x, y)) return 0;
  const target = buf.getPacked(x, y);
  const repl = pack(c);
  if (target === repl) return 0;
  const stack = [x, y];
  const w = buf.width, h = buf.height;
  const seen = new Uint8Array(w * h);
  let n = 0;
  while (stack.length) {
    const cy = stack.pop(), cx = stack.pop();
    if (cx < 0 || cy < 0 || cx >= w || cy >= h) continue;
    const i = cy * w + cx;
    if (seen[i]) continue;
    if (buf.u32[i] !== target) continue;
    seen[i] = 1;
    buf.u32[i] = repl;
    n++;
    stack.push(cx + 1, cy, cx - 1, cy, cx, cy + 1, cx, cy - 1);
  }
  return n;
}

/**
 * 为不透明区域外侧描边
 * @param {PixelBuffer} buf @param {RGBA} c @param {boolean} [inside] true 则描在内侧
 */
export function outline(buf, c, inside = false) {
  const src = buf.snapshot();
  const get = (x, y) => (x < 0 || y < 0 || x >= buf.width || y >= buf.height ? 0 : new Uint32Array(src.buffer)[y * buf.width + x]);
  const w = buf.width, h = buf.height;
  const u32 = new Uint32Array(src.buffer);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const cur = u32[y * w + x];
      const opaque = (cur >>> 24) !== 0;
      if (inside) {
        if (!opaque) continue;
        if (get(x - 1, y) === 0 || get(x + 1, y) === 0 || get(x, y - 1) === 0 || get(x, y + 1) === 0) {
          buf.plot(x, y, c);
        }
      } else {
        if (opaque) continue;
        if (get(x - 1, y) !== 0 || get(x + 1, y) !== 0 || get(x, y - 1) !== 0 || get(x, y + 1) !== 0) {
          buf.plot(x, y, c);
        }
      }
    }
  }
}

const BAYER4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

/** 图案在每个像素处给出 [0,1) 的阈值 */
function ditherThreshold(pattern, gx, gy) {
  switch (pattern) {
    case 'bayer': return (BAYER4[gy & 3][gx & 3] + 0.5) / 16;
    case 'h': return (gy & 1) === 0 ? 0.25 : 0.75;
    case 'v': return (gx & 1) === 0 ? 0.25 : 0.75;
    default: return ((gx + gy) & 1) === 0 ? 0.25 : 0.75;
  }
}

/**
 * 有序抖动：逐像素比较图案阈值与 ratio，决定取 C1 还是 C2
 * @param {PixelBuffer} buf
 * @param {string} pattern checker | bayer | h | v
 * @param {number} scale 图案放大倍数
 * @param {number} ratio C2 占比 0..1
 */
export function dither(buf, x, y, w, h, c1, c2, pattern = 'checker', scale = 1, ratio = 0.5) {
  if (w < 0) { x += w; w = -w; }
  if (h < 0) { y += h; h = -h; }
  scale = Math.max(1, Math.round(scale));
  ratio = Math.max(0, Math.min(1, ratio));
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const gx = Math.floor((x + px) / scale), gy = Math.floor((y + py) / scale);
      buf.set(x + px, y + py, ditherThreshold(pattern, gx, gy) < ratio ? c2 : c1);
    }
  }
}

/** 确定性随机数（mulberry32） */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function noise(buf, x, y, w, h, c, density = 0.1, rng = Math.random) {
  if (w < 0) { x += w; w = -w; }
  if (h < 0) { y += h; h = -h; }
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      if (rng() < density) buf.plot(x + px, y + py, c);
    }
  }
}

export function linearGrad(buf, x, y, w, h, c1, c2, dir = 'v') {
  if (w < 0) { x += w; w = -w; }
  if (h < 0) { y += h; h = -h; }
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const t = dir === 'h' ? (w <= 1 ? 0 : px / (w - 1)) : (h <= 1 ? 0 : py / (h - 1));
      buf.set(x + px, y + py, {
        r: Math.round(c1.r + (c2.r - c1.r) * t),
        g: Math.round(c1.g + (c2.g - c1.g) * t),
        b: Math.round(c1.b + (c2.b - c1.b) * t),
        a: Math.round(c1.a + (c2.a - c1.a) * t),
      });
    }
  }
}

/* ─────────────────────── 变换 ─────────────────────── */

/** @returns {PixelBuffer} */
export function flipBuffer(buf, axis) {
  const out = new PixelBuffer(buf.width, buf.height);
  const { width: w, height: h } = buf;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = axis === 'x' ? w - 1 - x : x;
      const sy = axis === 'y' ? h - 1 - y : y;
      out.setPacked(x, y, buf.getPacked(sx, sy));
    }
  }
  return out;
}

/** 顺时针旋转，输出保持原尺寸（裁剪） */
export function rotateBuffer(buf, deg) {
  const { width: w, height: h } = buf;
  const out = new PixelBuffer(w, h);
  const d = ((deg % 360) + 360) % 360;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sx, sy;
      if (d === 90) { sx = y; sy = h - 1 - x; }
      else if (d === 180) { sx = w - 1 - x; sy = h - 1 - y; }
      else if (d === 270) { sx = w - 1 - y; sy = x; }
      else { sx = x; sy = y; }
      out.setPacked(x, y, buf.getPacked(sx, sy));
    }
  }
  return out;
}

/**
 * 根据对称设置返回坐标变换函数列表（含恒等）
 * @param {number} w @param {number} h
 * @param {'off'|'x'|'y'|'xy'} sym
 * @returns {((x:number,y:number)=>[number,number])[]}
 */
export function symmetryTransforms(w, h, sym) {
  const mx = (x) => w - 1 - x;
  const my = (y) => h - 1 - y;
  const id = (x, y) => [x, y];
  switch (sym) {
    case 'x': return [id, (x, y) => [mx(x), y]];
    case 'y': return [id, (x, y) => [x, my(y)]];
    case 'xy': return [id, (x, y) => [mx(x), y], (x, y) => [x, my(y)], (x, y) => [mx(x), my(y)]];
    default: return [id];
  }
}
