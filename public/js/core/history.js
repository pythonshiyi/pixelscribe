/**
 * 历史记录（撤销 / 重做）
 * ---------------------------------------------------------------
 * 采用「变更前快照 + 事务」模型：
 *   history.begin(label)  → 记录当前状态
 *   history.commit()      → 若确有变化则入栈，否则丢弃
 */

import { Layer } from './document.js';
import { Palette, PRESETS } from './palette.js';

function snapshotDoc(doc) {
  return {
    width: doc.width,
    height: doc.height,
    title: doc.title,
    symmetry: doc.symmetry,
    seed: doc.seed,
    style: doc.style,
    lights: Array.isArray(doc.lights) ? doc.lights.map((l) => ({ ...l })) : [],
    groups: Array.isArray(doc.groups) ? doc.groups.map((g) => ({ ...g })) : [],
    activeLayerIndex: doc.activeLayerIndex,
    paletteHex: doc.palette.toJSON().hex,
    paletteLabel: doc.palette.label,
    layers: doc.layers.map((l) => ({
      id: l.id,
      name: l.name,
      visible: l.visible,
      opacity: l.opacity,
      locked: l.locked,
      kind: l.kind,
      meta: l.meta ? { ...l.meta } : null,
      data: l.buffer.snapshot(),
    })),
  };
}

function restoreDoc(doc, snap) {
  doc.width = snap.width;
  doc.height = snap.height;
  doc.title = snap.title;
  doc.symmetry = snap.symmetry;
  doc.seed = snap.seed;
  doc.style = snap.style ?? 'pixel';
  doc.lights = Array.isArray(snap.lights) ? snap.lights.map((l) => ({ ...l })) : [];
  doc.groups = Array.isArray(snap.groups) ? snap.groups.map((g) => ({ ...g })) : [];
  doc.activeLayerIndex = snap.activeLayerIndex;
  doc.layers = snap.layers.map((s) => {
    const l = new Layer(snap.width, snap.height, s.name);
    l.id = s.id;
    l.visible = s.visible;
    l.opacity = s.opacity;
    l.locked = s.locked;
    l.kind = s.kind ?? 'raster';
    l.meta = s.meta ? { ...s.meta } : null;
    l.buffer.restore(s.data);
    return l;
  });
  if (snap.paletteHex) {
    // PRESETS 是 6 位 #rrggbb，快照是 8 位 #rrggbbaa——需归一化后才能匹配预设。
    const rgb = snap.paletteHex.map((h) => h.slice(0, 7)).join();
    const key = Object.keys(PRESETS).find((k) => PRESETS[k].hex.join() === rgb);
    doc.palette = key ? Palette.from(key) : Palette.from(snap.paletteHex);
  }
  doc.invalidate();
}

/** 用快照与文档的「当前实时状态」比较，避免 commit 时再复制一次全量 after。 */
function stateEqualsDoc(a, doc) {
  if (!a) return false;
  if (a.layers.length !== doc.layers.length) return false;
  if (a.activeLayerIndex !== doc.activeLayerIndex) return false;
  if (a.width !== doc.width || a.height !== doc.height) return false;
  if ((a.style ?? 'pixel') !== (doc.style ?? 'pixel')) return false;
  if (a.title !== doc.title) return false;
  if (a.symmetry !== doc.symmetry) return false;
  if (a.seed !== doc.seed) return false;
  if (JSON.stringify(a.lights ?? []) !== JSON.stringify(doc.lights ?? [])) return false;
  if (JSON.stringify(a.groups ?? []) !== JSON.stringify(doc.groups ?? [])) return false;
  if (a.paletteHex.join() !== doc.palette.toJSON().hex.join()) return false;
  for (let i = 0; i < a.layers.length; i++) {
    const x = a.layers[i], y = doc.layers[i];
    if (x.id !== y.id || x.visible !== y.visible || x.opacity !== y.opacity) return false;
    if (x.locked !== y.locked || (x.kind ?? 'raster') !== (y.kind ?? 'raster')) return false;
    const d = y.buffer.data;
    if (x.data.length !== d.length) return false;
    for (let k = 0; k < d.length; k++) if (x.data[k] !== d[k]) return false;
  }
  return true;
}

/** 单个快照的近似字节数（主用于撤销栈内存上限）。 */
function stateBytes(snap) {
  let n = 0;
  for (const l of snap.layers) n += l.data.length;
  return n;
}

export class History {
  /** @param {import('./document.js').PixelDocument} doc @param {number} [limit] @param {number} [maxBytes] */
  constructor(doc, limit = 120, maxBytes = 192 * 1024 * 1024) {
    this.doc = doc;
    this.limit = limit;
    /** 撤销栈内存上限（字节），大画布多图层时防止无界增长。 */
    this.maxBytes = maxBytes;
    this.undoStack = [];
    this.redoStack = [];
    this._pending = null;
    this._pendingLabel = '';
    /** @type {((h:History)=>void)[]} */
    this.listeners = [];
  }

  /** 入栈并按条数 + 字节数裁剪。 */
  _push(stack, entry) {
    stack.push(entry);
    while (stack.length > this.limit) stack.shift();
    let bytes = 0;
    for (const e of this.undoStack) bytes += stateBytes(e.state);
    for (const e of this.redoStack) bytes += stateBytes(e.state);
    while (bytes > this.maxBytes && (this.undoStack.length + this.redoStack.length) > 1) {
      const drop = this.undoStack.length ? this.undoStack : this.redoStack;
      bytes -= stateBytes(drop.shift().state);
    }
  }

  onChange(fn) { this.listeners.push(fn); return () => { this.listeners = this.listeners.filter((f) => f !== fn); }; }
  _emit() { for (const f of this.listeners) f(this); }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  begin(label = '编辑') {
    if (this._pending) this.commit();
    this._pending = snapshotDoc(this.doc);
    this._pendingLabel = label;
  }

  /** @returns {boolean} 是否真的入栈 */
  commit() {
    if (!this._pending) return false;
    const before = this._pending;
    this._pending = null;
    // 与实时文档比较，不额外复制一份 after 全量快照。
    if (stateEqualsDoc(before, this.doc)) return false;
    this._push(this.undoStack, { label: this._pendingLabel, state: before });
    this.redoStack.length = 0;
    this._emit();
    return true;
  }

  rollback() { this._pending = null; }

  undo() {
    if (!this.canUndo) return false;
    const entry = this.undoStack.pop();
    this._push(this.redoStack, { label: entry.label, state: snapshotDoc(this.doc) });
    restoreDoc(this.doc, entry.state);
    this._emit();
    return true;
  }

  redo() {
    if (!this.canRedo) return false;
    const entry = this.redoStack.pop();
    this._push(this.undoStack, { label: entry.label, state: snapshotDoc(this.doc) });
    restoreDoc(this.doc, entry.state);
    this._emit();
    return true;
  }

  /** 重置到某个已知状态并存档（用于 AI 轮次回退） */
  pushExternal(label, state) {
    this._push(this.undoStack, { label, state });
    this.redoStack.length = 0;
    this._emit();
  }

  capture() { return snapshotDoc(this.doc); }
  restoreTo(state) { restoreDoc(this.doc, state); this._emit(); }

  clear() { this.undoStack.length = 0; this.redoStack.length = 0; this._pending = null; this._emit(); }
}
