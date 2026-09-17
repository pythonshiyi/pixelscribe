/**
 * 程序化渲染效果（S1：让确定性的 CPU 引擎也能逼近写实质感）
 * ---------------------------------------------------------------
 * 这一层是「程序 + 先验」里的轻量先验：不依赖任何神经网络，
 * 用亮度场推导法线，再做方向光/高光/泛光/色调映射，
 * 从而把平涂的像素画推进到「有体积、有材质、有光」的层次。
 *
 * 约定：
 *   · 所有函数就地修改 PixelBuffer；
 *   · 完全确定性（噪声必须显式 seed）；
 *   · 透明像素不参与受光与色调，避免脏边。
 *
 * @typedef {import('./buffer.js').PixelBuffer} PixelBuffer
 * @typedef {import('../util/color.js').RGBA} RGBA
 */

import { mulberry32 } from './buffer.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

/* ───────────────────────── 基础工具 ───────────────────────── */

/** 感知亮度 0..1 @param {RGBA} c */
function lum(c) { return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255; }

/** 读取亮度场：透明处取 0，并用 alpha 标记有效性 */
function luminanceField(buf) {
  const n = buf.width * buf.height;
  const L = new Float32Array(n);
  const A = new Uint8Array(n);
  const { data } = buf;
  for (let i = 0; i < n; i++) {
    const a = data[i * 4 + 3];
    A[i] = a;
    if (a === 0) { L[i] = 0; continue; }
    L[i] = (0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2]) / 255;
  }
  return { L, A };
}

/** 归一化匀光方向（dx,dy 为「指向光源」的方向，图像坐标系 y 向下） */
function normalizeLights(lights) {
  const list = (lights && lights.length ? lights : [{ dx: -1, dy: -1, z: 1, strength: 1, color: { r: 255, g: 255, b: 255 } }]);
  return list.map((l) => {
    const dx = Number(l.dx) || 0, dy = Number(l.dy) || 0, z = l.z == null ? 1 : Number(l.z);
    const len = Math.hypot(dx, dy, z) || 1;
    return {
      x: dx / len, y: dy / len, z: z / len,
      strength: l.strength == null ? 1 : Number(l.strength),
      color: normalizeColor(l.color),
    };
  });
}

function normalizeColor(c) {
  if (!c) return { r: 1, g: 1, b: 1 };
  if (typeof c === 'string') {
    const s = c.replace(/^#/, '');
    const h = s.length === 3 ? s.replace(/./g, (ch) => ch + ch) : s;
    if (h.length < 6) return { r: 1, g: 1, b: 1 };
    return { r: parseInt(h.slice(0, 2), 16) / 255, g: parseInt(h.slice(2, 4), 16) / 255, b: parseInt(h.slice(4, 6), 16) / 255 };
  }
  return { r: clamp01((c.r ?? 255) / 255), g: clamp01((c.g ?? 255) / 255), b: clamp01((c.b ?? 255) / 255) };
}

/* ───────────────────────── 方向光 / 浮雕 ───────────────────────── */

/**
 * 从亮度场推导法线（Sobel 一阶差分，越界视为透明=0，可在轮廓处产生边缘光）。
 * @returns {Float32Array} 扁平 [nx,ny,nz] × n
 */
export function surfaceNormals(buf, strength = 2) {
  const { width: w, height: h } = buf;
  const { L } = luminanceField(buf);
  const N = new Float32Array(w * h * 3);
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : L[y * w + x]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gx = (at(x + 1, y) - at(x - 1, y)) * 0.5;
      const gy = (at(x, y + 1) - at(x, y - 1)) * 0.5;
      let nx = -gx * strength, ny = -gy * strength, nz = 1;
      const len = Math.hypot(nx, ny, nz) || 1;
      const i = (y * w + x) * 3;
      N[i] = nx / len; N[i + 1] = ny / len; N[i + 2] = nz / len;
    }
  }
  return N;
}

