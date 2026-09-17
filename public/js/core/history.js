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
    const key = Object.keys(PRESETS).find((k) => PRESETS[k].hex.join() === snap.paletteHex.join());
    doc.palette = key ? Palette.from(key) : Palette.from(snap.paletteHex);
  }
  doc.invalidate();
}

function sameState(a, b) {
  if (!a || !b) return false;
  if (a.layers.length !== b.layers.length) return false;
  if (a.activeLayerIndex !== b.activeLayerIndex) return false;
  if (a.width !== b.width || a.height !== b.height) return false;
  if ((a.style ?? 'pixel') !== (b.style ?? 'pixel')) return false;
  if (JSON.stringify(a.lights ?? []) !== JSON.stringify(b.lights ?? [])) return false;
  for (let i = 0; i < a.layers.length; i++) {
    const x = a.layers[i], y = b.layers[i];
    if (x.id !== y.id || x.visible !== y.visible || x.opacity !== y.opacity) return false;
    if (x.data.length !== y.data.length) return false;
    for (let k = 0; k < x.data.length; k++) if (x.data[k] !== y.data[k]) return false;
  }
  return true;
}

export class History {
  /** @param {import('./document.js').PixelDocument} doc @param {number} [limit] */
  constructor(doc, limit = 120) {
    this.doc = doc;
    this.limit = limit;
    this.undoStack = [];
    this.redoStack = [];
    this._pending = null;
    this._pendingLabel = '';
    /** @type {((h:History)=>void)[]} */
    this.listeners = [];
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
    const after = snapshotDoc(this.doc);
    if (sameState(before, after)) return false;
    this.undoStack.push({ label: this._pendingLabel, state: before });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
    this._emit();
    return true;
  }

  rollback() { this._pending = null; }

  undo() {
    if (!this.canUndo) return false;
    const entry = this.undoStack.pop();
    this.redoStack.push({ label: entry.label, state: snapshotDoc(this.doc) });
    restoreDoc(this.doc, entry.state);
    this._emit();
    return true;
  }

  redo() {
    if (!this.canRedo) return false;
    const entry = this.redoStack.pop();
    this.undoStack.push({ label: entry.label, state: snapshotDoc(this.doc) });
    restoreDoc(this.doc, entry.state);
    this._emit();
    return true;
  }

  /** 重置到某个已知状态并存档（用于 AI 轮次回退） */
  pushExternal(label, state) {
    this.undoStack.push({ label, state });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
    this._emit();
  }

  capture() { return snapshotDoc(this.doc); }
  restoreTo(state) { restoreDoc(this.doc, state); this._emit(); }

  clear() { this.undoStack.length = 0; this.redoStack.length = 0; this._pending = null; this._emit(); }
}
