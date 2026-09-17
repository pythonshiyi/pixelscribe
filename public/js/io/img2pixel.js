/**
 * 参考图 → 像素画（v1.4）
 * ---------------------------------------------------------------
 * 纯函数、零依赖、浏览器 / Node 通用（只吃原始 RGBA，不依赖 Canvas）。
 *
 * 流程：降采样（面积平均 / 最近邻）→ 可选边缘增强 → 调色板量化 → 可选抖动。
 * 相比直接把图片 drawImage 到小画布，这里显式做 alpha 加权面积平均与
 * Floyd–Steinberg 误差扩散，能显著减少半透明脏边与色带。
 *
 * @typedef {{r:number,g:number,b:number,a:number}} RGBA
 * @typedef {{colors:RGBA[]}} PaletteLike
 */

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

/** 找到调色板中与 c 最接近的颜色（忽略透明色，除非 c 本身透明） */
export function nearestColor(c, colors) {
  let best = colors[0], bestD = Infinity;
  for (let i = 0; i < colors.length; i++) {
    const p = colors[i];
    if (p.a === 0 && c.a !== 0) continue;
    const dr = p.r - c.r, dg = p.g - c.g, db = p.b - c.b;
    const d = dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114;
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

/**
 * alpha 加权面积平均降采样。
 * @param {Uint8ClampedArray} rgba 源 RGBA
 * @param {number} sw @param {number} sh
 * @param {number} dw @param {number} dh
 * @returns {Uint8ClampedArray}
 */
export function boxDownsample(rgba, sw, sh, dw, dh) {
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let dy = 0; dy < dh; dy++) {
    const sy0 = Math.floor((dy * sh) / dh), sy1 = Math.max(sy0 + 1, Math.floor(((dy + 1) * sh) / dh));
    for (let dx = 0; dx < dw; dx++) {
      const sx0 = Math.floor((dx * sw) / dw), sx1 = Math.max(sx0 + 1, Math.floor(((dx + 1) * sw) / dw));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = sy0; sy < sy1 && sy < sh; sy++) {
        for (let sx = sx0; sx < sx1 && sx < sw; sx++) {
          const i = (sy * sw + sx) * 4;
          const al = rgba[i + 3] / 255;
          r += rgba[i] * al; g += rgba[i + 1] * al; b += rgba[i + 2] * al; a += rgba[i + 3];
          n++;
        }
      }
      const di = (dy * dw + dx) * 4;
      if (!n || a === 0) { out[di] = out[di + 1] = out[di + 2] = out[di + 3] = 0; continue; }
      const aw = a / 255;
      out[di] = clamp255(r / aw);
      out[di + 1] = clamp255(g / aw);
      out[di + 2] = clamp255(b / aw);
      out[di + 3] = clamp255(a / n);
    }
  }
  return out;
}

/** 最近邻降采样（保持硬边，适合本身就是像素风的参考图） */
export function nearestDownsample(rgba, sw, sh, dw, dh) {
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.floor((y * sh) / dh));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.floor((x * sw) / dw));
      const si = (sy * sw + sx) * 4, di = (y * dw + x) * 4;
      out[di] = rgba[si]; out[di + 1] = rgba[si + 1]; out[di + 2] = rgba[si + 2]; out[di + 3] = rgba[si + 3];
    }
  }
  return out;
}

/**
 * 边缘增强（unsharp mask 的简化版）：提升相邻像素差异，让像素画的轮廓更清晰。
 * @param {Uint8ClampedArray} rgba @param {number} w @param {number} h @param {number} amount
 */
export function unsharp(rgba, w, h, amount = 0.6) {
  if (amount <= 0 || w < 3 || h < 3) return rgba;
  const out = new Uint8ClampedArray(rgba);
  const k = amount * 4;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4;
      if (rgba[i + 3] === 0) continue;
      for (let c = 0; c < 3; c++) {
        const center = rgba[i + c];
        const avg = (rgba[i + c - 4] + rgba[i + c + 4] + rgba[i + c - w * 4] + rgba[i + c + w * 4]) / 4;
        out[i + c] = clamp255(center + (center - avg) * k);
      }
    }
  }
  return out;
}

