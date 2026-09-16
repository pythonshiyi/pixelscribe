/**
 * 应用控制器：把引擎、语言、AI 与 UI 装配在一起
 */

import { $, $$, el, toast, modal, downloadDataURL, downloadText, readTextFile, readDataURL } from './dom.js';
import { PixelDocument } from '../core/document.js';
import { History } from '../core/history.js';
import { Renderer } from '../core/renderer.js';
import { PixelBuffer } from '../core/buffer.js';
import { Tools } from './tools.js';
import { ChatPanel } from './chat.js';
import { initLayers, initPalette, initScript } from './panels.js';
import { rgbaToHex } from '../util/color.js';
import { runScript } from '../lang/compiler.js';
import { SAMPLES } from '../samples.js';

const STORAGE_KEY = 'pixelscribe.doc.v1';
const SETTINGS_KEY = 'pixelscribe.settings.v1';

export class App {
  /** @param {any} config 服务端 /api/config 结果 */
  constructor(config) {
    this.config = config || { demoMode: true, baseUrl: '', model: '', maxIterations: 6, visionLongEdge: 384 };
    this.settings = this.loadSettings();
    this.doc = new PixelDocument(32, 32);
    this.history = new History(this.doc, 120);
    this.renderer = new Renderer($('#stageCanvas'));
    this.renderer.setDocument(this.doc);
    this.tools = new Tools(this);
    this.chat = new ChatPanel(this);
    this.dpr = Math.min(2, window.devicePixelRatio || 1);

    this._scratch = null;
    this.primary = { ...this.doc.palette.colors[0] };
    this.primaryIndex = 0;
    this.secondary = { ...this.doc.palette.colors[7] };
    this.secondaryIndex = 7;
    this.spaceDown = false;
    this._dirty = false;
  }

  /* ── 生命周期 ── */

  async init() {
    this.layersPanel = initLayers(this);
    this.palettePanel = initPalette(this);
    this.scriptPanel = initScript(this);

    this.chat.init();
    this.tools.attach($('#stage'));

    this.bindTopbar();
    this.bindTabs();
    this.bindKeys();
    this.bindStageResize();

    const restored = this.restore();
    if (!restored) {
      this.scriptPanel.setValue(SAMPLES[0].code);
      runScript(SAMPLES[0].code, this.doc, { mode: 'replace' });
      this.doc.title = '史莱姆';
      $('#docTitle').value = '史莱姆';
    }

    this.history.onChange(() => this.updateStatus());
    this.updateColorUI();
    this.updateStatus();
    this.renderer.fit();
    this.palettePanel.refresh();
    this.layersPanel.refresh();
    this.scriptPanel.syncGutter();
    this.requestRender();
    this.setAiBadge();

    window.addEventListener('beforeunload', () => this.save());
    setInterval(() => this.save(), 30000);
  }

  /* ── 渲染 ── */

  requestRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this.renderer.render();
    });
  }

  bindStageResize() {
    const stage = $('#stage');
    const resize = () => {
      const r = stage.getBoundingClientRect();
      const c = this.renderer.canvas;
      const w = Math.max(64, Math.round(r.width * this.dpr));
      const h = Math.max(64, Math.round(r.height * this.dpr));
      if (c.width === w && c.height === h) return;
      c.width = w;
      c.height = h;
      this.renderer.ctx.imageSmoothingEnabled = false;
      this.renderer.fit();
      this.requestRender();
    };
    new ResizeObserver(resize).observe(stage);
    resize();
  }

  /* ── 编辑后置 ── */

  afterEdit(structural = false) {
    this.doc.invalidate();
    if (structural) {
      this.renderer.setDocument(this.doc);
      this.renderer.fit();
      $('#stageBadge').textContent = `${this.doc.width} × ${this.doc.height}`;
      const sizeSel = $('#aiSize');
      if (sizeSel && [...sizeSel.options].some((o) => o.value === String(this.doc.width))) {
        sizeSel.value = String(this.doc.width);
      }
    }
    this.requestRender();
    this.updateStatus();
    this.layersPanel?.refresh();
    this.markDirty();
  }

  markDirty() {
    this._dirty = true;
    const t = $('#stPixels');
    if (t) t.textContent = `${this.doc.composite().opaqueCount()} 像素`;
  }

  scratch() {
    if (!this._scratch || this._scratch.width !== this.doc.width || this._scratch.height !== this.doc.height) {
      this._scratch = new PixelBuffer(this.doc.width, this.doc.height);
    } else {
      this._scratch.clear({ r: 0, g: 0, b: 0, a: 0 });
    }
    return this._scratch;
  }

  warn(msg) { toast(msg, 'warn'); }

  /* ── 颜色 ── */

  colorIndex(c) {
    return this.doc.palette.colors.findIndex((x) => x.r === c.r && x.g === c.g && x.b === c.b && x.a === c.a);
  }

  setPrimaryIndex(i) {
    const c = this.doc.palette.colors[i];
    if (!c) return;
    this.primaryIndex = i;
    this.primary = { ...c };
    this.updateColorUI();
  }

  setColor(c) {
    const i = this.colorIndex(c);
    this.primary = { ...c };
    this.primaryIndex = i;
    this.updateColorUI();
    if (i >= 0) toast(`取色 c${i} ${rgbaToHex(c)}`, 'ok', 1200);
  }

  swapColors() {
    [this.primary, this.secondary] = [this.secondary, this.primary];
    [this.primaryIndex, this.secondaryIndex] = [this.secondaryIndex, this.primaryIndex];
    this.updateColorUI();
  }

  updateColorUI() {
    const p = this.primary, s = this.secondary;
    const bg = (c) => `linear-gradient(${rgbaToHex(c)}, ${rgbaToHex(c)})`;
    $('#swPrimary').style.background = `${bg(p)}, conic-gradient(#2b2b33 25%, #3a3a44 0 50%, #2b2b33 0 75%, #3a3a44 0)`;
    $('#swSecondary').style.background = `${bg(s)}, conic-gradient(#2b2b33 25%, #3a3a44 0 50%, #2b2b33 0 75%, #3a3a44 0)`;
    $('#idxPrimary').textContent = this.primaryIndex >= 0 ? `c${this.primaryIndex}` : rgbaToHex(p);
    $('#idxSecondary').textContent = this.secondaryIndex >= 0 ? `c${this.secondaryIndex}` : rgbaToHex(s);
    $('#stColor').textContent = `${this.primaryIndex >= 0 ? `c${this.primaryIndex}` : ''} ${rgbaToHex(p)}`.trim();
  }

  /* ── 状态栏 ── */

  updateHud(p) {
    $('#stCoords').textContent = `${p.x}, ${p.y}`;
    $('#stageHud').textContent = `x ${p.x}  y ${p.y}`;
  }

  updateStatus() {
    $('#zoomReadout').textContent = `${Math.round((this.renderer.scale / this.dpr) * 100)}%`;
    $('#stTool').textContent = this.tools.name;
    $('#stSize').textContent = `${this.doc.width} × ${this.doc.height}`;
    $('#stHistory').textContent = `历史 ${this.history.undoStack.length}`;
    $('#btnUndo').disabled = !this.history.canUndo;
    $('#btnRedo').disabled = !this.history.canRedo;
  }

  onToolChange(t) {
    $$('.tool[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
    this.updateStatus();
  }

  refreshLayers() {
    this.layersPanel?.refresh();
    this.updateStatus();
  }

  setAiBadge() {
    const elx = $('#stAi');
    if (this.config.demoMode) {
      elx.textContent = '演示模式（未配置 API Key）';
      elx.className = 'st-ai';
    } else {
      elx.textContent = `在线 · ${this.config.model}`;
      elx.className = 'st-ai online';
    }
  }

  /* ── 顶栏 ── */

  bindTopbar() {
    $('#btnUndo').addEventListener('click', () => { this.history.undo(); this.afterEdit(true); });
    $('#btnRedo').addEventListener('click', () => { this.history.redo(); this.afterEdit(true); });

    const zoom = (f) => { this.renderer.zoomAt(f); this.requestRender(); this.updateStatus(); };
    $('#btnZoomIn').addEventListener('click', () => zoom(1.25));
    $('#btnZoomOut').addEventListener('click', () => zoom(1 / 1.25));
    $('#btnFit').addEventListener('click', () => { this.renderer.fit(); this.requestRender(); this.updateStatus(); });

    $('#btnGrid').addEventListener('click', (e) => {
      this.renderer.grid = !this.renderer.grid;
      e.currentTarget.classList.toggle('on', this.renderer.grid);
      this.requestRender();
    });
    $('#btnGrid').classList.toggle('on', this.renderer.grid);

    for (const b of $$('#segSym button')) {
      b.addEventListener('click', () => {
        this.doc.symmetry = b.dataset.sym;
        $$('#segSym button').forEach((x) => x.classList.toggle('on', x === b));
        this.requestRender();
      });
    }

    $('#btnSwap').addEventListener('click', () => this.swapColors());
    $('#colorPrimary').addEventListener('click', () => this.palettePanel.select(this.primaryIndex >= 0 ? this.primaryIndex : 0));
    $('#colorSecondary').addEventListener('click', () => this.palettePanel.select(this.secondaryIndex >= 0 ? this.secondaryIndex : 0));

    $('#docTitle').addEventListener('input', (e) => { this.doc.title = e.target.value; this.markDirty(); });

    $('#btnNew').addEventListener('click', () => this.newDocumentDialog());
    $('#btnImport').addEventListener('click', () => $('#filePicker').click());
    $('#filePicker').addEventListener('change', (e) => this.importFile(e.target.files?.[0]));
    $('#btnExport').addEventListener('click', () => this.exportDialog());
    $('#btnSettings').addEventListener('click', () => this.settingsDialog());

    for (const b of $$('.tool[data-tool]')) {
      b.addEventListener('click', () => this.tools.setTool(b.dataset.tool));
    }
  }

  bindTabs() {
    for (const tab of $$('#tabs .tab')) {
      tab.addEventListener('click', () => {
        $$('#tabs .tab').forEach((t) => t.classList.toggle('on', t === tab));
        $$('.pane').forEach((p) => p.classList.toggle('on', p.dataset.pane === tab.dataset.tab));
      });
    }
  }

  bindKeys() {
    const isTyping = (e) => {
      const t = e.target;
      return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    };

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !isTyping(e)) { this.spaceDown = true; $('#stage').classList.add('panning'); }
      if (isTyping(e)) {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); this.exportDialog(); }
        return;
      }
      const ctrl = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();

      if (ctrl && k === 'z' && !e.shiftKey) { e.preventDefault(); this.history.undo(); this.afterEdit(true); return; }
      if (ctrl && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); this.history.redo(); this.afterEdit(true); return; }
      if (ctrl && k === 's') { e.preventDefault(); this.exportDialog(); return; }
      if (ctrl && k === 'g') { e.preventDefault(); $('#btnGrid').click(); return; }

      switch (k) {
        case 'b': this.tools.setTool('pencil'); break;
        case 'e': this.tools.setTool('eraser'); break;
        case 'g': this.tools.setTool('bucket'); break;
        case 'i': this.tools.setTool('dropper'); break;
        case 'l': this.tools.setTool('line'); break;
        case 'r': this.tools.setTool('rect'); break;
        case 'o': this.tools.setTool('circle'); break;
        case 'm': this.tools.setTool('select'); break;
        case 'x': this.swapColors(); break;
        case '0': this.renderer.fit(); this.requestRender(); this.updateStatus(); break;
        case 'delete': case 'backspace':
          e.preventDefault();
          if (this.tools.deleteSelection()) e.stopPropagation();
          break;
        case 'escape': this.tools.clearSelection(); break;
        case '+': case '=': this.renderer.zoomAt(1.25); this.requestRender(); this.updateStatus(); break;
        case '-': this.renderer.zoomAt(1 / 1.25); this.requestRender(); this.updateStatus(); break;
        default:
          if (/^[1-8]$/.test(k)) this.setPrimaryIndex(Number(k) - 1);
          break;
      }
    });

    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') { this.spaceDown = false; $('#stage').classList.remove('panning'); }
    });
  }

  /* ── 文件 ── */

  newDocumentDialog() {
    const sizes = [16, 24, 32, 48, 64, 96, 128, 256];
    const body = el('div', {}, [
      el('p', { text: '选择新画布尺寸（会清空当前内容，可用 Ctrl+Z 撤销）' }),
      el('div', { class: 'size-grid' }, sizes.map((s) => el('button', {
        class: `size-card${s === this.doc.width ? ' on' : ''}`,
        text: `${s}²`,
        onclick: (e) => {
          body.querySelectorAll('.size-card').forEach((c) => c.classList.remove('on'));
          e.currentTarget.classList.add('on');
          body.dataset.size = String(s);
        },
      }))),
    ]);
    body.dataset.size = String(this.doc.width);
    modal({
      title: '新建画布',
      body,
      actions: [
        { label: '取消', kind: 'ghost' },
        {
          label: '创建',
          kind: 'primary',
          onClick: () => {
            const s = Number(body.dataset.size) || 32;
            this.history.begin('新建画布');
            this.doc.resize(s, s);
            for (const l of this.doc.layers) l.buffer.clear({ r: 0, g: 0, b: 0, a: 0 });
            this.history.commit();
            this.afterEdit(true);
            toast(`已创建 ${s}×${s} 画布`, 'ok');
          },
        },
      ],
    });
  }

  async importFile(file) {
    if (!file) return;
    const name = file.name.toLowerCase();
    try {
      if (name.endsWith('.pxs') || name.endsWith('.txt') || file.type.startsWith('text/')) {
        const text = await readTextFile(file);
        this.applyScript(text);
        toast('脚本已载入并执行', 'ok');
        return;
      }
      if (file.type.startsWith('image/')) {
        const dataURL = await readDataURL(file);
        await this.pixelizeImage(dataURL);
        toast('图片已转换为像素画', 'ok');
        return;
      }
      toast('不支持的文件类型', 'warn');
    } catch (err) {
      toast(`导入失败：${err.message}`, 'err');
    } finally {
      $('#filePicker').value = '';
    }
  }

  /** 把任意图片降采样到当前画布尺寸，并吸附到调色板 */
  async pixelizeImage(dataURL) {
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('图片解码失败'));
      im.src = dataURL;
    });

    const body = el('div', { class: 'grid2' }, [
      el('label', { class: 'switch' }, [el('input', { type: 'checkbox', id: 'pxQuantize', checked: true }), el('span', { text: '吸附到当前调色板' })]),
      el('label', { class: 'mini-field wide' }, [el('span', { text: '渐隐阈值' }), el('input', { type: 'number', id: 'pxAlpha', value: '128', min: '0', max: '255' })]),
    ]);

    await new Promise((resolve) => {
      modal({
        title: '导入图片',
        body: el('div', {}, [
          el('p', { text: `图片将被缩放到 ${this.doc.width}×${this.doc.height} 并转为像素画。` }),
          body,
          el('img', { src: dataURL, style: { maxWidth: '100%', maxHeight: '220px', imageRendering: 'pixelated', border: '1px solid var(--line)', borderRadius: '8px' } }),
        ]),
        actions: [
          { label: '取消', kind: 'ghost', onClick: resolve },
          { label: '转换', kind: 'primary', onClick: () => { this._doPixelize(img); resolve(); } },
        ],
      });
    });
  }

  _doPixelize(img) {
    const quantize = $('#pxQuantize')?.checked ?? true;
    const alphaCut = Number($('#pxAlpha')?.value ?? 128);
    const { width: w, height: h } = this.doc;

    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingEnabled = true;
    g.clearRect(0, 0, w, h);
    const scale = Math.min(w / img.width, h / img.height);
    const dw = Math.max(1, Math.round(img.width * scale));
    const dh = Math.max(1, Math.round(img.height * scale));
    g.drawImage(img, Math.round((w - dw) / 2), Math.round((h - dh) / 2), dw, dh);
    const data = g.getImageData(0, 0, w, h).data;

    this.history.begin('导入图片');
    const buf = this.doc.activeLayer.buffer;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        let col = { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] >= alphaCut ? 255 : 0 };
        if (col.a === 0) { buf.set(x, y, { r: 0, g: 0, b: 0, a: 0 }); continue; }
        if (quantize) col = this.nearestPalette(col);
        buf.set(x, y, col);
      }
    }
    this.history.commit();
    this.afterEdit(true);
  }

  nearestPalette(c) {
    let best = c, bestD = Infinity;
    for (const p of this.doc.palette.colors) {
      if (p.a === 0) continue;
      const d = (p.r - c.r) ** 2 + (p.g - c.g) ** 2 + (p.b - c.b) ** 2;
      if (d < bestD) { bestD = d; best = p; }
    }
    return { r: best.r, g: best.g, b: best.b, a: 255 };
  }

  exportDialog() {
    const scales = [1, 2, 4, 8, 16];
    const body = el('div', {}, [
      el('p', { text: `源尺寸 ${this.doc.width}×${this.doc.height}，导出为最近邻放大的 PNG。` }),
      el('div', { class: 'size-grid' }, scales.map((s) => el('button', {
        class: `size-card${s === 4 ? ' on' : ''}`,
        text: `${s}×`,
        onclick: (e) => {
          body.querySelectorAll('.size-card').forEach((x) => x.classList.remove('on'));
          e.currentTarget.classList.add('on');
          body.dataset.scale = String(s);
        },
      }))),
      el('label', { class: 'switch' }, [el('input', { type: 'checkbox', id: 'exBg' }), el('span', { text: '垫白底（透明区域变白）' })]),
      el('label', { class: 'switch' }, [el('input', { type: 'checkbox', id: 'exFull', checked: true }), el('span', { text: '忽略当前视口缩放（按源尺寸导出）' })]),
    ]);
    body.dataset.scale = '4';

    modal({
      title: '导出',
      body,
      actions: [
        { label: '导出 .pxs 脚本', kind: 'ghost', onClick: () => this.exportScript() },
        {
          label: '导出 PNG',
          kind: 'primary',
          onClick: () => {
            const s = Number(body.dataset.scale) || 4;
            const bg = $('#exBg')?.checked ?? false;
            const { dataURL, width, height } = this.renderer.export(Math.max(this.doc.width, this.doc.height) * s, bg);
            downloadDataURL(`${this.doc.title || 'pixelscribe'}_${width}x${height}.png`, dataURL);
            toast(`已导出 ${width}×${height} PNG`, 'ok');
          },
        },
      ],
    });
  }

  exportScript() {
    const code = this.scriptPanel.getValue().trim();
    downloadText(`${this.doc.title || 'pixelscribe'}.pxs`, code || '# 空脚本\n', 'text/plain');
    toast('脚本已导出', 'ok');
  }

  settingsDialog() {
    const st = this.settings;
    const body = el('div', {}, [
      el('p', { html: `服务端状态：<b>${this.config.demoMode ? '未配置 API Key（演示模式）' : '已就绪'}</b><br>默认端点 <code>${this.config.baseUrl || '—'}</code>，模型 <code>${this.config.model || '—'}</code>` }),
      el('div', { class: 'field' }, [
        el('label', { text: '启用前端直连（Key 仅保存在本机 sessionStorage）' }),
        el('label', { class: 'switch' }, [el('input', { type: 'checkbox', id: 'setDirect', checked: st.directMode }), el('span', { text: '直连模式' })]),
      ]),
      el('div', { class: 'grid2' }, [
        el('div', { class: 'field' }, [el('label', { text: 'Base URL' }), el('input', { type: 'text', id: 'setBase', value: st.baseUrl, spellcheck: 'false' })]),
        el('div', { class: 'field' }, [el('label', { text: '模型名' }), el('input', { type: 'text', id: 'setModel', value: st.model, spellcheck: 'false' })]),
      ]),
      el('div', { class: 'field' }, [el('label', { text: 'API Key' }), el('input', { type: 'password', id: 'setKey', value: st.apiKey, spellcheck: 'false', placeholder: 'sk-...' })]),
      el('div', { class: 'grid2' }, [
        el('div', { class: 'field' }, [el('label', { text: '温度' }), el('input', { type: 'number', id: 'setTemp', value: String(st.temperature), step: '0.1', min: '0', max: '2' })]),
        el('div', { class: 'field' }, [el('label', { text: '回灌长边 (px)' }), el('input', { type: 'number', id: 'setVision', value: String(st.visionLongEdge), min: '64', max: '1024' })]),
      ]),
      el('p', { text: '提示：生产环境建议保持直连模式关闭，把 Key 放在服务端 .env 中。' }),
    ]);

    modal({
      title: '设置',
      body,
      actions: [
        { label: '恢复默认', kind: 'ghost', close: false, onClick: () => { this.settings = { ...this.defaultSettings() }; this.saveSettings(); toast('已恢复默认设置', 'ok'); } },
        {
          label: '保存',
          kind: 'primary',
          onClick: () => {
            this.settings = {
              directMode: $('#setDirect').checked,
              baseUrl: $('#setBase').value.trim() || 'https://api.openai.com/v1',
              model: $('#setModel').value.trim(),
              apiKey: $('#setKey').value.trim(),
              temperature: Number($('#setTemp').value) || 0.6,
              visionLongEdge: Number($('#setVision').value) || 384,
            };
            this.saveSettings();
            this.setAiBadge();
            toast('设置已保存', 'ok');
          },
        },
      ],
    });
  }

  /* ── 脚本 ── */

  /** 载入并立即执行（用于导入 .pxs） */
  applyScript(code) {
    this.scriptPanel.setValue(code);
    this.history.begin('载入脚本');
    const r = runScript(code, this.doc, { mode: 'replace' });
    this.history.commit();
    if (!r.ok) toast(r.errors[0], 'warn', 3600);
    this.afterEdit(true);
    return r;
  }

  /** 把脚本载入编辑器（不执行，避免覆盖当前画面） */
  loadScript(code) {
    this.scriptPanel.setValue(code);
    $$('#tabs .tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === 'script'));
    $$('.pane').forEach((p) => p.classList.toggle('on', p.dataset.pane === 'script'));
    toast('脚本已载入编辑器，Ctrl+Enter 运行', 'ok', 2200);
  }

  /* ── 持久化 ── */

  defaultSettings() {
    return {
      directMode: false,
      baseUrl: this.config.baseUrl || 'https://api.openai.com/v1',
      model: this.config.model || 'gpt-4o-mini',
      apiKey: '',
      temperature: this.config.temperature ?? 0.6,
      visionLongEdge: this.config.visionLongEdge ?? 384,
      maxIterations: this.config.maxIterations ?? 6,
    };
  }

  loadSettings() {
    const base = {
      directMode: false,
      baseUrl: this.config?.baseUrl || 'https://api.openai.com/v1',
      model: this.config?.model || 'gpt-4o-mini',
      apiKey: '',
      temperature: this.config?.temperature ?? 0.6,
      visionLongEdge: this.config?.visionLongEdge ?? 384,
      maxIterations: this.config?.maxIterations ?? 6,
    };
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      const key = sessionStorage.getItem('pixelscribe.key') || '';
      return { ...base, ...saved, apiKey: key };
    } catch { return base; }
  }

  saveSettings() {
    const { apiKey, ...rest } = this.settings;
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(rest));
      if (apiKey) sessionStorage.setItem('pixelscribe.key', apiKey);
      else sessionStorage.removeItem('pixelscribe.key');
    } catch { /* 隐私模式 */ }
  }

  save() {
    if (!this._dirty) return;
    try {
      const payload = {
        doc: this.doc.toJSON(),
        script: this.scriptPanel?.getValue() ?? '',
        camera: { scale: this.renderer.scale, offsetX: this.renderer.offsetX, offsetY: this.renderer.offsetY },
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      this._dirty = false;
    } catch {
      /* 超配额时静默失败 */
    }
  }

  restore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const payload = JSON.parse(raw);
      const doc = PixelDocument.fromJSON(payload.doc);
      this.doc = doc;
      this.history = new History(doc, 120);
      this.renderer.setDocument(doc);
      if (payload.camera) Object.assign(this.renderer, payload.camera);
      $('#docTitle').value = doc.title;
      this.primaryIndex = 0;
      this.primary = { ...doc.palette.colors[0] };
      this.secondary = { ...doc.palette.colors[Math.min(7, doc.palette.colors.length - 1)] };
      this.secondaryIndex = Math.min(7, doc.palette.colors.length - 1);
      if (payload.script) this.scriptPanel.setValue(payload.script);
      $('#stageBadge').textContent = `${doc.width} × ${doc.height}`;
      const preset = Object.entries({ pico8: 'PICO-8', gameboy: 'Game Boy', cga: 'CGA / DOS', gray: 'Grayscale 8', bw: 'Black & White' })
        .find(([, v]) => v === doc.palette.label);
      if (preset) $('#palettePreset').value = preset[0];
      toast('已从本地恢复上次会话', 'ok', 1800);
      return true;
    } catch {
      return false;
    }
  }
}
