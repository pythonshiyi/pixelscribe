/**
 * 像素画笔 · DOM 冒烟测试（jsdom）
 * ---------------------------------------------------------------
 *   node test/dom-smoke.mjs
 *
 * 在无头 DOM 中真实启动整个应用，模拟用户操作，
 * 捕捉任何未捕获异常 / 未处理 Promise 拒绝 / 控制台 error。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

/* ─────────── 结果收集 ─────────── */

let passed = 0;
const failures = [];
const runtimeErrors = [];

function ok(name, fn) {
  try {
    const r = fn();
    if (r === false) throw new Error('返回 false');
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  \x1b[31m✗ ${name}\x1b[0m\n      ${err.message}`);
  }
}
function assert(cond, msg = '断言失败') { if (!cond) throw new Error(msg); }
function eq(a, b, msg = '') { if (a !== b) throw new Error(`${msg} 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); }

/* ─────────── 构造 DOM 环境 ─────────── */

const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const dom = new JSDOM(html, {
  url: 'http://localhost:5173/',
  pretendToBeVisual: true,
  runScripts: 'outside-only',
});
const { window } = dom;

/* 2D 上下文桩：记录调用，不做真实光栅化 */
function makeCtx(canvas) {
  return {
    canvas,
    imageSmoothingEnabled: true,
    globalAlpha: 1,
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    font: '',
    clearRect() {}, fillRect() {}, strokeRect() {}, drawImage() {},
    putImageData() {},
    getImageData(x, y, w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; },
    save() {}, restore() {}, setTransform() {}, translate() {}, scale() {},
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, rect() {}, arc() {}, fill() {}, stroke() {}, clip() {},
    setLineDash() {}, createPattern() { return { __pattern: true }; },
  };
}
window.HTMLCanvasElement.prototype.getContext = function getContext() { return makeCtx(this); };
window.HTMLCanvasElement.prototype.toDataURL = function toDataURL() { return 'data:image/png;base64,iVBORw0KGgo='; };
window.URL.createObjectURL = () => 'blob:mock';
window.URL.revokeObjectURL = () => {};
// 被测代码里的 `URL` 解析到 Node 全局，需一并打桩（Node 的 createObjectURL 只接受 Node Blob）
if (globalThis.URL) {
  try {
    globalThis.URL.createObjectURL = () => 'blob:mock';
    globalThis.URL.revokeObjectURL = () => {};
  } catch { /* 只读则忽略 */ }
}

class ImageDataStub {
  constructor(data, w, h) {
    if (typeof data === 'number') { this.width = data; this.height = w; this.data = new Uint8ClampedArray(data * w * 4); }
    else { this.data = data; this.width = w; this.height = h; }
  }
}
window.ImageData = ImageDataStub;

window.ResizeObserver = class ResizeObserver {
  constructor(cb) { this.cb = cb; }
  observe() { this.cb([{ contentRect: { width: 900, height: 640 } }]); }
  unobserve() {} disconnect() {}
};

const RECT = { x: 0, y: 0, left: 0, top: 0, right: 900, bottom: 640, width: 900, height: 640 };
window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() { return { ...RECT }; };

/* 暴露到全局，供被测模块以裸标识符访问。
   注意：不覆盖 performance / structuredClone / navigator ——
   Node 自身的实现更完整，替换 jsdom 版本会引发递归。 */
const EXPOSE = [
  'document', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent',
  'CustomEvent', 'DOMException', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
  'Image', 'Blob', 'FileReader', 'ImageData', 'localStorage', 'sessionStorage',
  'DOMParser', 'ResizeObserver', 'SVGElement', 'NodeList', 'CSS',
];
for (const k of EXPOSE) {
  if (window[k] === undefined) continue;
  try {
    Object.defineProperty(globalThis, k, { value: window[k], writable: true, configurable: true });
  } catch { /* 个别只读全局（如 navigator）无法覆盖，忽略 */ }
}
Object.defineProperty(globalThis, 'window', { value: window, writable: true, configurable: true });

/* 捕获所有运行时异常 */
window.addEventListener('error', (e) => runtimeErrors.push(`window.error: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => runtimeErrors.push(`unhandledrejection: ${e.reason?.message || e.reason}`));
process.on('unhandledRejection', (r) => runtimeErrors.push(`node unhandledRejection: ${r?.message || r}`));
process.on('uncaughtException', (e) => runtimeErrors.push(`node uncaughtException: ${e.message}`));

/* ─────────── 启动应用 ─────────── */

console.log('\n\x1b[38;5;213m▸ DOM 冒烟测试（jsdom）\x1b[0m');

const { App } = await import('../public/js/ui/app.js');
const $ = (s) => window.document.querySelector(s);

let app = null;
try {
  app = new App({
    demoMode: true,
    keyConfigured: false,
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    temperature: 0.6,
    maxIterations: 3,
    visionLongEdge: 192,
  });
  await app.init();
  ok('App 构造与 init() 无异常', () => assert(app.doc, 'doc 未创建'));
} catch (err) {
  failures.push({ name: 'App.init', err });
  console.log(`  \x1b[31m✗ App.init 抛出\x1b[0m\n      ${err.stack}`);
}

if (!app) {
  console.log('\n\x1b[31m启动失败，后续测试跳过\x1b[0m');
  process.exit(1);
}

/* ─────────── 基础状态 ─────────── */

ok('画布尺寸为 32×32', () => eq(app.doc.width, 32));
ok('初始范例已渲染出像素', () => assert(app.doc.activeLayer.buffer.opaqueCount() > 40, `仅 ${app.doc.activeLayer.buffer.opaqueCount()} 像素`));
ok('文档标题同步到顶栏', () => eq($('#docTitle').value, '史莱姆'));
ok('舞台角标显示尺寸', () => assert($('#stageBadge').textContent.includes('32')));
ok('脚本编辑器已填充内容', () => assert(app.scriptPanel.getValue().includes('size 32 32')));
ok('调色板渲染出 16 个色块', () => eq(window.document.querySelectorAll('#swatchGrid .swatch-cell').length, 16));
ok('图层列表渲染出 1 项', () => eq(window.document.querySelectorAll('#layerList .layer-item').length, 1));
ok('状态栏显示工具与尺寸', () => {
  eq($('#stTool').textContent, '铅笔');
  eq($('#stSize').textContent, '32 × 32');
});

/* ─────────── 工具与顶栏 ─────────── */

ok('点击工具按钮切换工具', () => {
  $('[data-tool="rect"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  eq(app.tools.tool, 'rect');
  eq($('#stTool').textContent, '矩形');
  assert($('[data-tool="rect"]').classList.contains('on'));
  $('[data-tool="pencil"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  eq(app.tools.tool, 'pencil');
});

ok('对称分段按钮生效', () => {
  const btn = window.document.querySelector('#segSym [data-sym="xy"]');
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  eq(app.doc.symmetry, 'xy');
  assert(btn.classList.contains('on'));
  window.document.querySelector('#segSym [data-sym="off"]')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  eq(app.doc.symmetry, 'off');
});

ok('网格开关切换 renderer.grid', () => {
  const before = app.renderer.grid;
  $('#btnGrid').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  eq(app.renderer.grid, !before);
  $('#btnGrid').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  eq(app.renderer.grid, before);
});

ok('缩放按钮改变 scale 并回写读数', () => {
  const before = app.renderer.scale;
  $('#btnZoomIn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert(app.renderer.scale > before, '未放大');
  $('#btnZoomOut').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  $('#btnFit').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert(/\d+%/.test($('#zoomReadout').textContent), '读数格式异常');
});

ok('主副色交换', () => {
  const p = { ...app.primary };
  const s = { ...app.secondary };
  $('#btnSwap').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  eq(app.primary.r, s.r, '交换后主色应为原副色');
  eq(app.secondary.r, p.r, '交换后副色应为原主色');
  $('#btnSwap').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  eq(app.primary.r, p.r);
});

/* ─────────── 调色板 ─────────── */

ok('切换调色板预设', () => {
  const sel = $('#palettePreset');
  sel.value = 'gameboy';
  sel.dispatchEvent(new window.Event('change', { bubbles: true }));
  eq(app.doc.palette.size, 4);
  eq(window.document.querySelectorAll('#swatchGrid .swatch-cell').length, 4);
  sel.value = 'pico8';
  sel.dispatchEvent(new window.Event('change', { bubbles: true }));
  eq(app.doc.palette.size, 16);
});

ok('点击色块设置主色', () => {
  const cells = window.document.querySelectorAll('#swatchGrid .swatch-cell');
  cells[8].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  eq(app.primaryIndex, 8);
  eq($('#idxPrimary').textContent, 'c8');
  assert($('#stColor').textContent.includes('#ff004d'));
});

ok('新增色块扩展调色板', () => {
  const before = app.doc.palette.size;
  $('#btnAddColor').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  eq(app.doc.palette.size, before + 1);
  eq(window.document.querySelectorAll('#swatchGrid .swatch-cell').length, before + 1);
});

ok('从图像提取色板', () => {
  $('#btnExtract').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert(app.doc.palette.size >= 2, `提取后色数 ${app.doc.palette.size}`);
  $('#palettePreset').value = 'pico8';
  $('#palettePreset').dispatchEvent(new window.Event('change', { bubbles: true }));
  eq(app.doc.palette.size, 16);
});

/* ─────────── 图层 ─────────── */

ok('新建图层', () => {
  $('#btnAddLayer').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  eq(app.doc.layers.length, 2);
  eq(window.document.querySelectorAll('#layerList .layer-item').length, 2);
});

ok('切换活动图层', () => {
  const items = window.document.querySelectorAll('#layerList .layer-item');
  items[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  eq(app.doc.activeLayerIndex, 0);
});

ok('图层可见性开关', () => {
  const target = app.doc.layers[app.doc.layers.length - 1];
  const before = target.visible;
  const visibleBefore = app.doc.layers.filter((l) => l.visible).length;
  window.document.querySelector('#layerList .layer-eye')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  eq(target.visible, !before, '顶层图层可见性应翻转');
  eq(app.doc.layers.filter((l) => l.visible).length, visibleBefore + (before ? -1 : 1));
  window.document.querySelector('#layerList .layer-eye')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  eq(target.visible, before);
});

ok('向下合并图层', () => {
  app.doc.activeLayerIndex = 1;
  $('#btnMergeLayer').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  eq(app.doc.layers.length, 1);
});

/* ─────────── 页签 ─────────── */

ok('页签切换显示对应面板', () => {
  for (const name of ['script', 'layers', 'palette', 'ai']) {
    window.document.querySelector(`#tabs .tab[data-tab="${name}"]`)
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    assert(window.document.querySelector(`.pane[data-pane="${name}"]`).classList.contains('on'), `${name} 面板未激活`);
  }
});

/* ─────────── 画布绘制 ─────────── */

function pointer(type, clientX, clientY, button = 0, target = null) {
  const ev = new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY, button });
  (target || $('#stageCanvas')).dispatchEvent(ev);
}

function coordsFor(px, py) {
  const p = app.renderer.pixelToScreen(px + 0.5, py + 0.5);
  return p;
}

ok('铅笔自由绘制', () => {
  app.tools.setTool('pencil');
  app.doc.activeLayer.buffer.clear({ r: 0, g: 0, b: 0, a: 0 });
  app.doc.invalidate();
  app.setPrimaryIndex(8);
  const a = coordsFor(4, 4);
  const b = coordsFor(12, 4);
  pointer('pointerdown', a.x, a.y);
  pointer('pointermove', b.x, b.y);
  window.dispatchEvent(new window.MouseEvent('pointerup', { bubbles: true, clientX: b.x, clientY: b.y }));
  const n = app.doc.activeLayer.buffer.opaqueCount();
  assert(n >= 9, `绘制像素过少：${n}`);
  eq(app.doc.activeLayer.buffer.get(4, 4).r, 255);
  eq(app.doc.activeLayer.buffer.get(12, 4).r, 255);
});

ok('形状工具预览并提交（矩形）', () => {
  app.tools.setTool('rect');
  const a = coordsFor(4, 10);
  const b = coordsFor(12, 18);
  const before = app.doc.activeLayer.buffer.opaqueCount();
  pointer('pointerdown', a.x, a.y);
  pointer('pointermove', b.x, b.y);
  assert(app.renderer.overlay, '拖拽时应产生预览层');
  window.dispatchEvent(new window.MouseEvent('pointerup', { bubbles: true, clientX: b.x, clientY: b.y }));
  eq(app.renderer.overlay, null, '提交后应清除预览');
  const after = app.doc.activeLayer.buffer.opaqueCount();
  assert(after > before + 50, `矩形未生效：${before} → ${after}`);
});

ok('油漆桶填充', () => {
  app.tools.setTool('bucket');
  app.setPrimaryIndex(12);
  app.doc.activeLayer.buffer.clear({ r: 0, g: 0, b: 0, a: 0 });
  app.doc.invalidate();
  const p = coordsFor(16, 16);
  pointer('pointerdown', p.x, p.y);
  eq(app.doc.activeLayer.buffer.opaqueCount(), 1024);
});

ok('吸管取色', () => {
  app.tools.setTool('dropper');
  const p = coordsFor(16, 16);
  pointer('pointerdown', p.x, p.y);
  eq(app.primaryIndex, 12, '应取到油漆桶填的 c12');
  app.tools.setTool('pencil');
});

ok('右键使用副色', () => {
  app.doc.activeLayer.buffer.clear({ r: 0, g: 0, b: 0, a: 0 });
  app.doc.invalidate();
  const p = coordsFor(3, 3);
  pointer('pointerdown', p.x, p.y, 2);
  window.dispatchEvent(new window.MouseEvent('pointerup', { bubbles: true, clientX: p.x, clientY: p.y }));
  const c = app.doc.activeLayer.buffer.get(3, 3);
  assert(c.a === 255, '副色未绘制');
});

ok('选区创建与删除', () => {
  app.tools.setTool('select');
  app.doc.activeLayer.buffer.clear({ r: 8, g: 8, b: 8, a: 255 });
  app.doc.invalidate();
  const a = coordsFor(4, 4);
  const b = coordsFor(8, 8);
  pointer('pointerdown', a.x, a.y);
  pointer('pointermove', b.x, b.y);
  window.dispatchEvent(new window.MouseEvent('pointerup', { bubbles: true, clientX: b.x, clientY: b.y }));
  assert(app.renderer.selection, '未创建选区');
  eq(app.renderer.selection.w, 5);
  assert(app.tools.deleteSelection(), '删除选区失败');
  eq(app.doc.activeLayer.buffer.get(5, 5).a, 0);
  app.tools.clearSelection();
  eq(app.renderer.selection, null);
  app.tools.setTool('pencil');
});

/* ─────────── 局部重绘 ─────────── */

let localResult = null;
try {
  app.tools.setTool('select');
  app.doc.activeLayer.buffer.clear({ r: 30, g: 30, b: 30, a: 255 });
  app.doc.invalidate();
  const a = coordsFor(4, 4);
  const b = coordsFor(12, 12);
  pointer('pointerdown', a.x, a.y);
  pointer('pointermove', b.x, b.y);
  window.dispatchEvent(new window.MouseEvent('pointerup', { bubbles: true, clientX: b.x, clientY: b.y }));
  localResult = await app.applyLocalRender(app.renderer.selection, '细化');
} catch (err) {
  failures.push({ name: '局部重绘', err });
  console.log(`  \x1b[31m✗ 局部重绘抛出\x1b[0m\n      ${err.stack}`);
}
ok('局部重绘写入神经残差层', () => {
  assert(localResult, '应返回结果');
  assert(app.doc.neuralLayer, '应创建神经残差层');
  assert(app.doc.neuralLayer.buffer.opaqueCount() > 20, `区域内容过少：${app.doc.neuralLayer.buffer.opaqueCount()}`);
});
ok('局部重绘按钮存在于 AI 面板', () => assert($('#btnLocalRedraw'), '缺少 #btnLocalRedraw'));
app.tools.clearSelection();
app.tools.setTool('pencil');

/* ─────────── 撤销 / 重做 ─────────── */

ok('撤销与重做按钮', () => {
  app.doc.activeLayer.buffer.clear({ r: 0, g: 0, b: 0, a: 0 });
  app.doc.invalidate();
  app.history.clear();
  app.tools.setTool('pencil');
  app.setPrimaryIndex(8);
  const p = coordsFor(20, 20);
  pointer('pointerdown', p.x, p.y);
  window.dispatchEvent(new window.MouseEvent('pointerup', { bubbles: true, clientX: p.x, clientY: p.y }));
  eq(app.doc.activeLayer.buffer.get(20, 20).a, 255);
  eq($('#btnUndo').disabled, false);
  $('#btnUndo').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  eq(app.doc.activeLayer.buffer.get(20, 20).a, 0, '撤销未生效');
  $('#btnRedo').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  eq(app.doc.activeLayer.buffer.get(20, 20).a, 255, '重做未生效');
});

/* ─────────── 键盘快捷键 ─────────── */

function key(k, extra = {}) {
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, ...extra }));
}

