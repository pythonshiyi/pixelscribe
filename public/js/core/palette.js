/**
 * 调色板
 * ---------------------------------------------------------------
 * 调色板 = 颜色数组 + 名称→索引映射。
 * 名称映射既包含预设语义名（black/darkblue/...），也包含通用色名。
 */

import { hexToRgba, UNIVERSAL_NAMES, parseColor } from '../util/color.js';

/** @typedef {import('../util/color.js').RGBA} RGBA */

const hexes = (list) => list.map((h) => hexToRgba(h));

function makeNames(names, colors) {
  /** @type {Record<string, number>} */
  const map = {};
  if (names) names.forEach((n, i) => { map[n] = i; });
  Object.keys(UNIVERSAL_NAMES).forEach((n) => {
    if (!(n in map)) {
      const r = hexToRgba(UNIVERSAL_NAMES[n]);
      const found = colors.findIndex(
        (c) => c.r === r.r && c.g === r.g && c.b === r.b && c.a === r.a,
      );
      if (found >= 0) map[n] = found;
    }
  });
  return map;
}

export const PRESETS = {
  pico8: {
    label: 'PICO-8',
    hex: ['#000000', '#1d2b53', '#7e2553', '#008751', '#ab5236', '#5f574f', '#c2c3c7', '#fff1e8',
          '#ff004d', '#ffa300', '#ffec27', '#00e436', '#29adff', '#83769c', '#ff77a8', '#ffccaa'],
    names: ['black', 'darkblue', 'darkpurple', 'darkgreen', 'brown', 'darkgray', 'lightgray', 'white',
            'red', 'orange', 'yellow', 'green', 'blue', 'lavender', 'pink', 'peach'],
  },
  gameboy: {
    label: 'Game Boy',
    hex: ['#0f380f', '#306230', '#8bac0f', '#9bbc0f'],
    names: ['gb-darkest', 'gb-dark', 'gb-light', 'gb-lightest'],
  },
  cga: {
    label: 'CGA / DOS',
    hex: ['#000000', '#0000aa', '#00aa00', '#00aaaa', '#aa0000', '#aa00aa', '#aa5500', '#aaaaaa',
          '#555555', '#5555ff', '#55ff55', '#55ffff', '#ff5555', '#ff55ff', '#ffff55', '#ffffff'],
    names: ['black', 'navy', 'green', 'teal', 'maroon', 'purple', 'olive', 'silver',
            'gray', 'blue', 'lime', 'cyan', 'red', 'magenta', 'yellow', 'white'],
  },
  gray: {
    label: 'Grayscale 8',
    hex: ['#000000', '#242424', '#484848', '#6d6d6d', '#919191', '#b6b6b6', '#dadada', '#ffffff'],
    names: ['black', 'gray1', 'gray2', 'gray3', 'gray4', 'gray5', 'gray6', 'white'],
  },
  bw: {
    label: 'Black & White',
    hex: ['#000000', '#ffffff'],
    names: ['black', 'white'],
  },
};

export class Palette {
  /**
   * @param {RGBA[]} colors
   * @param {Record<string, number>} names
   * @param {string} [label]
   */
  constructor(colors, names, label = 'Custom') {
    this.colors = colors;
    this.names = names;
    this.label = label;
  }

  get size() { return this.colors.length; }

  /** @param {number} i */
  at(i) { return this.colors[((i % this.size) + this.size) % this.size]; }

  /** @param {string} spec */
  pick(spec) { return parseColor(spec, this); }

  /** @param {number} i @param {RGBA} c */
  set(i, c) {
    if (i >= 0 && i < this.colors.length) {
      this.colors[i] = c;
      return true;
    }
    return false;
  }

  /** @param {number} i */
  nameOf(i) {
    for (const [n, idx] of Object.entries(this.names)) if (idx === i) return n;
    return `c${i}`;
  }

  /** 若色板中已有该色返回索引，否则追加或返回 -1 @param {RGBA} c */
  indexOf(c, autoAdd = false) {
    const i = this.colors.findIndex((x) => x.r === c.r && x.g === c.g && x.b === c.b && x.a === c.a);
    if (i >= 0) return i;
    if (autoAdd && this.colors.length < 256) { this.colors.push(c); return this.colors.length - 1; }
    return -1;
  }

  /**
   * @param {string|string[]} spec 预设名，或十六进制数组
   * @returns {Palette}
   */
  static from(spec) {
    if (Array.isArray(spec)) {
      const colors = spec.map((h) => hexToRgba(h)).filter(Boolean);
      if (!colors.length) throw new Error('空的自定义调色板');
      return new Palette(colors, makeNames(null, colors), 'Custom');
    }
    const key = String(spec).toLowerCase();
    const preset = PRESETS[key];
    if (!preset) throw new Error(`未知调色板预设 '${spec}'`);
    const colors = hexes(preset.hex);
    return new Palette(colors, makeNames(preset.names, colors), preset.label);
  }

  /**
   * 紧凑色板速查串（供提示词）：`c0=#000000(black) c1=#1d2b53 ...`
   * @param {number} [max] 最多列出多少色（超出省略）
   */
  legend(max = 32) {
    const nameOf = {};
    for (const [n, i] of Object.entries(this.names || {})) if (nameOf[i] === undefined) nameOf[i] = n;
    const hexOf = (c) => `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    const parts = this.colors.slice(0, max).map((c, i) => (
      nameOf[i] ? `c${i}=${hexOf(c)}(${nameOf[i]})` : `c${i}=${hexOf(c)}`
    ));
    if (this.colors.length > max) parts.push('…');
    return parts.join(' ');
  }

  clone() {
    return new Palette(this.colors.map((c) => ({ ...c })), { ...this.names }, this.label);
  }

  toJSON() {
    return { label: this.label, hex: this.colors.map((c) => `#${[c.r, c.g, c.b, c.a].map((v) => v.toString(16).padStart(2, '0')).join('')}`) };
  }

