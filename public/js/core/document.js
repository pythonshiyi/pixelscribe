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
    /**
     * 'raster' 普通绘制层；'neural' 神经/程序化渲染层（作为高熵残差叠加在程序层之上）。
     * @type {'raster'|'neural'}
     */
    this.kind = 'raster';
    /** @type {null|{backend?:string, prompt?:string, strength?:number, style?:string, seed?:number}} */
    this.meta = null;
    /** 所属图层组 id（null 表示顶层）v2.1 */
    this.group = null;
  }

  clone() {
    const l = Object.create(Layer.prototype);
    l.id = this.id;
    l.name = this.name;
    l.buffer = this.buffer.clone();
    l.visible = this.visible;
    l.opacity = this.opacity;
    l.locked = this.locked;
    l.kind = this.kind;
    l.meta = this.meta ? { ...this.meta } : null;
    l.group = this.group;
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
    /** 作品风格：pixel / painting / ink / anime / 3d / photo —— 决定渲染后端 */
    this.style = 'pixel';
    /** 方向光声明列表（由 DSL 的 light 指令追加） */
    this.lights = [];
    /** 最近一次 DSL render 请求的风格（供闭环选择后端） */
    this.renderRequested = null;
    /** 本轮的局部重绘请求（由 DSL inpaint 追加，Agent 消费后清空） */
    this.inpaintRequests = [];
    /** 图层组（扁平分组元数据）：{id,name,collapsed} v2.1 */
    this.groups = [];
    this._composite = null;
    this._compositeBase = null;
  }

  /* ── 图层组（v2.1） ── */

  /** 新建图层组 @returns {{id:string,name:string,collapsed:boolean}} */
  addGroup(name = '图层组') {
    const g = { id: `G${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name, collapsed: false };
    this.groups.push(g);
    return g;
  }

  /** 把若干图层归入一个新组；返回该组。 */
  groupLayers(layerIds, name) {
    const ids = new Set(layerIds || []);
    if (!ids.size) return null;
    const g = this.addGroup(name || `图层组 ${this.groups.length + 1}`);
    for (const l of this.layers) if (ids.has(l.id)) l.group = g.id;
    return g;
  }

  /** 解散组并移除组记录。 */
  removeGroup(id) {
    this.groups = this.groups.filter((g) => g.id !== id);
    for (const l of this.layers) if (l.group === id) l.group = null;
  }

  /** 组内图层（按绘制顺序）。 */
  layersInGroup(id) { return this.layers.filter((l) => l.group === id); }

  getGroup(id) { return this.groups.find((g) => g.id === id) || null; }

  /** 组的有效可见性（组内任一图层可见）。 */
  groupVisible(id) { return this.layersInGroup(id).some((l) => l.visible); }

  get activeLayer() { return this.layers[this.activeLayerIndex]; }

  /** 找到（或按需创建）神经/渲染残差层 —— 始终位于最上层。 */
  ensureNeuralLayer(name = '渲染层') {
    let l = this.layers.find((x) => x.kind === 'neural');
    if (!l) {
      l = new Layer(this.width, this.height, name);
      l.kind = 'neural';
      this.layers.push(l);
      this.invalidate();
    }
    return l;
  }

  get neuralLayer() { return this.layers.find((x) => x.kind === 'neural') || null; }

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

  invalidate() { this._composite = null; this._compositeBase = null; }

  /**
   * 底层合成。
   * @param {Set<string>|null} skipKinds 跳过的图层类型（如神经残差层 / 参考图）
   * @returns {PixelBuffer}
   */
  _compose(skipKinds) {
    const out = new PixelBuffer(this.width, this.height);
    for (const layer of this.layers) {
      if (skipKinds && skipKinds.has(layer.kind)) continue;
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
    return out;
  }

  /** @returns {PixelBuffer} */
  composite() {
    if (!this._composite) this._composite = this._compose(null);
    return this._composite;
  }

  /**
   * 仅绘制/程序层——不含神经残差层，也不含参考图（参考图仅作神经引导，不参与成图）。
   * 供渲染管线作底图。
   */
  compositeBase() {
    if (!this._compositeBase) this._compositeBase = this._compose(new Set(['neural', 'reference']));
    return this._compositeBase;
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
      style: this.style,
      lights: this.lights,
      groups: this.groups.map((g) => ({ id: g.id, name: g.name, collapsed: Boolean(g.collapsed) })),
      palette: this.palette.toJSON(),
      layers: this.layers.map((l) => ({
        name: l.name,
        visible: l.visible,
        opacity: l.opacity,
        kind: l.kind,
        meta: l.meta,
        group: l.group || null,
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
    doc.style = json.style ?? 'pixel';
    doc.lights = Array.isArray(json.lights) ? json.lights : [];
    doc.groups = Array.isArray(json.groups)
      ? json.groups.map((g) => ({ id: g.id, name: g.name || '图层组', collapsed: Boolean(g.collapsed) }))
      : [];
    doc.palette = Palette.from(json.palette?.hex ?? 'pico8');
    doc.layers = (json.layers ?? []).map((lj) => {
      const l = new Layer(json.width, json.height, lj.name);
      l.visible = lj.visible !== false;
      l.opacity = lj.opacity ?? 1;
      if (lj.kind === 'neural') l.kind = 'neural';
      if (lj.meta) l.meta = lj.meta;
      if (lj.group) l.group = lj.group;
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