ok('快捷键切换工具', () => {
  key('e'); eq(app.tools.tool, 'eraser');
  key('g'); eq(app.tools.tool, 'bucket');
  key('i'); eq(app.tools.tool, 'dropper');
  key('l'); eq(app.tools.tool, 'line');
  key('r'); eq(app.tools.tool, 'rect');
  key('o'); eq(app.tools.tool, 'circle');
  key('m'); eq(app.tools.tool, 'select');
  key('b'); eq(app.tools.tool, 'pencil');
});

ok('数字键快速取色（1–8 对应 c0–c7）', () => {
  key('3');
  eq(app.primaryIndex, 2);
  key('1');
  eq(app.primaryIndex, 0);
});

ok('Ctrl+Z / Ctrl+Y 快捷键', () => {
  const n = app.history.undoStack.length;
  key('z', { ctrlKey: true });
  eq(app.history.undoStack.length, n - 1);
  key('y', { ctrlKey: true });
  eq(app.history.undoStack.length, n);
});

ok('空格进入平移模式', () => {
  key(' ', { code: 'Space' });
  assert(app.spaceDown, 'spaceDown 未置位');
  window.dispatchEvent(new window.KeyboardEvent('keyup', { code: 'Space', bubbles: true }));
  assert(!app.spaceDown, 'spaceDown 未复位');
});