  /** 从像素缓冲提取常用色（按频次降序） */
  static extract(buffer, limit = 16, includeTransparent = false) {
    const counts = new Map();
    const { data } = buffer;
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      if (a === 0 && !includeTransparent) continue;
      const key = (a << 24) | (data[i + 2] << 16) | (data[i + 1] << 8) | data[i];
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([u]) => ({
        r: u & 0xff, g: (u >>> 8) & 0xff, b: (u >>> 16) & 0xff, a: (u >>> 24) & 0xff,
      }));
  }

  /**
   * k-means 量化提取代表性配色（v2.3）。
   * 先做 RGB 直方图抽样，再用 k-means++ 初始化 + Lloyd 迭代聚类，
   * 结果按簇内像素数降序返回。确定性（固定 seed）。
   * @param {import('./buffer.js').PixelBuffer} buffer
   * @param {{k?:number, seed?:number, includeTransparent?:boolean, maxSamples?:number}} [opts]
   * @returns {RGBA[]}
   */
  static kmeans(buffer, opts = {}) {
    const k = Math.max(2, Math.min(64, Math.round(opts.k || 16)));
    const includeTransparent = opts.includeTransparent === true;
    const data = buffer.data;
    const samples = [];
    // 先统计直方图并按频次取前 maxSamples 色作为样本（加速且抑制噪声）
    const counts = new Map();
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      if (a === 0 && !includeTransparent) continue;
      const key = (a << 24) | (data[i + 2] << 16) | (data[i + 1] << 8) | data[i];
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const maxSamples = Math.max(k * 4, Math.min(4096, Math.round(opts.maxSamples || 1024)));
    const entries = [...counts.entries()].sort((x, y) => y[1] - x[1]).slice(0, maxSamples);
    for (const [u, w] of entries) {
      samples.push({
        r: u & 0xff, g: (u >>> 8) & 0xff, b: (u >>> 16) & 0xff, a: (u >>> 24) & 0xff, w,
      });
    }
    if (!samples.length) return [];
    if (samples.length <= k) return samples.map(({ r, g, b, a }) => ({ r, g, b, a }));

    const rand = mulberry32l((opts.seed ?? 1) >>> 0);
    // k-means++ 初始化
    const centers = [samples[Math.floor(rand() * samples.length)]];
    while (centers.length < k) {
      const d2 = samples.map((s) => {
        let best = Infinity;
        for (const c of centers) {
          const d = (s.r - c.r) ** 2 + (s.g - c.g) ** 2 + (s.b - c.b) ** 2;
          if (d < best) best = d;
        }
        return best * s.w;
      });
      const total = d2.reduce((a, b) => a + b, 0);
      if (total <= 0) break;
      let r = rand() * total;
      let idx = 0;
      while (idx < d2.length && (r -= d2[idx]) > 0) idx++;
      centers.push(samples[Math.min(idx, samples.length - 1)]);
    }

    // Lloyd 迭代
    const kk = centers.length;
    for (let iter = 0; iter < 12; iter++) {
      const sums = Array.from({ length: kk }, () => ({ r: 0, g: 0, b: 0, a: 0, w: 0 }));
      for (const s of samples) {
        let bi = 0, bd = Infinity;
        for (let i = 0; i < kk; i++) {
          const c = centers[i];
          const d = (s.r - c.r) ** 2 + (s.g - c.g) ** 2 + (s.b - c.b) ** 2;
          if (d < bd) { bd = d; bi = i; }
        }
        const acc = sums[bi];
        acc.r += s.r * s.w; acc.g += s.g * s.w; acc.b += s.b * s.w; acc.a += s.a * s.w; acc.w += s.w;
      }
      let moved = 0;
      for (let i = 0; i < kk; i++) {
        if (!sums[i].w) continue;
        const nr = sums[i].r / sums[i].w, ng = sums[i].g / sums[i].w, nb = sums[i].b / sums[i].w, na = sums[i].a / sums[i].w;
        moved += Math.abs(nr - centers[i].r) + Math.abs(ng - centers[i].g) + Math.abs(nb - centers[i].b);
        centers[i] = { r: Math.round(nr), g: Math.round(ng), b: Math.round(nb), a: Math.round(na) };
      }
      if (moved < 0.5) break;
    }
    // 按簇权重排序
    const weighted = centers.map((c, i) => {
      let w = 0;
      for (const s of samples) {
        let bi = 0, bd = Infinity;
        for (let j = 0; j < kk; j++) {
          const cc = centers[j];
          const d = (s.r - cc.r) ** 2 + (s.g - cc.g) ** 2 + (s.b - cc.b) ** 2;
          if (d < bd) { bd = d; bi = j; }
        }
        if (bi === i) w += s.w;
      }
      return { ...c, w };
    });
    return weighted.sort((a, b) => b.w - a.w).map(({ r, g, b, a }) => ({ r, g, b, a }));
  }
}

/** 局部 mulberry32（避免与 buffer 模块循环依赖） */
function mulberry32l(a) {
  return function next() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const DEFAULT_PALETTE = () => Palette.from('pico8');