const BAYER8 = [
  [0, 32, 8, 40, 2, 34, 10, 42], [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38], [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41], [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37], [63, 31, 55, 23, 61, 29, 53, 21],
];

/**
 * 量化到调色板，可选抖动。
 * @param {Uint8ClampedArray} rgba
 * @param {number} w @param {number} h
 * @param {PaletteLike} palette
 * @param {{dither?:'none'|'floyd'|'bayer', amount?:number, alphaCut?:number}} [opts]
 * @returns {Uint8ClampedArray}
 */
export function quantize(rgba, w, h, palette, opts = {}) {
  const dither = opts.dither || 'none';
  const amount = opts.amount == null ? 1 : Math.max(0, Math.min(1, opts.amount));
  const alphaCut = opts.alphaCut == null ? 128 : opts.alphaCut;
  const colors = palette.colors.filter((c) => c.a !== 0);
  const out = new Uint8ClampedArray(rgba.length);
  const buf = Float32Array.from(rgba);
  const put = (i, c) => { out[i] = c.r; out[i + 1] = c.g; out[i + 2] = c.b; out[i + 3] = c.a; };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (rgba[i + 3] < alphaCut) { out[i + 3] = 0; continue; }
      let r = buf[i], g = buf[i + 1], b = buf[i + 2];
      if (dither === 'bayer') {
        const t = (BAYER8[y & 7][x & 7] / 64 - 0.5) * 32 * amount;
        r += t; g += t; b += t;
      }
      const c = nearestColor({ r: clamp255(r), g: clamp255(g), b: clamp255(b), a: 255 }, colors);
      put(i, c);
      if (dither === 'floyd') {
        const er = (r - c.r) * amount, eg = (g - c.g) * amount, eb = (b - c.b) * amount;
        const spread = (nx, ny, f) => {
          if (nx < 0 || nx >= w || ny >= h) return;
          const j = (ny * w + nx) * 4;
          if (out[j + 3] !== undefined && rgba[j + 3] < alphaCut) return;
          buf[j] += er * f; buf[j + 1] += eg * f; buf[j + 2] += eb * f;
        };
        spread(x + 1, y, 7 / 16);
        spread(x - 1, y + 1, 3 / 16);
        spread(x, y + 1, 5 / 16);
        spread(x + 1, y + 1, 1 / 16);
      }
    }
  }
  return out;
}

/**
 * 一站式：参考图 RGBA → 目标尺寸像素画 RGBA。
 * @param {Uint8ClampedArray} rgba @param {number} sw @param {number} sh
 * @param {number} dw @param {number} dh
 * @param {{palette?:PaletteLike, quantize?:boolean, dither?:string, sample?:'average'|'nearest',
 *          alphaCut?:number, edge?:number}} [opts]
 */
export function imageToPixels(rgba, sw, sh, dw, dh, opts = {}) {
  let small = opts.sample === 'nearest'
    ? nearestDownsample(rgba, sw, sh, dw, dh)
    : boxDownsample(rgba, sw, sh, dw, dh);
  if (opts.edge) small = unsharp(small, dw, dh, opts.edge);
  if (opts.quantize === false || !opts.palette) {
    const cut = opts.alphaCut == null ? 128 : opts.alphaCut;
    for (let i = 3; i < small.length; i += 4) if (small[i] < cut) { small[i - 3] = 0; small[i - 2] = 0; small[i - 1] = 0; small[i] = 0; }
    return small;
  }
  return quantize(small, dw, dh, opts.palette, { dither: opts.dither, amount: opts.amount, alphaCut: opts.alphaCut });
}
