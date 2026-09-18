/**
 * 画布交互（鼠标 / 触控 / 键盘修饰键）
 * ---------------------------------------------------------------
 * 自由笔刷直接操作像素缓冲；形状工具通过 PixelScript 提交，
 * 从而自动获得对称、参数校验与一致语义。
 */

import { symmetryTransforms, floodFill, PixelBuffer } from '../core/buffer.js';
import { drawLine as pxLine } from '../core/buffer.js';
import { parseColor } from '../util/color.js';
import { runScript } from '../lang/compiler.js';

const TOOL_NAMES = {
  pencil: '铅笔', eraser: '橡皮', bucket: '油漆桶', dropper: '吸管',
  line: '直线', rect: '矩形', circle: '椭圆', select: '选区', annotate: '标注',
};

export class Tools {
  /** @param {any} app */
  constructor(app) {
    this.app = app;
    this.tool = 'pencil';
    this.active = false;
    this.button = 0;
    this.start = { x: 0, y: 0 };
    this.last = { x: 0, y: 0 };
    this.panning = false;
    this.moved = false;
    this.shapeLine = 1;
    this.selectMode = 'none';
    this.selOrigin = { x: 0, y: 0 };
    this.floating = null;
  }

  get name() { return TOOL_NAMES[this.tool] || this.tool; }

  setTool(t) {
    if (this.floating) this.commitFloating();
    this.tool = t;
    if (t !== 'annotate') {
      this.app.renderer.annotPreview = null;
      this.app.requestRender();
    }
    this.app.onToolChange?.(t);
  }

  attach(stage) {
    this.stage = stage;
    stage.addEventListener('pointerdown', (e) => this.onDown(e));
    stage.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', (e) => this.onUp(e));
    stage.addEventListener('pointerleave', () => { this.app.renderer.hover = null; this.app.requestRender(); });
    stage.addEventListener('contextmenu', (e) => e.preventDefault());
    stage.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
  }

  /* ── 坐标 & 颜色 ── */

  pick(e) {
    const p = this.app.renderer.screenToPixel(e.clientX, e.clientY);
    return { x: p.x, y: p.y };
  }

  colorFor(button) {
    const { primary, secondary } = this.app;
    return button === 2 ? secondary : primary;
  }

  transforms() {
    const doc = this.app.doc;
    return symmetryTransforms(doc.width, doc.height, doc.symmetry);
  }

  /* ── 事件 ── */

  onDown(e) {
    const app = this.app;
    this.stage?.setPointerCapture?.(e.pointerId);
    const p = this.pick(e);
    this.start = { ...p };
    this.last = { ...p };
    this.button = e.button;
    this.moved = false;

    // 标注不修改图层，故不受图层锁定限制
    if (this.tool === 'annotate' && !e.altKey) {
      this.active = true;
      this.annotStart = { ...p };
      app.renderer.annotPreview = { x: p.x, y: p.y, w: 1, h: 1 };
      app.requestRender();
      return;
    }

    if (app.doc.activeLayer.locked) {
      app.warn('当前图层已锁定');
      return;
    }

    if (e.button === 1 || app.spaceDown) {
      this.panning = true;
      this.panStart = { x: e.clientX, y: e.clientY, ox: app.renderer.offsetX, oy: app.renderer.offsetY };
      return;
    }

    const tool = e.altKey ? 'dropper' : this.tool;
    this.active = true;

    if (tool === 'dropper') { this.dropper(p); this.active = false; return; }

    if (tool === 'pencil' || tool === 'eraser') {
      app.history.begin(tool === 'eraser' ? '擦除' : '绘制');
      this.paint(p, tool === 'eraser' ? null : this.colorFor(e.button));
      return;
    }

    if (tool === 'bucket') {
      app.history.begin('填充');
      const c = parseColor(this.colorName(this.colorFor(e.button)), app.doc.palette);
      for (const t of this.transforms()) {
        const [nx, ny] = t(p.x, p.y);
        floodFill(app.doc.activeLayer.buffer, nx, ny, c);
      }
      app.doc.invalidate();
      app.history.commit();
      app.afterEdit();
      this.active = false;
      return;
    }

    if (tool === 'select') {
      this.beginSelect(p);
      return;
    }

    this.previewShape(p, p);
  }