/**
 * 方向光漫反射（浮雕受光）：把平涂色按法线·光源做明暗塑形。
 * @param {PixelBuffer} buf
 * @param {{lights?:any[], strength?:number, ambient?:number, normalStrength?:number}} [opts]
 */
export function applyRelief(buf, opts = {}) {
  const strength = opts.strength == null ? 0.85 : Number(opts.strength);
  const ambient = opts.ambient == null ? 0.35 : clamp01(Number(opts.ambient));
  if (strength <= 0) return;
  const lights = normalizeLights(opts.lights);
  const N = surfaceNormals(buf, opts.normalStrength == null ? 2 : Number(opts.normalStrength));
  const { width: w } = buf;
  const { data } = buf;
  const n = w * buf.height;
  for (let i = 0; i < n; i++) {
    const di = i * 4;
    if (data[di + 3] === 0) continue;
    let dr = 0, dg = 0, db = 0;
    const nx = N[i * 3], ny = N[i * 3 + 1], nz = N[i * 3 + 2];
    for (const l of lights) {
      const dot = Math.max(0, nx * l.x + ny * l.y + nz * l.z);
      const k = dot * l.strength;
      if (k <= 0) continue;
      dr += k * l.color.r; dg += k * l.color.g; db += k * l.color.b;
    }
    // result = base × (ambient + Σ diffuse × lightColor × strength)
    data[di] = clamp255(data[di] * (ambient + dr * strength));
    data[di + 1] = clamp255(data[di + 1] * (ambient + dg * strength));
    data[di + 2] = clamp255(data[di + 2] * (ambient + db * strength));
  }
}

/**
 * 高光（Glossy specular）：法线接近半程向量处叠加光源色。
 * @param {PixelBuffer} buf
 * @param {{lights?:any[], strength?:number, power?:number, normalStrength?:number}} [opts]
 */
export function applySpecular(buf, opts = {}) {
  const strength = opts.strength == null ? 0.6 : Number(opts.strength);
  if (strength <= 0) return;
  const power = opts.power == null ? 16 : Math.max(1, Number(opts.power));
  const lights = normalizeLights(opts.lights);
  const N = surfaceNormals(buf, opts.normalStrength == null ? 2 : Number(opts.normalStrength));
  const { data } = buf;
  const n = buf.width * buf.height;
  for (let i = 0; i < n; i++) {
    const di = i * 4;
    if (data[di + 3] === 0) continue;
    const nx = N[i * 3], ny = N[i * 3 + 1], nz = N[i * 3 + 2];
    let sr = 0, sg = 0, sb = 0;
    for (const l of lights) {
      // 半程向量（视点 (0,0,1)）
      let hx = l.x, hy = l.y, hz = l.z + 1;
      const hl = Math.hypot(hx, hy, hz) || 1;
      hx /= hl; hy /= hl; hz /= hl;
      const dot = Math.max(0, nx * hx + ny * hy + nz * hz);
      const k = Math.pow(dot, power) * l.strength * strength;
      if (k <= 0.001) continue;
      sr += k * l.color.r; sg += k * l.color.g; sb += k * l.color.b;
    }
    if (sr <= 0 && sg <= 0 && sb <= 0) continue;
    data[di] = clamp255(data[di] + sr * 255);
    data[di + 1] = clamp255(data[di + 1] + sg * 255);
    data[di + 2] = clamp255(data[di + 2] + sb * 255);
  }
}

/* ───────────────────────── 模糊 / 泛光 ───────────────────────── */

/**
 * 盒式模糊（预乘 alpha，避免透明区渗色）。
 * @param {PixelBuffer} buf @param {number} radius
 */
