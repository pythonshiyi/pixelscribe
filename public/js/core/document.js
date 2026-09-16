/**
 * 文档模型：尺寸 + 调色板 + 图层 + 对称 + 合成
 */

import { PixelBuffer } from './buffer.js';
import { Palette } from './palette.js';
import { pack, unpack, scaleAlpha, over } from '../util/color.js';

/** @typedef {import('../util/color.js').RGBA} RGBA */

let layerSeq = 0;

export class Layer {
  /**
   * @param {number} width @param {number} height @param {string} [name]
   */
  constructor(width, height, name = `图层 ${++layerSeq}`) {
    this.id = `L${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this.name = name;
    this.buffer = new PixelBuffer(width, height);
    this.visible = true;
    this.opacity = 1;
    this.locked = false;
  }

  clone() {
    const l = Object.create(Layer.prototype);
    l.id = this.id;
    l.name = this.name;
    l.buffer = this.buffer.clone();
    l.visible = this.visible;
    l.opacity = this.opacity;
    l.locked = this.locked;
    return l;
  }
}

export class PixelDocument {
  /** @param {number} [width] @param {number} [height] */
  constructor(width = 32, height = 32) {
    this.width = width;
    this.height = height;
    this.palette = Palette.from('pico8');
    this.layers = [new Layer(width, height, '背景')];
    this.activeLayerIndex = 0;
    this.symmetry = 'off';
    this.seed = null;
    this.title = '未命名';
    this._composite = null;
  }

  get activeLayer() { return this.layers[this.activeLayerIndex]; }

  /** 尺寸变更：重建所有图层并尽力保留内容 */
  resize(width, height) {
    if (width === this.width && height === this.height) return;
    for (const layer of this.layers) {
      const nb = new PixelBuffer(width, height);
      const cw = Math.min(width, this.width), ch = Math.min(height, this.height);
      for (let y = 0; y < ch; y++) {
        for (let x = 0; x < cw; x++) nb.setPacked(x, y, layer.buffer.getPacked(x, y));
      }
      layer.buffer = nb;
    }
    this.width = width;
    this.height = height;
    this.invalidate();
  }

  invalidate() { this._composite = null; }

  /** @returns {PixelBuffer} */
  composite() {
    if (this._composite) return this._composite;
    const out = new PixelBuffer(this.width, this.height);
    for (const layer of this.layers) {
      if (!layer.visible || layer.opacity <= 0) continue;
      const b = layer.buffer;
      const op = layer.opacity;
      if (op >= 1) {
        for (let i = 0; i < out.u32.length; i++) {
          const s = b.u32[i];
          if ((s >>> 24) === 0) continue;
          if ((s >>> 24) === 255) { out.u32[i] = s; continue; }
          out.u32[i] = pack(over(unpack(out.u32[i]), unpack(s)));
        }
      } else {
        for (let i = 0; i < out.u32.length; i++) {
          const s = b.u32[i];
          if ((s >>> 24) === 0) continue;
          out.u32[i] = pack(over(unpack(out.u32[i]), scaleAlpha(unpack(s), op)));
        }
      }
    }
    this._composite = out;
    return out;
  }

  /** @param {string} name @returns {Layer} */
  addLayer(name) {
    const l = new Layer(this.width, this.height, name);
    this.layers.splice(this.activeLayerIndex + 1, 0, l);
    this.activeLayerIndex++;
    this.invalidate();
    return l;
  }

  /** @param {number} [index] */
  removeLayer(index = this.activeLayerIndex) {
    if (this.layers.length <= 1) return false;
    this.layers.splice(index, 1);
    this.activeLayerIndex = Math.min(this.activeLayerIndex, this.layers.length - 1);
    this.invalidate();
    return true;
  }

  /** @param {number} from @param {number} to */
  moveLayer(from, to) {
    if (to < 0 || to >= this.layers.length) return false;
    const [l] = this.layers.splice(from, 1);
    this.layers.splice(to, 0, l);
    this.activeLayerIndex = to;
    this.invalidate();
    return true;
  }

  mergeDown() {
    const i = this.activeLayerIndex;
    if (i <= 0) return false;
    const top = this.layers[i], bottom = this.layers[i - 1];
    for (let k = 0; k < bottom.buffer.u32.length; k++) {
      const s = top.buffer.u32[k];
      if ((s >>> 24) === 0 || !top.visible) continue;
      const src = top.opacity >= 1 ? unpack(s) : scaleAlpha(unpack(s), top.opacity);
      bottom.buffer.u32[k] = pack(over(unpack(bottom.buffer.u32[k]), src));
    }
    this.layers.splice(i, 1);
    this.activeLayerIndex = i - 1;
    this.invalidate();
    return true;
  }

  /** 当前图层快照（用于历史） */
  snapshot() {
    return this.layers.map((l) => ({ id: l.id, data: l.buffer.snapshot() }));
  }

  /** @param {ReturnType<PixelDocument['snapshot']>} snap */
  restore(snap) {
    for (const s of snap) {
      const l = this.layers.find((x) => x.id === s.id);
      if (l) l.buffer.restore(s.data);
    }
    this.invalidate();
  }

  /** 序列化为可 JSON 化的对象 */
  toJSON() {
    const bytesToHex = (arr) => {
      let s = '';
      for (let i = 0; i < arr.length; i++) s += arr[i].toString(16).padStart(2, '0');
      return s;
    };
    return {
      version: 1,
      width: this.width,
      height: this.height,
      title: this.title,
      symmetry: this.symmetry,
      seed: this.seed,
      palette: this.palette.toJSON(),
      layers: this.layers.map((l) => ({
        name: l.name,
        visible: l.visible,
        opacity: l.opacity,
        data: bytesToHex(l.buffer.data),
      })),
    };
  }

  /** @param {any} json */
  static fromJSON(json) {
    const doc = new PixelDocument(json.width, json.height);
    doc.title = json.title ?? '未命名';
    doc.symmetry = json.symmetry ?? 'off';
    doc.seed = json.seed ?? null;
    doc.palette = Palette.from(json.palette?.hex ?? 'pico8');
    doc.layers = (json.layers ?? []).map((lj) => {
      const l = new Layer(json.width, json.height, lj.name);
      l.visible = lj.visible !== false;
      l.opacity = lj.opacity ?? 1;
      const hex = lj.data ?? '';
      for (let i = 0; i < l.buffer.data.length && i * 2 < hex.length; i++) {
        l.buffer.data[i] = parseInt(hex.substr(i * 2, 2), 16);
      }
      return l;
    });
    if (!doc.layers.length) doc.layers = [new Layer(json.width, json.height, '背景')];
    doc.activeLayerIndex = doc.layers.length - 1;
    return doc;
  }
}