  onMove(e) {
    const app = this.app;
    const p = this.pick(e);
    app.renderer.hover = p;
    app.updateHud(p);

    if (this.panning) {
      app.renderer.offsetX = this.panStart.ox + (e.clientX - this.panStart.x);
      app.renderer.offsetY = this.panStart.oy + (e.clientY - this.panStart.y);
      app.requestRender();
      return;
    }

    if (this.tool === 'annotate' && this.active) {
      app.renderer.annotPreview = this._rectTo(this.annotStart, p);
      app.requestRender();
      return;
    }

    if (!this.active) { app.requestRender(); return; }

    const dist = Math.abs(p.x - this.start.x) + Math.abs(p.y - this.start.y);
    if (dist > 0) this.moved = true;

    if (this.tool === 'pencil' || this.tool === 'eraser' || e.altKey) {
      const tool = e.altKey ? 'dropper' : this.tool;
      if (tool === 'dropper') { this.dropper(p); this.active = false; return; }
      this.paint(p, tool === 'eraser' ? null : this.colorFor(this.button));
      return;
    }

    if (this.tool === 'select') { this.updateSelect(p, e.shiftKey); return; }

    this.previewShape(this.start, p, e.shiftKey);
  }

  onUp(e) {
    const app = this.app;
    if (this.panning) { this.panning = false; this.stage?.classList.remove('panning'); return; }
    if (!this.active) return;
    this.active = false;

    if (this.tool === 'annotate') {
      const p = this.pick(e);
      app.renderer.annotPreview = null;
      app.addAnnotation?.(this._rectTo(this.annotStart, p));
      app.requestRender();
      return;
    }

    if (this.tool === 'select') { this.endSelect(); return; }

    if (this.tool === 'line' || this.tool === 'rect' || this.tool === 'circle') {
      const p = this.pick(e);
      const script = this.shapeScript(this.start, p, e.shiftKey);
      app.renderer.overlay = null;
      if (script) {
        app.history.begin(TOOL_NAMES[this.tool]);
        const report = runScript(script, app.doc, { mode: 'append' });
        app.history.commit();
        if (report.errors.length) app.warn(report.errors[0]);
        app.afterEdit();
      }
      return;
    }

    if (this.tool === 'pencil' || this.tool === 'eraser' || e.altKey) {
      app.history.commit();
      app.afterEdit();
    }
  }