export function blur(buf, radius = 1) {
  const r = Math.max(0, Math.round(radius));
  if (r < 1) return;
  const { width: w, height: h, data } = buf;
  const n = w * h;
  const src = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const a = data[i * 4 + 3] / 255;
    src[i * 4] = data[i * 4] * a;
    src[i * 4 + 1] = data[i * 4 + 1] * a;
    src[i * 4 + 2] = data[i * 4 + 2] * a;
    src[i * 4 + 3] = data[i * 4 + 3];
  }
  const tmp = new Float32Array(n * 4);
  const box = (srcArr, dstArr, horizontal) => {
    const outer = horizontal ? h : w;
    const inner = horizontal ? w : h;
    const win = 2 * r + 1;
    for (let o = 0; o < outer; o++) {
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
      const idx = (k) => (horizontal ? (o * w + k) * 4 : (k * w + o) * 4);
      for (let k = -r; k <= r; k++) {
        const kk = Math.min(inner - 1, Math.max(0, k));
        const ii = idx(kk);
        s0 += srcArr[ii]; s1 += srcArr[ii + 1]; s2 += srcArr[ii + 2]; s3 += srcArr[ii + 3];
      }
      for (let k = 0; k < inner; k++) {
        const ii = idx(k);
        dstArr[ii] = s0 / win; dstArr[ii + 1] = s1 / win; dstArr[ii + 2] = s2 / win; dstArr[ii + 3] = s3 / win;
        const addK = Math.min(inner - 1, k + r + 1);
        const subK = Math.max(0, k - r);
        const ai = idx(addK), si = idx(subK);
        s0 += srcArr[ai] - srcArr[si];
        s1 += srcArr[ai + 1] - srcArr[si + 1];
        s2 += srcArr[ai + 2] - srcArr[si + 2];
        s3 += srcArr[ai + 3] - srcArr[si + 3];
      }
    }
  };
  box(src, tmp, true);
  box(tmp, src, false);
  for (let i = 0; i < n; i++) {
    const a = src[i * 4 + 3];
    if (a <= 0.5) { data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = data[i * 4 + 3] = 0; continue; }
    const inv = 255 / a;
    data[i * 4] = clamp255(src[i * 4] * inv);
    data[i * 4 + 1] = clamp255(src[i * 4 + 1] * inv);
    data[i * 4 + 2] = clamp255(src[i * 4 + 2] * inv);
    data[i * 4 + 3] = clamp255(a);
  }
}

/**
 * 泛光 / 辉光：提取高亮区域模糊后叠加（Add），模拟镜头光晕与光源溢出。
 * @param {PixelBuffer} buf
 * @param {{threshold?:number, strength?:number, radius?:number}} [opts]
 */
export function applyBloom(buf, opts = {}) {
  const threshold = clamp01(opts.threshold == null ? 0.7 : Number(opts.threshold));
  const strength = opts.strength == null ? 0.6 : Number(opts.strength);
  const radius = opts.radius == null ? 2 : Math.max(1, Math.round(Number(opts.radius)));
  if (strength <= 0) return;
  const { width: w, height: h } = buf;
  const bright = new (buf.constructor)(w, h);
  const { data } = buf;
  for (let i = 0; i < w * h; i++) {
    const di = i * 4;
    if (data[di + 3] === 0) continue;
    const l = (0.2126 * data[di] + 0.7152 * data[di + 1] + 0.0722 * data[di + 2]) / 255;
    if (l <= threshold) continue;
    const k = (l - threshold) / (1 - threshold);
    bright.data[di] = data[di];
    bright.data[di + 1] = data[di + 1];
    bright.data[di + 2] = data[di + 2];
    bright.data[di + 3] = clamp255(k * 255);
  }
  blur(bright, radius);
  const bd = bright.data;
  for (let i = 0; i < w * h; i++) {
    const di = i * 4;
    const a = (bd[di + 3] / 255) * strength;
    if (a <= 0) continue;
    data[di] = clamp255(data[di] + bd[di] * a);
    data[di + 1] = clamp255(data[di + 1] + bd[di + 1] * a);
    data[di + 2] = clamp255(data[di + 2] + bd[di + 2] * a);
    if (data[di + 3] === 0) data[di + 3] = clamp255(bd[di + 3] * strength);
  }
}

/* ───────────────────────── 色调映射 ───────────────────────── */

