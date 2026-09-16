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
}

export const DEFAULT_PALETTE = () => Palette.from('pico8');
