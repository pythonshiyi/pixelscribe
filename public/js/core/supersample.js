/**
 * 平滑超分（v1.7：author small, render big）
 * ---------------------------------------------------------------
 * 把低分辨率画布放大为目标尺寸，并补上「写实感」所需的高频细节：
 *   1. alpha 预乘双线性插值（消除最近邻的硬块）
 *   2. 边缘感知锐化（unsharp，保住轮廓）
 *   3. 低强度确定性微纹理（避免塑料感）
 *
 * 与「最近邻放大」并列：像素风用最近邻，写实/绘画用平滑超分。
 * 纯函数、零依赖，浏览器 / Node 通用。
 *
 * @typedef {import('./buffer.js').PixelBuffer} PixelBuffer
 */

import { PixelBuffer } from './buffer.js';
import { mulberry32 } from './buffer.js';

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

function hash2(x, y, seed) {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smooth(t) { return t * t * (3 - 2 * t); }

function valueNoise(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  const u = smooth(xf), v = smooth(yf);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

/**
 * 双线性超分（预乘 alpha，避免透明边缘出现黑边/彩边）。
 * @param {PixelBuffer} src @param {number} scale
 * @returns {PixelBuffer}
 */
export function upscaleBilinear(src, scale) {
  const w = src.width, h = src.height;
  const ow = Math.round(w * scale), oh = Math.round(h * scale);
  const out = new PixelBuffer(ow, oh);
  const sd = src.data, od = out.data;
  const pm = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const a = sd[i * 4 + 3] / 255;
    pm[i * 4] = sd[i * 4] * a; pm[i * 4 + 1] = sd[i * 4 + 1] * a;
    pm[i * 4 + 2] = sd[i * 4 + 2] * a; pm[i * 4 + 3] = sd[i * 4 + 3];
  }
  for (let y = 0; y < oh; y++) {
    const fy = (y + 0.5) / scale - 0.5;
    const y0 = Math.max(0, Math.min(h - 1, Math.floor(fy)));
    const y1 = Math.max(0, Math.min(h - 1, y0 + 1));
    const wy = fy - Math.floor(fy);
    for (let x = 0; x < ow; x++) {
      const fx = (x + 0.5) / scale - 0.5;
      const x0 = Math.max(0, Math.min(w - 1, Math.floor(fx)));
      const x1 = Math.max(0, Math.min(w - 1, x0 + 1));
      const wx = fx - Math.floor(fx);
      const i00 = (y0 * w + x0) * 4, i10 = (y0 * w + x1) * 4;
      const i01 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
      const w00 = (1 - wx) * (1 - wy), w10 = wx * (1 - wy), w01 = (1 - wx) * wy, w11 = wx * wy;
      let r = 0, g = 0, b = 0, a = 0;
      r = pm[i00] * w00 + pm[i10] * w10 + pm[i01] * w01 + pm[i11] * w11;
      g = pm[i00 + 1] * w00 + pm[i10 + 1] * w10 + pm[i01 + 1] * w01 + pm[i11 + 1] * w11;
      b = pm[i00 + 2] * w00 + pm[i10 + 2] * w10 + pm[i01 + 2] * w01 + pm[i11 + 2] * w11;
      a = pm[i00 + 3] * w00 + pm[i10 + 3] * w10 + pm[i01 + 3] * w01 + pm[i11 + 3] * w11;
      const di = (y * ow + x) * 4;
      if (a <= 0.5) { od[di] = od[di + 1] = od[di + 2] = od[di + 3] = 0; continue; }
      const inv = 255 / a;
      od[di] = clamp255(r * inv); od[di + 1] = clamp255(g * inv); od[di + 2] = clamp255(b * inv); od[di + 3] = clamp255(a);
    }
  }
  return out;
}

/**
 * 边缘感知锐化（不透明区域）。
 * @param {PixelBuffer} buf @param {number} amount
 */
export function sharpen(buf, amount = 0.6) {
  if (amount <= 0 || buf.width < 3 || buf.height < 3) return buf;
  const w = buf.width, h = buf.height, d = buf.data;
  const src = new Uint8ClampedArray(d);
  const k = amount * 4;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4;
      if (src[i + 3] === 0) continue;
      for (let c = 0; c < 3; c++) {
        const center = src[i + c];
        const avg = (src[i + c - 4] + src[i + c + 4] + src[i + c - w * 4] + src[i + c + w * 4]) / 4;
        d[i + c] = clamp255(center + (center - avg) * k);
      }
    }
  }
  return buf;
}

/**
 * 叠加低强度确定性微纹理，模拟胶片颗粒 / 材质，避免大片平滑区域的塑料感。
 * @param {PixelBuffer} buf @param {number} amount 0..1
 * @param {number} seed
 */
export function addGrain(buf, amount = 0.04, seed = 1) {
  if (amount <= 0) return buf;
  const { width: w, height: h, data } = buf;
  const rng = mulberry32(seed >>> 0);
  for (let i = 0; i < w * h; i++) {
    const di = i * 4;
    if (data[di + 3] === 0) continue;
    const x = i % w, y = (i / w) | 0;
    // 分形微噪声（两级）
    const n = valueNoise(x * 0.35, y * 0.35, seed) * 0.7 + rng() * 0.3;
    const k = (n - 0.5) * 2 * amount * 255;
    data[di] = clamp255(data[di] + k);
    data[di + 1] = clamp255(data[di + 1] + k);
    data[di + 2] = clamp255(data[di + 2] + k);
  }
  return buf;
}

/**
 * 一站式平滑超分。
 * @param {PixelBuffer} src
 * @param {number} scale 放大倍数（>=1）
 * @param {{sharpen?:number, grain?:number, seed?:number, maxPixels?:number}} [opts]
 * @returns {PixelBuffer}
 */
export function supersample(src, scale, opts = {}) {
  const s = Math.max(1, scale);
  const maxPixels = opts.maxPixels || 4096 * 4096;
  let out = upscaleBilinear(src, s);
  if (out.width * out.height > maxPixels) out = upscaleBilinear(src, Math.sqrt(maxPixels / (src.width * src.height)));
  if (opts.sharpen !== 0) sharpen(out, opts.sharpen == null ? 0.5 : opts.sharpen);
  if (opts.grain) addGrain(out, opts.grain, opts.seed || 1);
  return out;
}