/**
 * 色调映射：gamma / 对比度 / 饱和度 / 亮度 / 暗角。
 * 模仿相机的曲线，是「写实感」最廉价也最有效的一步。
 * @param {PixelBuffer} buf
 * @param {{gamma?:number, contrast?:number, saturation?:number, brightness?:number, vignette?:number}} [opts]
 */
export function applyTone(buf, opts = {}) {
  const gamma = opts.gamma == null ? 1 : Math.max(0.05, Number(opts.gamma));
  const contrast = opts.contrast == null ? 1 : Math.max(0, Number(opts.contrast));
  const saturation = opts.saturation == null ? 1 : Math.max(0, Number(opts.saturation));
  const brightness = opts.brightness == null ? 0 : Number(opts.brightness);
  const vignette = opts.vignette == null ? 0 : clamp01(Number(opts.vignette));
  const { width: w, height: h, data } = buf;
  const LUT = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    let x = v / 255;
    if (gamma !== 1) x = Math.pow(x, 1 / gamma);
    if (contrast !== 1) x = (x - 0.5) * contrast + 0.5;
    x += brightness;
    LUT[v] = clamp255(x * 255);
  }
  const halfW = (w - 1) / 2, halfH = (h - 1) / 2;
  const maxR2 = halfW * halfW + halfH * halfH || 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const di = (y * w + x) * 4;
      if (data[di + 3] === 0) continue;
      let r = LUT[data[di]], g = LUT[data[di + 1]], b = LUT[data[di + 2]];
      if (saturation !== 1) {
        const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        r = l + (r - l) * saturation;
        g = l + (g - l) * saturation;
        b = l + (b - l) * saturation;
      }
      if (vignette > 0) {
        const dx = (x - halfW) / (halfW || 1), dy = (y - halfH) / (halfH || 1);
        const k = 1 - vignette * clamp01((dx * dx + dy * dy) * 0.5);
        r *= k; g *= k; b *= k;
      }
      data[di] = clamp255(r);
      data[di + 1] = clamp255(g);
      data[di + 2] = clamp255(b);
    }
  }
}

/* ───────────────────────── 程序化材质（fBm 噪声） ───────────────────────── */