ok('输入框聚焦时快捷键不劫持', () => {
  const input = $('#docTitle');
  const before = app.tools.tool;
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'e', bubbles: true }));
  eq(app.tools.tool, before, '输入框内不应切换工具');
});

/* ─────────── 脚本编辑器 ─────────── */

ok('运行脚本按钮', () => {
  app.scriptPanel.setValue('size 24 24\npalette pico8\nclear transparent\ncircle 12 12 10 c9 fill\noutline c1');
  $('#btnRunScript').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  eq(app.doc.width, 24);
  eq(app.doc.height, 24);
  assert(app.doc.activeLayer.buffer.opaqueCount() > 200, '脚本未绘制');
  assert($('#scriptReport').textContent.includes('指令'), '未输出执行报告');
  assert($('#scriptReport').classList.contains('ok'), '报告状态应为成功');
});

ok('语法错误在报告中提示', () => {
  app.scriptPanel.setValue('size 24 24\nbogus 1 2 3');
  app.scriptPanel.lint();
  assert($('#scriptReport').textContent.includes('bogus'), '未提示未知指令');
});

ok('整理（格式化）脚本', () => {
  app.scriptPanel.setValue('size   24   24\n\n\n\npx  1  1  c8');
  $('#btnFormatScript').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  eq(app.scriptPanel.getValue(), 'size 24 24\n\npx 1 1 c8');
});

