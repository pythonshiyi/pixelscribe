/**
 * 视口渲染器
 * ---------------------------------------------------------------
 * 负责把文档合成结果画到屏幕 canvas 上（最近邻放大），
 * 并叠加棋盘透明底、网格、对称轴、选区、光标高亮等辅助层。
 * 同时提供导出（PNG / dataURL）。
 */

import { encodePNG, encodePNGScaled, toBase64 } from '../io/png.js';
import { controlMaps as buildControlMaps, controlMapDataURL, bufferDataURL } from './backends.js';
import { supersample } from './supersample.js';
import { bakeAnnotations, drawAnnotations, normalizeMarks } from './annotations.js';

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
    /** 画布标注（Point & Talk） */
    this.annotations = [];
    /** 正在拖拽的标注预览矩形 */
    this.annotPreview = null;
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

    // composite() 在未 invalidate 时返回同一对象 → 复用其 ImageData，避免每帧全量拷贝。
    const composite = doc.composite();
    if (this._compositeRef !== composite || !this._compositeImage) {
      this._compositeImage = composite.toImageData();
      this._compositeRef = composite;
    }
    if (this._compositeImage) this.offCtx.putImageData(this._compositeImage, 0, 0);

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
      // 只绘制视口内的网格线，避免大画布下列数爆炸
      ctx.lineWidth = 1;
      const gx0 = Math.max(0, Math.floor((0 - ox) / this.scale));
      const gx1 = Math.min(doc.width, Math.ceil((canvas.width - ox) / this.scale));
      const gy0 = Math.max(0, Math.floor((0 - oy) / this.scale));
      const gy1 = Math.min(doc.height, Math.ceil((canvas.height - oy) / this.scale));
      // 批量描边：普通线与 8 的倍数强线各一次 stroke，避免大画布数百次状态切换。
      const strokeGrid = (strong) => {
        ctx.strokeStyle = strong ? T.gridStrong : T.grid;
        ctx.beginPath();
        for (let x = gx0; x <= gx1; x++) {
          if ((x % 8 === 0) !== strong) continue;
          const px = ox + x * this.scale + 0.5;
          ctx.moveTo(px, oy);
          ctx.lineTo(px, oy + h);
        }
        for (let y = gy0; y <= gy1; y++) {
          if ((y % 8 === 0) !== strong) continue;
          const py = oy + y * this.scale + 0.5;
          ctx.moveTo(ox, py);
          ctx.lineTo(ox + w, py);
        }
        ctx.stroke();
      };
      strokeGrid(false);
      strokeGrid(true);
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

    // 画布标注：与选区区分色（品红），带编号
    if (this.annotations?.length) {
      drawAnnotations(ctx, this.annotations, { ox, oy, scale: this.scale });
    }
    if (this.annotPreview) {
      drawAnnotations(ctx, [this.annotPreview], { ox, oy, scale: this.scale });
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
    return this.exportBufferDataURL(this.doc.composite(), longEdge, withBackground);
  }

  /**
   * 编码任意缓冲为 PNG dataURL（供导出 / 带标注的视觉回灌复用）。
   * @param {import('./buffer.js').PixelBuffer} buffer
   * @param {number} longEdge
   * @param {boolean} [withBackground]
   */
  exportBufferDataURL(buffer, longEdge = 512, withBackground = false) {
    const { width, height, data: px } = buffer;
    const maxEdge = Math.max(width, height);
    // 需要缩小（如视觉回灌长边 384 < 画布）时用小数比例，避免 Math.max(1,·) 导致不缩小。
    const scale = maxEdge > longEdge
      ? longEdge / maxEdge
      : Math.max(1, Math.round(longEdge / maxEdge));
    const ow = Math.max(1, Math.round(width * scale));
    const oh = Math.max(1, Math.round(height * scale));
    let png;
    if (withBackground) {
      const flat = new Uint8ClampedArray(ow * oh * 4);
      for (let y = 0; y < oh; y++) {
        const sy = Math.min(height - 1, Math.floor(y / scale));
        for (let x = 0; x < ow; x++) {
          const sx = Math.min(width - 1, Math.floor(x / scale));
          const si = (sy * width + sx) * 4;
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
      png = encodePNGScaled(px, width, height, ow, oh);
    }
    return { dataURL: `data:image/png;base64,${toBase64(png)}`, width: ow, height: oh, scale };
  }

  /** 把透明区域垫成白底 @returns {Uint8ClampedArray} */
  _flatten(data, w, h) {
    const flat = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const a = data[i * 4 + 3] / 255;
      flat[i * 4] = Math.round(data[i * 4] * a + 255 * (1 - a));
      flat[i * 4 + 1] = Math.round(data[i * 4 + 1] * a + 255 * (1 - a));
      flat[i * 4 + 2] = Math.round(data[i * 4 + 2] * a + 255 * (1 - a));
      flat[i * 4 + 3] = 255;
    }
    return flat;
  }

  /**
   * 平滑超分导出（写实/绘画风）：双线性 + 锐化 + 微纹理，避免最近邻的硬块。
   * @param {number} longEdge @param {boolean} [withBackground]
   */
  exportSmooth(longEdge = 512, withBackground = false) {
    const doc = this.doc;
    const scale = Math.max(1, longEdge / Math.max(doc.width, doc.height));
    const up = supersample(doc.composite(), scale, { sharpen: 0.5, grain: 0.03, seed: doc.seed || 1 });
    const raw = withBackground ? this._flatten(up.data, up.width, up.height) : up.data;
    const png = encodePNG(raw, up.width, up.height);
    return { dataURL: `data:image/png;base64,${toBase64(png)}`, width: up.width, height: up.height, scale };
  }

  /**
   * 供视觉回灌使用：缩放/放大到长边 longEdge，不垫底色（保留透明）。
   * 若传标注，则把标注烘焙进副本图，让模型"看见"用户指的区域。
   * @param {number} [longEdge]
   * @param {Array<{x:number,y:number,w:number,h:number}>|null} [annotations]
   */
  visionDataURL(longEdge = 384, annotations = null) {
    if (annotations?.length) {
      const copy = this.doc.composite().clone();
      bakeAnnotations(copy, normalizeMarks(annotations, copy.width, copy.height));
      return this.exportBufferDataURL(copy, longEdge, false).dataURL;
    }
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