  onWheel(e) {
    e.preventDefault();
    const app = this.app;
    if (e.ctrlKey || e.metaKey || !e.shiftKey) {
      const r = app.renderer.canvas.getBoundingClientRect();
      const k = app.renderer.canvas.width / r.width;
      app.renderer.zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, (e.clientX - r.left) * k, (e.clientY - r.top) * k);
    } else {
      app.renderer.offsetY -= e.deltaY;
      app.renderer.offsetX -= e.deltaX;
    }
    app.requestRender();
  }

  /* ── 具体操作 ── */

  colorName(c) {
    const i = this.app.colorIndex(c);
    return i >= 0 ? `c${i}` : `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  }

  paint(p, c) {
    const app = this.app;
    const empty = { r: 0, g: 0, b: 0, a: 0 };
    const buf = app.doc.activeLayer.buffer;
    for (const t of this.transforms()) {
      const [x0, y0] = t(this.last.x, this.last.y);
      const [x1, y1] = t(p.x, p.y);
      if (x0 === x1 && y0 === y1) {
        if (c) buf.plot(x1, y1, c);
        else buf.fillRect(x1, y1, 1, 1, empty, false);
      } else {
        if (c) pxLine(buf, x0, y0, x1, y1, c, 1);
        else {
          const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
          const n = Math.max(dx, dy);
          for (let i = 0; i <= n; i++) {
            const xx = Math.round(x0 + ((x1 - x0) * i) / (n || 1));
            const yy = Math.round(y0 + ((y1 - y0) * i) / (n || 1));
            buf.fillRect(xx, yy, 1, 1, empty, false);
          }
        }
      }
    }
    this.last = { ...p };
    app.doc.invalidate();
    app.requestRender();
    app.markDirty();
  }

  dropper(p) {
    const c = this.app.doc.composite().get(p.x, p.y);
    this.app.setColor(c);
  }

  previewShape(a, b, shift = false) {
    const app = this.app;
    const script = this.shapeScript(a, b, shift);
    const buf = app.scratch();
    if (script) runScript(script, app.doc, { mode: 'replace', buffer: buf });
    app.renderer.overlay = buf;
    app.requestRender();
  }

  /** 依据起止点生成形状脚本（预览与提交共用，保证所见即所得） */
  shapeScript(a, b, shift = false) {
    let x0 = a.x, y0 = a.y, x1 = b.x, y1 = b.y;
    if (shift) {
      if (this.tool === 'line') {
        const dx = x1 - x0, dy = y1 - y0;
        if (Math.abs(dx) > Math.abs(dy)) y1 = y0 + Math.sign(dy || 0) * Math.abs(dx) * (Math.abs(dy) > Math.abs(dx) / 2 ? 1 : 0);
        else x1 = x0 + Math.sign(dx || 0) * Math.abs(dy);
      } else {
        const s = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
        x1 = x0 + (x1 < x0 ? -s : s);
        y1 = y0 + (y1 < y0 ? -s : s);
      }
    }
    const c = this.colorName(this.colorFor(this.button));
    if (this.tool === 'line') {
      if (x0 === x1 && y0 === y1) return null;
      return `line ${x0} ${y0} ${x1} ${y1} ${c}`;
    }
    if (this.tool === 'rect') {
      const x = Math.min(x0, x1), y = Math.min(y0, y1);
      const w = Math.abs(x1 - x0) + 1, h = Math.abs(y1 - y0) + 1;
      return `rect ${x} ${y} ${w} ${h} ${c} fill`;
    }
    if (this.tool === 'circle') {
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      const rx = Math.abs(x1 - x0) / 2, ry = Math.abs(y1 - y0) / 2;
      return `ellipse ${Math.round(cx)} ${Math.round(cy)} ${Math.round(rx)} ${Math.round(ry)} ${c} fill`;
    }
    return null;
  }

  /* ── 选区 ── */

  beginSelect(p) {
    const app = this.app;
    const sel = app.renderer.selection;
    if (sel && this.insideSelection(p, sel)) {
      app.history.begin('移动选区');
      this.floating = { dx: 0, dy: 0 };
      this.selOrigin = { ...p };
      this.liftSelection(sel);
      this.selectMode = 'moving';
      return;
    }
    if (sel) this.commitFloating();
    this.selectMode = 'creating';
    app.renderer.selection = { x: p.x, y: p.y, w: 1, h: 1 };
    this.selOrigin = { ...p };
    app.requestRender();
  }

  updateSelect(p, shift) {
    if (this.selectMode === 'creating') {
      const o = this.selOrigin;
      let x1 = p.x, y1 = p.y;
      if (shift) {
        const s = Math.max(Math.abs(x1 - o.x), Math.abs(y1 - o.y));
        x1 = o.x + (x1 < o.x ? -s : s);
        y1 = o.y + (y1 < o.y ? -s : s);
      }
      this.app.renderer.selection = {
        x: Math.min(o.x, x1), y: Math.min(o.y, y1),
        w: Math.abs(x1 - o.x) + 1, h: Math.abs(y1 - o.y) + 1,
      };
      this.app.requestRender();
    } else if (this.selectMode === 'moving' && this.floating) {
      this.floating.dx = p.x - this.selOrigin.x;
      this.floating.dy = p.y - this.selOrigin.y;
      const np = this.buildFloatingPreview();
      if (np) this.app.renderer.overlay = np;
      this.app.requestRender();
    }
  }

  insideSelection(p, s) {
    return p.x >= s.x && p.y >= s.y && p.x < s.x + s.w && p.y < s.y + s.h;
  }

  /** 由起止点得到规范化矩形（含端点，至少 1×1）。 */
  _rectTo(a, b) {
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    return { x, y, w: Math.abs(b.x - a.x) + 1, h: Math.abs(b.y - a.y) + 1 };
  }

  liftSelection(sel) {
    const app = this.app;
    const buf = app.doc.activeLayer.buffer;
    // 必须用独立缓冲保存抬起内容：app.scratch() 是共享缓冲，buildFloatingPreview 会把它清空，
    // 导致预览/落回内容丢失、原选区像素被删除。
    const cut = new PixelBuffer(sel.w, sel.h);
    const empty = { r: 0, g: 0, b: 0, a: 0 };
    for (let y = 0; y < sel.h; y++) {
      for (let x = 0; x < sel.w; x++) {
        const sx = sel.x + x, sy = sel.y + y;
        if (!buf.inBounds(sx, sy)) continue;
        cut.setPacked(x, y, buf.getPacked(sx, sy));
        buf.fillRect(sx, sy, 1, 1, empty, false);
      }
    }
    this.floating = { dx: 0, dy: 0, cut };
    app.doc.invalidate();
  }

  buildFloatingPreview() {
    const sel = this.app.renderer.selection;
    if (!sel || !this.floating?.cut) return null;
    const buf = this.app.scratch();
    const { dx, dy, cut } = this.floating;
    for (let y = 0; y < sel.h; y++) {
      for (let x = 0; x < sel.w; x++) {
        buf.setPacked(sel.x + dx + x, sel.y + dy + y, cut.getPacked(x, y));
      }
    }
    return buf;
  }

  endSelect() {
    if (this.selectMode === 'moving') {
      const sel = this.app.renderer.selection;
      const { dx, dy, cut } = this.floating || {};
      // 无论是否移动都要写回：内容在 liftSelection 时已从图层抬起，不写回等于删除。
      if (cut && sel) {
        const buf = this.app.doc.activeLayer.buffer;
        for (let y = 0; y < sel.h; y++) {
          for (let x = 0; x < sel.w; x++) {
            buf.setPacked(sel.x + dx + x, sel.y + dy + y, cut.getPacked(x, y));
          }
        }
        this.app.renderer.selection = { x: sel.x + dx, y: sel.y + dy, w: sel.w, h: sel.h };
      }
      this.app.doc.invalidate();
      this.app.history.commit();
      this.app.afterEdit();
      this.floating = null;
    } else {
      const sel = this.app.renderer.selection;
      if (sel && sel.w <= 0 && sel.h <= 0) this.app.renderer.selection = null;
    }
    this.selectMode = 'none';
    this.active = false;
    this.app.requestRender();
    this.app.onSelectionChange?.();
  }

  commitFloating() {
    if (this.selectMode === 'moving') this.endSelect();
  }

  /** 以浮动选区方式放入一块内容（粘贴用），可直接拖动后提交。 */
  startFloating(content, x, y) {
    const app = this.app;
    this.commitFloating();
    if (!content || !content.width || !content.height) return;
    this.floating = { dx: 0, dy: 0, cut: content.clone() };
    this.selOrigin = { x, y };
    app.renderer.selection = { x, y, w: content.width, h: content.height };
    this.selectMode = 'moving';
    app.requestRender();
    app.onSelectionChange?.();
  }

  get hasFloating() { return Boolean(this.floating) && this.selectMode === 'moving'; }

  deleteSelection() {
    const app = this.app;
    const sel = app.renderer.selection;
    if (!sel) return false;
    app.history.begin('删除选区');
    app.doc.activeLayer.buffer.fillRect(sel.x, sel.y, sel.w, sel.h, { r: 0, g: 0, b: 0, a: 0 }, false);
    app.doc.invalidate();
    app.history.commit();
    app.afterEdit();
    return true;
  }

  clearSelection() {
    this.commitFloating();
    this.app.renderer.selection = null;
    this.app.requestRender();
    this.app.onSelectionChange?.();
  }
}