function hash2(x, y, seed) {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smooth(t) { return t * t * (3 - 2 * t); }

/** 二维值噪声 */
function valueNoise(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  const u = smooth(xf), v = smooth(yf);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

/** 分形布朗运动（多倍频值噪声），返回 0..1 */
export function fbm2(x, y, { octaves = 4, scale = 4, lacunarity = 2, gain = 0.5, seed = 1 } = {}) {
  let amp = 0.5, freq = 1 / Math.max(0.001, scale), sum = 0, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(x * freq, y * freq, seed + o * 101);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}

/**
 * 用分形噪声生成/调制材质。
 * @param {PixelBuffer} buf
 * @param {{x?:number,y?:number,w?:number,h?:number,c1?:RGBA,c2?:RGBA,
 *          octaves?:number,scale?:number,mode?:'fill'|'over'|'mod',seed?:number}} [opts]
 */
export function applyFbm(buf, opts = {}) {
  const x0 = Math.round(opts.x ?? 0), y0 = Math.round(opts.y ?? 0);
  const w0 = Math.round(opts.w ?? buf.width), h0 = Math.round(opts.h ?? buf.height);
  const c1 = opts.c1 || { r: 0, g: 0, b: 0, a: 255 };
  const c2 = opts.c2 || { r: 255, g: 255, b: 255, a: 255 };
  const octaves = Math.max(1, Math.min(8, Math.round(opts.octaves ?? 4)));
  const scale = Math.max(0.5, Number(opts.scale ?? 4));
  const mode = opts.mode || 'fill';
  const rng = mulberry32((opts.seed ?? 1) >>> 0);
  const base = (rng() * 1e9) | 0;
  for (let y = y0; y < y0 + h0; y++) {
    for (let x = x0; x < x0 + w0; x++) {
      if (!buf.inBounds(x, y)) continue;
      const t = fbm2(x, y, { octaves, scale, seed: base });
      if (mode === 'fill') {
        buf.set(x, y, {
          r: Math.round(c1.r + (c2.r - c1.r) * t),
          g: Math.round(c1.g + (c2.g - c1.g) * t),
          b: Math.round(c1.b + (c2.b - c1.b) * t),
          a: Math.round(c1.a + (c2.a - c1.a) * t),
        });
      } else if (mode === 'over') {
        const src = {
          r: Math.round(c1.r + (c2.r - c1.r) * t),
          g: Math.round(c1.g + (c2.g - c1.g) * t),
          b: Math.round(c1.b + (c2.b - c1.b) * t),
          a: clamp255(t * 255),
        };
        buf.plot(x, y, src);
      } else { // mod：按噪声调制现有明度
        const cur = buf.get(x, y);
        if (cur.a === 0) continue;
        const k = 0.55 + 0.9 * t;
        buf.set(x, y, { r: clamp255(cur.r * k), g: clamp255(cur.g * k), b: clamp255(cur.b * k), a: cur.a });
      }
    }
  }
}

/* ───────────────────────── 风格化渲染管线 ───────────────────────── */

/** 风格 → 程序化管线参数（神经后端不可用时的“先验”） */
export const STYLE_PRESETS = {
  pixel: { label: '像素', tone: null },
  painting: { label: '油画/手绘', relief: { strength: 0.5, ambient: 0.55 }, tone: { gamma: 1.05, contrast: 1.08, saturation: 1.12, vignette: 0.12 } },
  ink: { label: '水墨/线稿', tone: { gamma: 1.15, contrast: 1.35, saturation: 0.15 } },
  anime: { label: '动画/赛璐璐', bloom: { threshold: 0.78, strength: 0.4, radius: 2 }, tone: { gamma: 1.0, contrast: 1.12, saturation: 1.25 } },
  '3d': { label: '3D/黏土', relief: { strength: 0.95, ambient: 0.3 }, specular: { strength: 0.7, power: 24 }, tone: { gamma: 1.05, contrast: 1.12, saturation: 1.05, vignette: 0.15 } },
  photo: { label: '写实照片', relief: { strength: 1.0, ambient: 0.28 }, specular: { strength: 0.8, power: 32 }, bloom: { threshold: 0.72, strength: 0.55, radius: 3 }, tone: { gamma: 1.08, contrast: 1.16, saturation: 1.08, vignette: 0.2 } },
};

/** 规范化风格名 */
export function normalizeStyle(name) {
  const v = String(name || '').toLowerCase();
  const map = {
    pixel: 'pixel', pixelart: 'pixel', sprite: 'pixel',
    photo: 'photo', photoreal: 'photo', realistic: 'photo', real: 'photo',
    painting: 'painting', paint: 'painting', oil: 'painting', handdrawn: 'painting',
    ink: 'ink', sketch: 'ink', line: 'ink', lineart: 'ink',
    anime: 'anime', cel: 'anime', cartoon: 'anime',
    '3d': '3d', clay: '3d', render: '3d', cg: '3d',
  };
  return map[v] || 'pixel';
}

/**
 * 对当前缓冲应用某一风格的程序化渲染管线。
 * @param {PixelBuffer} buf
 * @param {string} style
 * @param {{lights?:any[], seed?:number}} [opts]
 */
export function applyProceduralPipeline(buf, style, opts = {}) {
  const key = normalizeStyle(style);
  const preset = STYLE_PRESETS[key];
  if (!preset || key === 'pixel') return key;
  if (preset.relief) applyRelief(buf, { ...preset.relief, lights: opts.lights });
  if (preset.specular) applySpecular(buf, { ...preset.specular, lights: opts.lights });
  if (preset.bloom) applyBloom(buf, preset.bloom);
  if (preset.tone) applyTone(buf, preset.tone);
  return key;
}
