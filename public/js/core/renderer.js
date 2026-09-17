/**
 * 视口渲染器
 * ---------------------------------------------------------------
 * 负责把文档合成结果画到屏幕 canvas 上（最近邻放大），
 * 并叠加棋盘透明底、网格、对称轴、选区、光标高亮等辅助层。
 * 同时提供导出（PNG / dataURL）。
 */

import { encodePNG, encodePNGScaled, toBase64 } from '../io/png.js';
import { controlMaps as buildControlMaps, controlMapDataURL, bufferDataURL } from './backends.js';

/** 与 UI 主题配套的画布配色（棋盘底 / 网格 / 边框 / 对称轴）。 */
const THEMES = {
  dark: {
    checkerLight: '#3a3a44',
    checkerDark: '#2b2b33',
    grid: 'rgba(255,255,255,0.10)',
    gridStrong: 'rgba(255,255,255,0.22)',
    border: 'rgba(255,255,255,0.35)',
    sym: 'rgba(255,120,200,0.85)',
  },
  light: {
    checkerLight: '#eceee6',
    checkerDark: '#dfe2d6',
    grid: 'rgba(31,35,40,0.10)',
    gridStrong: 'rgba(31,35,40,0.22)',
    border: 'rgba(31,35,40,0.28)',
    sym: 'rgba(214,71,138,0.85)',
  },
};

export class Renderer {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.ctx.imageSmoothingEnabled = false;

    this.offscreen = document.createElement('canvas');
    this.offCtx = this.offscreen.getContext('2d');

