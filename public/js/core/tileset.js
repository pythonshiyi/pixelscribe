/**
 * 瓦片 / 无缝纹理工具（v2.5）
 * ---------------------------------------------------------------
 *   · offsetWrap：半幅错位视图，快速暴露接缝
 *   · makeSeamless：让左右 / 上下边缘精确对齐，可平铺
 *   · tilePreview：把图重复成 N×N，检查平铺效果
 *   · toTiledJSON：导出 Tiled 可直接导入的 tileset JSON
 * 纯逻辑，Node 可测。
 */

import { PixelBuffer } from './buffer.js';
import { over, pack, unpack } from '../util/color.js';

/**
 * 半幅偏移（错位视图）：把接缝移到画面中央，一眼看出是否可平铺。
 * @param {PixelBuffer} buf
 * @returns {PixelBuffer}
 */
export function offsetWrap(buf) {
  const { width: w, height: h } = buf;
  const out = new PixelBuffer(w, h);
  const dx = w >> 1, dy = h >> 1;
  for (let y = 0; y < h; y++) {
    const sy = (y + dy) % h;
    for (let x = 0; x < w; x++) {
      const sx = (x + dx) % w;
      out.u32[y * w + x] = buf.u32[sy * w + sx];
    }
  }
  return out;
}

const lerp = (a, b, t) => a + (b - a) * t;
function lerpColor(a, b, t) {
  return {
    r: Math.round(lerp(a.r, b.r, t)),
    g: Math.round(lerp(a.g, b.g, t)),
    b: Math.round(lerp(a.b, b.b, t)),
    a: Math.round(lerp(a.a, b.a, t)),
  };
}

/** 对一条轴做边缘对齐（保证两端像素相等）。 */
function seamlessAxis(buf, axis, band) {
  const w = buf.width, h = buf.height;
  const out = buf.clone();
  if (axis === 'x') {
    const b = Math.max(1, Math.min(band, w >> 1));
    for (let y = 0; y < h; y++) {
      for (let k = 0; k < b; k++) {
        const a = unpack(buf.u32[y * w + k]);
        const c = unpack(buf.u32[y * w + (w - 1 - k)]);
        const avg = { r: (a.r + c.r) / 2, g: (a.g + c.g) / 2, b: (a.b + c.b) / 2, a: (a.a + c.a) / 2 };
        const mix = 1 - k / b; // 越靠边越向平均值靠拢
        out.u32[y * w + k] = pack(lerpColor(a, avg, mix));
        out.u32[y * w + (w - 1 - k)] = pack(lerpColor(c, avg, mix));
      }
    }
  } else {
    const b = Math.max(1, Math.min(band, h >> 1));
    for (let x = 0; x < w; x++) {
      for (let k = 0; k < b; k++) {
        const a = unpack(buf.u32[k * w + x]);
        const c = unpack(buf.u32[(h - 1 - k) * w + x]);
        const avg = { r: (a.r + c.r) / 2, g: (a.g + c.g) / 2, b: (a.b + c.b) / 2, a: (a.a + c.a) / 2 };
        const mix = 1 - k / b;
        out.u32[k * w + x] = pack(lerpColor(a, avg, mix));
        out.u32[(h - 1 - k) * w + x] = pack(lerpColor(c, avg, mix));
      }
    }
  }
  return out;
}

/**
 * 让纹理可无缝平铺：把两端像素向平均值收敛，边缘完全相等，向内平滑过渡。
 * @param {PixelBuffer} buf
 * @param {'x'|'y'|'both'} [axis]
 * @param {number} [band] 过渡带宽（像素）
 * @returns {PixelBuffer}
 */
export function makeSeamless(buf, axis = 'both', band = 4) {
  let out = buf.clone();
  if (axis === 'x' || axis === 'both') out = seamlessAxis(out, 'x', band);
  if (axis === 'y' || axis === 'both') out = seamlessAxis(out, 'y', band);
  return out;
}

/**
 * 把图重复成 cols×rows 的平铺预览。
 * @param {PixelBuffer} buf
 * @param {number} [cols] @param {number} [rows]
 * @returns {PixelBuffer}
 */
export function tilePreview(buf, cols = 3, rows = 3) {
  const out = new PixelBuffer(buf.width * cols, buf.height * rows);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      for (let y = 0; y < buf.height; y++) {
        for (let x = 0; x < buf.width; x++) {
          const u = buf.u32[y * buf.width + x];
          if ((u >>> 24) === 0) continue;
          out.u32[(cy * buf.height + y) * out.width + cx * buf.width + x] = u;
        }
      }
    }
  }
  return out;
}

/**
 * 检查接缝是否对齐：返回左右 / 上下边缘的最大通道差（0 表示完全无缝）。
 * @param {PixelBuffer} buf
 */
export function seamError(buf) {
  const { width: w, height: h } = buf;
  let ex = 0, ey = 0;
  for (let y = 0; y < h; y++) {
    const l = unpack(buf.u32[y * w]);
    const r = unpack(buf.u32[y * w + (w - 1)]);
    ex = Math.max(ex, Math.abs(l.r - r.r), Math.abs(l.g - r.g), Math.abs(l.b - r.b), Math.abs(l.a - r.a));
  }
  for (let x = 0; x < w; x++) {
    const t = unpack(buf.u32[x]);
    const b = unpack(buf.u32[(h - 1) * w + x]);
    ey = Math.max(ey, Math.abs(t.r - b.r), Math.abs(t.g - b.g), Math.abs(t.b - b.b), Math.abs(t.a - b.a));
  }
  return { x: ex, y: ey, max: Math.max(ex, ey) };
}

/**
 * 生成 Tiled 可直接导入的 tileset JSON。
 * @param {{name?:string, image:string, imageWidth:number, imageHeight:number,
 *          tileWidth:number, tileHeight:number, columns:number, count:number}} opts
 * @returns {object}
 */
export function toTiledJSON(opts) {
  const count = Math.max(1, opts.count || 1);
  return {
    type: 'tileset',
    name: opts.name || 'pixelscribe',
    image: opts.image,
    imagewidth: opts.imageWidth,
    imageheight: opts.imageHeight,
    tilewidth: opts.tileWidth,
    tileheight: opts.tileHeight,
    tilecount: count,
    columns: Math.max(1, opts.columns || count),
    margin: 0,
    spacing: 0,
    tiles: Array.from({ length: count }, (_, id) => ({ id })),
  };
}