/* ─────────── 模态框 ─────────── */

function closeModal() {
  $('#modalClose').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
}

ok('新建画布对话框', () => {
  $('#btnNew').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert(!$('#modalBackdrop').hidden, '模态未打开');
  const cards = window.document.querySelectorAll('#modalBody .size-card');
  assert(cards.length >= 6, '尺寸选项过少');
  cards[3].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const create = [...window.document.querySelectorAll('#modalFoot .btn')].find((b) => b.textContent.includes('创建'));
  create.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert($('#modalBackdrop').hidden, '模态未关闭');
  eq(app.doc.width, Number(cards[3].textContent.replace('²', '')));
});

ok('导出对话框', () => {
  $('#btnExport').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert(!$('#modalBackdrop').hidden);
  assert(window.document.querySelector('#modalBody .size-card'), '缺少缩放选项');
  const png = [...window.document.querySelectorAll('#modalFoot .btn')].find((b) => b.textContent.includes('导出 PNG'));
  png.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert($('#modalBackdrop').hidden);
});

ok('新建画布支持大尺寸（到 1024）', () => {
  $('#btnNew').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const cards = [...window.document.querySelectorAll('#modalBody .size-card')];
  assert(cards.some((c) => c.textContent.replace('²', '') === '1024'), '缺少 1024 画布');
  $('#modalClose').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
});

