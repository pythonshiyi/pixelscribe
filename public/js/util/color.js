/**
 * 颜色工具
 * ---------------------------------------------------------------
 * 内部颜色表示统一为 RGBA 对象 { r, g, b, a }（0-255）。
 * 缓冲区内以 Uint32 打包，字节序为小端：0xAABBGGRR。
 */

/** @typedef {{r:number,g:number,b:number,a:number}} RGBA */

export const TRANSPARENT = Object.freeze({ r: 0, g: 0, b: 0, a: 0 });

/** 跨调色板始终可用的通用色名 */
export const UNIVERSAL_NAMES = Object.freeze({
  transparent: '#00000000',
  none: '#00000000',
  clear: '#00000000',
  white: '#ffffff',
  black: '#000000',
  gray: '#808080',
  grey: '#808080',
  silver: '#c0c0c0',
  red: '#ff0000',
  green: '#008000',
  lime: '#00ff00',
  blue: '#0000ff',
  navy: '#000080',
  yellow: '#ffff00',
  cyan: '#00ffff',
  aqua: '#00ffff',
  magenta: '#ff00ff',
  fuchsia: '#ff00ff',
  orange: '#ff8000',
  purple: '#800080',
  brown: '#8b4513',
  pink: '#ff80c0',
  teal: '#008080',
  gold: '#ffd700',
  skin: '#ffcc99',
  dark: '#333333',
  light: '#eeeeee',
});

/** @param {number} v */
const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

/**
 * 把 #rgb / #rrggbb / #rrggbbaa 解析为 RGBA
 * @param {string} hex
 * @returns {RGBA|null}
 */
export function hexToRgba(hex) {
  if (typeof hex !== 'string') return null;
  let h = hex.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]+$/.test(h)) return null;
  if (h.length === 3) h = h.replace(/./g, (c) => c + c);
  if (h.length === 4) h = h.replace(/./g, (c) => c + c);
  if (h.length === 6) h += 'ff';
  if (h.length !== 8) return null;
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
    a: parseInt(h.slice(6, 8), 16),
  };
}

/** @param {number} v */
const h2 = (v) => clamp255(v).toString(16).padStart(2, '0');

/**
 * @param {RGBA} c
 * @param {boolean} [withAlpha]
 */
export function rgbaToHex(c, withAlpha = false) {
  const base = `#${h2(c.r)}${h2(c.g)}${h2(c.b)}`;
  return withAlpha ? base + h2(c.a) : base;
}

/**
 * 打包为小端 0xAABBGGRR
 * @param {RGBA} c
 */
export function pack(c) {
  return ((c.a << 24) | (c.b << 16) | (c.g << 8) | c.r) >>> 0;
}

/**
 * @param {number} u
 * @returns {RGBA}
 */
export function unpack(u) {
  return { r: u & 0xff, g: (u >>> 8) & 0xff, b: (u >>> 16) & 0xff, a: (u >>> 24) & 0xff };
}

/**
 * @param {RGBA} a
 * @param {RGBA} b
 */
export function sameColor(a, b) {
  return a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;
}

/**
 * 源覆盖目标：out = src over dst（非预乘）
 * 结果完全透明时归一化为 (0,0,0,0)，避免"透明的红"污染像素比较。
 * @param {RGBA} dst
 * @param {RGBA} src
 * @returns {RGBA}
 */
export function over(dst, src) {
  if (src.a === 0) return dst.a === 0 ? { ...TRANSPARENT } : { ...dst };
  if (src.a === 255) return { ...src };
  if (dst.a === 0) return { ...src };
  const sa = src.a / 255;
  const da = dst.a / 255;
  const oa = sa + da * (1 - sa);
  if (oa === 0) return { ...TRANSPARENT };
  const mix = (s, d) => (s * sa + d * da * (1 - sa)) / oa;
  return {
    r: clamp255(Math.round(mix(src.r, dst.r))),
    g: clamp255(Math.round(mix(src.g, dst.g))),
    b: clamp255(Math.round(mix(src.b, dst.b))),
    a: clamp255(Math.round(oa * 255)),
  };
}

/** @param {RGBA} c */
export function luminance(c) {
  return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
}

/**
 * 提亮 / 压暗
 * @param {RGBA} c
 * @param {'light'|'dark'} mode
 * @param {number} amount 0..1
 * @returns {RGBA}
 */
export function adjust(c, mode, amount) {
  const t = Math.max(0, Math.min(1, amount));
  const f = (v) => (mode === 'light' ? v + (255 - v) * t : v * (1 - t));
  return { r: clamp255(Math.round(f(c.r))), g: clamp255(Math.round(f(c.g))), b: clamp255(Math.round(f(c.b))), a: c.a };
}

/**
 * 解析颜色记号，支持：c0..cN / #hex / 调色板名 / 通用名
 * @param {string} token
 * @param {{ colors: RGBA[], names: Record<string, number>, pick(spec:string): RGBA|null }} palette
 * @returns {RGBA|null}
 */
export function parseColor(token, palette) {
  if (token == null) return null;
  const raw = String(token).trim();
  if (!raw) return null;

  const lower = raw.toLowerCase();
  const idx = lower.match(/^c:?(\d{1,3})$/);
  if (idx) {
    const i = Number(idx[1]);
    return palette && i >= 0 && i < palette.colors.length ? palette.colors[i] : null;
  }

  if (raw.startsWith('#')) return hexToRgba(raw);

  if (palette && palette.names && Object.prototype.hasOwnProperty.call(palette.names, lower)) {
    return palette.colors[palette.names[lower]];
  }
  if (Object.prototype.hasOwnProperty.call(UNIVERSAL_NAMES, lower)) {
    return hexToRgba(UNIVERSAL_NAMES[lower]);
  }
  return null;
}

/** @param {RGBA} c @param {number} k */
export function scaleAlpha(c, k) {
  return { ...c, a: clamp255(Math.round(c.a * k)) };
}