    /** @type {import('./document.js').PixelDocument|null} */
    this.doc = null;
    this.scale = 12;
    this.offsetX = 0;
    this.offsetY = 0;
    this.grid = true;
    this.showSymmetry = true;
    /** @type {import('./buffer.js').PixelBuffer|null} 预览覆盖层 */
    this.overlay = null;
    /** @type {{prev:import('./buffer.js').PixelBuffer|null, next:import('./buffer.js').PixelBuffer|null}|null} 洋葱皮 */
    this.onion = null;
    this._onionCanvas = document.createElement('canvas');
    /** @type {{x:number,y:number,w:number,h:number}|null} */
    this.selection = null;
    /** @type {{x:number,y:number}|null} */
    this.hover = null;
    this.checkerSize = 6;
    this._checkerPattern = null;
    this._overlayCanvas = document.createElement('canvas');
    this.theme = 'dark';
  }

  /** 切换画布配色主题（dark / light）。 */
  setTheme(name) {
    const next = name === 'light' ? 'light' : 'dark';
    if (next === this.theme) return;
    this.theme = next;
    this._checkerPattern = null;
  }

  get colors() { return THEMES[this.theme] || THEMES.dark; }

  setDocument(doc) {
    this.doc = doc;
    this.resizeOffscreen();
  }

  resizeOffscreen() {
    if (!this.doc) return;
    if (this.offscreen.width !== this.doc.width || this.offscreen.height !== this.doc.height) {
      this.offscreen.width = this.doc.width;
      this.offscreen.height = this.doc.height;
      this.offCtx.imageSmoothingEnabled = false;
    }
  }

  /* ── 坐标换算 ── */

  /** @param {number} clientX @param {number} clientY @returns {{x:number,y:number}} */
  screenToPixel(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    const sx = (clientX - r.left) * (this.canvas.width / r.width);
    const sy = (clientY - r.top) * (this.canvas.height / r.height);
    return {
      x: Math.floor((sx - this.offsetX) / this.scale),
      y: Math.floor((sy - this.offsetY) / this.scale),
    };
  }

  /** @param {number} x @param {number} y */
  pixelToScreen(x, y) {
    const r = this.canvas.getBoundingClientRect();
    const k = r.width / this.canvas.width;
    return {
      x: (this.offsetX + x * this.scale) * k,
      y: (this.offsetY + y * this.scale) * k,
    };
  }

  /** 以视口某点为锚点缩放 @param {number} factor @param {number} [cx] @param {number} [cy] */
  zoomAt(factor, cx, cy) {
    const next = Math.max(1, Math.min(64, this.scale * factor));
    const k = next / this.scale;
    const px = cx ?? this.canvas.width / 2;
    const py = cy ?? this.canvas.height / 2;
    this.offsetX = px - (px - this.offsetX) * k;
    this.offsetY = py - (py - this.offsetY) * k;
    this.scale = next;
  }

  setZoom(scale, cx, cy) {
    this.zoomAt(scale / this.scale, cx, cy);
  }

  fit(padding = 24) {
    if (!this.doc) return;
    const cw = this.canvas.width, ch = this.canvas.height;
    const s = Math.max(1, Math.min(
      Math.floor((cw - padding * 2) / this.doc.width),
      Math.floor((ch - padding * 2) / this.doc.height),
    ));
    this.scale = Math.min(48, s);
    this.offsetX = Math.round((cw - this.doc.width * this.scale) / 2);
    this.offsetY = Math.round((ch - this.doc.height * this.scale) / 2);
  }

  center() {
    if (!this.doc) return;
    this.offsetX = Math.round((this.canvas.width - this.doc.width * this.scale) / 2);
    this.offsetY = Math.round((this.canvas.height - this.doc.height * this.scale) / 2);
  }

  _makeChecker() {
    const T = this.colors;
    const c = document.createElement('canvas');
    c.width = this.checkerSize * 2;
    c.height = this.checkerSize * 2;
    const g = c.getContext('2d');
    g.fillStyle = T.checkerLight;
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = T.checkerDark;
    g.fillRect(0, 0, this.checkerSize, this.checkerSize);
    g.fillRect(this.checkerSize, this.checkerSize, this.checkerSize, this.checkerSize);
    return this.ctx.createPattern(c, 'repeat');
  }

  /* ── 渲染 ── */

  render() {
    const { ctx, canvas } = this;
    const doc = this.doc;
    const T = this.colors;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!doc) return;
    this.resizeOffscreen();

    const w = doc.width * this.scale;
    const h = doc.height * this.scale;
    const ox = Math.round(this.offsetX);
    const oy = Math.round(this.offsetY);

    const composite = doc.composite();
    this.offCtx.putImageData(composite.toImageData(), 0, 0);

    if (!this._checkerPattern) this._checkerPattern = this._makeChecker();
    ctx.save();
    ctx.beginPath();
    ctx.rect(ox, oy, w, h);
    ctx.clip();

    ctx.fillStyle = this._checkerPattern;
    ctx.fillRect(ox, oy, w, h);

    ctx.drawImage(this.offscreen, ox, oy, w, h);

    if (this.overlay) {
      const oc = this._overlayCanvas;
      if (oc.width !== doc.width || oc.height !== doc.height) {
        oc.width = doc.width;
        oc.height = doc.height;
      }
      const octx = oc.getContext('2d');
      octx.clearRect(0, 0, oc.width, oc.height);
      octx.putImageData(this.overlay.toImageData(), 0, 0);
      ctx.globalAlpha = 0.9;
      ctx.drawImage(oc, ox, oy, w, h);
      ctx.globalAlpha = 1;
    }

    if (this.onion && (this.onion.prev || this.onion.next)) {
      const oc = this._onionCanvas;
      if (oc.width !== doc.width || oc.height !== doc.height) { oc.width = doc.width; oc.height = doc.height; }
      const octx = oc.getContext('2d');
      ctx.globalAlpha = 0.5;
      for (const buf of [this.onion.prev, this.onion.next]) {
        if (!buf) continue;
        octx.clearRect(0, 0, oc.width, oc.height);
        octx.putImageData(buf.toImageData(), 0, 0);
        ctx.drawImage(oc, ox, oy, w, h);
      }
      ctx.globalAlpha = 1;
    }

    if (this.grid && this.scale >= 5) {
      ctx.lineWidth = 1;
      for (let x = 0; x <= doc.width; x++) {
        ctx.strokeStyle = x % 8 === 0 ? T.gridStrong : T.grid;
        const px = ox + x * this.scale + 0.5;
        ctx.beginPath();
        ctx.moveTo(px, oy);
        ctx.lineTo(px, oy + h);
        ctx.stroke();
      }
      for (let y = 0; y <= doc.height; y++) {
        ctx.strokeStyle = y % 8 === 0 ? T.gridStrong : T.grid;
        const py = oy + y * this.scale + 0.5;
        ctx.beginPath();
        ctx.moveTo(ox, py);
        ctx.lineTo(ox + w, py);
        ctx.stroke();
      }
    }

    ctx.restore();

    ctx.strokeStyle = T.border;
    ctx.lineWidth = 1;
    ctx.strokeRect(ox + 0.5, oy + 0.5, w - 1, h - 1);

    if (this.showSymmetry && doc.symmetry !== 'off') {
      ctx.save();
      ctx.strokeStyle = T.sym;
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 1;
      const mid = (n) => ox + ((n - 1) / 2) * this.scale + this.scale / 2 + 0.5;
      if (doc.symmetry === 'x' || doc.symmetry === 'xy') {
        ctx.beginPath();
        ctx.moveTo(mid(doc.width), oy);
        ctx.lineTo(mid(doc.width), oy + h);
        ctx.stroke();
      }
      if (doc.symmetry === 'y' || doc.symmetry === 'xy') {
        ctx.beginPath();
        ctx.moveTo(ox, mid(doc.height));
        ctx.lineTo(ox + w, mid(doc.height));
        ctx.stroke();
      }
      ctx.restore();
    }

    if (this.selection) {
      const { x, y, w: sw, h: sh } = this.selection;
      ctx.save();
      ctx.strokeStyle = '#54d1ff';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 3]);
      ctx.strokeRect(ox + x * this.scale + 0.5, oy + y * this.scale + 0.5, sw * this.scale, sh * this.scale);
      ctx.restore();
    }

    if (this.hover && this.hover.x >= 0 && this.hover.y >= 0 &&
        this.hover.x < doc.width && this.hover.y < doc.height) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 2;
      ctx.strokeRect(ox + this.hover.x * this.scale + 1, oy + this.hover.y * this.scale + 1, this.scale - 2, this.scale - 2);
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.lineWidth = 1;
      ctx.strokeRect(ox + this.hover.x * this.scale + 0.5, oy + this.hover.y * this.scale + 0.5, this.scale - 1, this.scale - 1);
      ctx.restore();
    }
  }

  /* ── 导出 ── */

  /**
   * @param {number} longEdge
   * @param {boolean} [withBackground] 是否垫白底
   * @returns {{dataURL:string,width:number,height:number,scale:number}}
   */
  export(longEdge = 512, withBackground = false) {
    const doc = this.doc;
    const scale = Math.max(1, Math.round(longEdge / Math.max(doc.width, doc.height)));
    const ow = doc.width * scale, oh = doc.height * scale;
    const px = doc.composite().data;
    let png;
    if (withBackground) {
      const flat = new Uint8ClampedArray(ow * oh * 4);
      for (let y = 0; y < oh; y++) {
        for (let x = 0; x < ow; x++) {
          const si = (Math.floor(y / scale) * doc.width + Math.floor(x / scale)) * 4;
          const di = (y * ow + x) * 4;
          const a = px[si + 3] / 255;
          flat[di] = Math.round(px[si] * a + 255 * (1 - a));
          flat[di + 1] = Math.round(px[si + 1] * a + 255 * (1 - a));
          flat[di + 2] = Math.round(px[si + 2] * a + 255 * (1 - a));
          flat[di + 3] = 255;
        }
      }
      png = encodePNG(flat, ow, oh);
    } else {
      png = encodePNGScaled(px, doc.width, doc.height, ow, oh);
    }
    return { dataURL: `data:image/png;base64,${toBase64(png)}`, width: ow, height: oh, scale };
  }

  /** 供视觉回灌使用：放大到长边 longEdge，不垫底色（保留透明） */
  visionDataURL(longEdge = 384) {
    return this.export(longEdge, false).dataURL;
  }

  /**
   * 合成结果的原生尺寸 PNG（供神经后端作 img2img 底图）。
   * @param {number} [longEdge] 0 表示不放大
   */
  bufferDataURL(longEdge = 0) {
    return bufferDataURL(this.doc.composite(), longEdge);
  }

  /**
   * 导出控制图（边缘 / 深度 / 法线 / 遮罩）——神经后端的条件输入。
   * @param {'edges'|'depth'|'normal'|'alpha'} [kind]
   */
  controlMap(kind = 'edges', longEdge = 512) {
    return controlMapDataURL(this.doc.composite(), kind, longEdge);
  }

  /** 一次性导出全部控制图。 */
  controlMaps(longEdge = 512) {
    return buildControlMaps(this.doc.composite(), longEdge);
  }

  download(filename, longEdge = 512, withBackground = false) {
    const { dataURL } = this.export(longEdge, withBackground);
    const a = document.createElement('a');
    a.href = dataURL;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
}