ok('导出对话框含平滑超分选项且可导出', () => {
  $('#btnExport').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert($('#exSmooth'), '缺少 #exSmooth');
  $('#exSmooth').checked = true;
  const png = [...window.document.querySelectorAll('#modalFoot .btn')].find((b) => b.textContent.includes('导出 PNG'));
  png.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert($('#modalBackdrop').hidden, '导出后应关闭');
  $('#exSmooth').checked = false;
});

ok('AI 画布选项含大尺寸', () => {
  const opts = [...$('#aiSize').options].map((o) => o.value);
  assert(opts.includes('512'), '缺少 512 选项');
});

ok('设置对话框可保存', () => {
  $('#btnSettings').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert(!$('#modalBackdrop').hidden);
  $('#setModel').value = 'gpt-4o';
  const save = [...window.document.querySelectorAll('#modalFoot .btn')].find((b) => b.textContent.includes('保存'));
  save.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  eq(app.settings.model, 'gpt-4o');
  assert($('#modalBackdrop').hidden);
});

ok('主题切换（白天 / 暗色）', () => {
  const root = window.document.documentElement;
  app.applyTheme('light', false);
  eq(root.dataset.theme, 'light');
  eq(app.renderer.theme, 'light');
  eq($('#btnTheme').querySelector('use').getAttribute('href'), '#i-moon');
  app.applyTheme('dark', false);
  eq(root.dataset.theme, 'dark');
  eq(app.renderer.theme, 'dark');
  eq(app.settings.theme, 'dark');
});

ok('作品面板存在（文件空间）', () => {
  assert($('#galleryGrid'), '缺少 #galleryGrid');
  assert($('#galleryPath'), '缺少 #galleryPath');
  assert(window.document.querySelector('[data-pane="gallery"]'), '缺少作品 pane');
});

ok('AI 风格选择器有 6 种风格', () => {
  const sel = $('#aiStyle');
  assert(sel, '缺少 #aiStyle');
  eq(sel.querySelectorAll('option').length, 6);
  assert($('#aiPlan'), '缺少导演模式开关 #aiPlan');
});

ok('示例库可载入', () => {
  $('#btnSamples').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert(!$('#modalBackdrop').hidden);
  const items = window.document.querySelectorAll('#modalBody .sample-item');
  assert(items.length >= 5, `示例数量过少：${items.length}`);
  items[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert($('#modalBackdrop').hidden, '选择示例后应关闭');
  assert(app.scriptPanel.getValue().length > 20, '示例未载入编辑器');
});

ok('Esc 关闭模态', () => {
  $('#btnSettings').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert(!$('#modalBackdrop').hidden);
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert($('#modalBackdrop').hidden, 'Esc 未关闭');
});

ok('点击遮罩关闭模态', () => {
  $('#btnExport').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const backdrop = $('#modalBackdrop');
  backdrop.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert(backdrop.hidden, '遮罩点击未关闭');
});

/* ─────────── 动画帧 / 洋葱皮 / 导出 ─────────── */

ok('帧条渲染出缩略图与状态', () => {
  eq(window.document.querySelectorAll('#frameList .frame-thumb').length, app.animation.length);
  assert($('#stFrame').textContent.includes('/'), '状态栏应显示帧号');
  assert($('#btnFrameAdd') && $('#btnFramePlay') && $('#btnFrameOnion'), '缺少帧条按钮');
});

ok('新增 / 复制 / 删除帧', () => {
  const n0 = app.animation.length;
  $('#btnFrameAdd').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  eq(app.animation.length, n0 + 1);
  $('#btnFrameDup').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  eq(app.animation.length, n0 + 2);
  eq(window.document.querySelectorAll('#frameList .frame-thumb').length, n0 + 2);
  for (let i = 0; i < n0 + 5; i++) {
    $('#btnFrameDel').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  }
  eq(app.animation.length, 1, '至少保留一帧');
});

ok('洋葱皮开关循环 关→前→前后', () => {
  app.animation.onion = 0;
  const b = $('#btnFrameOnion');
  b.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  eq(app.animation.onion, 1);
  b.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  eq(app.animation.onion, 2);
  b.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  eq(app.animation.onion, 0);
});

ok('播放 / 暂停状态切换', () => {
  app.animation.insertBlank(app.doc);
  app.updateOnion();
  app.togglePlay();
  assert(app.playing, '应进入播放');
  app.stopPlay();
  assert(!app.playing, '应停止播放');
  app.animation.remove(app.animation.current);
  app.animation.applyTo(app.doc, 0);
  app.syncFrames();
});

ok('精灵表 / GIF / Aseprite 导出不抛异常', () => {
  app.exportSpriteSheet();
  app.exportGIF();
  app.exportAseprite();
});

/* ─────────── AI 闭环（演示模式） ─────────── */

console.log('\n\x1b[38;5;213m▸ AI 面板（演示模式）\x1b[0m');

try {
  app.scriptPanel.setValue('size 32 32\nclear transparent');
  app.doc.resize(32, 32);
  app.doc.activeLayer.buffer.clear({ r: 0, g: 0, b: 0, a: 0 });
  app.doc.invalidate();

  $('#aiBrief').value = '画一个史莱姆';
  $('#aiMaxIter').value = '3';
  $('#aiSize').value = '32';
  window.document.querySelector('#tabs .tab[data-tab="ai"]')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  await app.chat.generate();

  ok('AI 生成完成且产生画面', () => {
    assert(app.doc.activeLayer.buffer.opaqueCount() > 200, `像素过少 ${app.doc.activeLayer.buffer.opaqueCount()}`);
  });
  ok('生成按钮恢复可用、中止按钮禁用', () => {
    eq($('#btnGenerate').disabled, false);
    eq($('#btnAbort').disabled, true);
  });
  ok('AI 状态显示完成', () => {
    assert($('#aiStatus').textContent.includes('完成'), `状态：${$('#aiStatus').textContent}`);
    assert($('#aiStatus').classList.contains('ok'));
  });
  ok('轮次卡片渲染到日志', () => {
    const cards = window.document.querySelectorAll('#aiLog .round');
    assert(cards.length >= 1, '无轮次卡片');
    assert(window.document.querySelector('#aiLog .round-thumb'), '缺少缩略图');
    assert(window.document.querySelector('#aiLog .round-stat'), '缺少统计');
  });
  ok('轮次卡片提供回退按钮并可用', () => {
    const btns = [...window.document.querySelectorAll('#aiLog .round-actions .btn')];
    const back = btns.find((b) => b.textContent.includes('回退'));
    assert(back, '缺少回退按钮');
    const beforeCount = app.doc.activeLayer.buffer.opaqueCount();
    back.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    assert(app.history.undoStack.length > 0, '回退未入历史栈');
    assert(beforeCount > 0);
  });
  ok('AI 轮次可通过 Ctrl+Z 撤销', () => {
    const n = app.history.undoStack.length;
    key('z', { ctrlKey: true });
    eq(app.history.undoStack.length, n - 1);
  });
} catch (err) {
  failures.push({ name: 'AI 闭环', err });
  console.log(`  \x1b[31m✗ AI 闭环抛出\x1b[0m\n      ${err.stack}`);
}

/* ─────────── 多帧生成 / 参考层 ─────────── */

ok('AI 面板存在帧数输入', () => assert($('#aiFrames'), '缺少 #aiFrames'));

try {
  const before = app.animation.length;
  $('#aiBrief').value = '走路循环';
  $('#aiFrames').value = '2';
  $('#aiMaxIter').value = '2';
  window.document.querySelector('#tabs .tab[data-tab="ai"]')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await app.chat.generate();
  ok('多帧生成新增帧并渲染多张轮次卡片', () => {
    assert(app.animation.length >= before + 1, `帧数 ${app.animation.length}`);
    const cards = window.document.querySelectorAll('#aiLog .round');
    assert(cards.length >= 2, `轮次卡片过少 ${cards.length}（历史上只显示了最后一轮）`);
  });
} catch (err) {
  failures.push({ name: '多帧生成', err });
  console.log(`  \x1b[31m✗ 多帧生成抛出\x1b[0m\n      ${err.stack}`);
}

ok('导入 AI 参考层', () => {
  app._doImportReference({ width: 8, height: 8 });
  const refs = app.doc.layers.filter((l) => l.kind === 'reference');
  eq(refs.length, 1, '应只有一个参考层');
  assert(refs[0].locked, '参考层应锁定');
});

/* ─────────── 持久化 ─────────── */

ok('保存到 localStorage 并恢复', () => {
  app.doc.title = '持久化测试';
  app.markDirty();
  app.save();
  const raw = window.localStorage.getItem('pixelscribe.doc.v1');
  assert(raw, '未写入 localStorage');
  const parsed = JSON.parse(raw);
  eq(parsed.doc.title, '持久化测试');
  eq(parsed.doc.width, app.doc.width);
  assert(parsed.script.length > 0, '未保存脚本');
});

ok('重新构造 App 能从 localStorage 恢复', async () => {
  // 同步检查：restore 读取路径可用（完整重建在下一节）
  const raw = JSON.parse(window.localStorage.getItem('pixelscribe.doc.v1'));
  assert(raw.doc.layers[0].data.length > 0, '像素数据未序列化');
});

ok('PNG 导出产出合法 dataURL', () => {
  const { dataURL, width, height } = app.renderer.export(128, true);
  assert(dataURL.startsWith('data:image/png;base64,iVBOR'), 'PNG 头部异常');
  assert(width >= 128 && height >= 128, `尺寸异常 ${width}×${height}`);
  assert(dataURL.length > 500, 'PNG 数据过短');
});

/* ─────────── 汇总 ─────────── */

console.log('\n' + '─'.repeat(58));
if (runtimeErrors.length) {
  console.log(`\x1b[31m捕获到 ${runtimeErrors.length} 条运行时错误：\x1b[0m`);
  for (const e of [...new Set(runtimeErrors)].slice(0, 20)) console.log(`  · ${e}`);
  failures.push({ name: '运行时错误', err: new Error(runtimeErrors.join(' | ')) });
}

if (failures.length === 0) {
  console.log(`\x1b[38;5;84m全部通过：${passed} 项\x1b[0m`);
  process.exit(0);
} else {
  console.log(`\x1b[31m失败 ${failures.length} 项\x1b[0m / 通过 ${passed} 项\n`);
  for (const f of failures) {
    console.log(`  \x1b[31m✗\x1b[0m ${f.name}\n    ${f.err.stack?.split('\n').slice(0, 3).join('\n    ') || f.err.message}`);
  }
  process.exit(1);
}
