/**
 * 右侧面板：图层 / 色板 / 脚本
 */

import { $, $$, el, toast, modal, debounce, downloadText } from './dom.js';
import { Palette } from '../core/palette.js';
import { rgbaToHex, hexToRgba } from '../util/color.js';
import { checkSyntax, runScript } from '../lang/compiler.js';
import { SAMPLES } from '../samples.js';

/* ══════════════════════ 图层 ══════════════════════ */

export function initLayers(app) {
  const list = $('#layerList');
  const opacity = $('#layerOpacity');
  const opacityVal = $('#layerOpacityVal');
  const locked = $('#layerLocked');

  $('#btnAddLayer').addEventListener('click', () => {
    app.history.begin('新建图层');
    app.doc.addLayer();
    app.history.commit();
    refresh();
    app.afterEdit();
  });

  $('#btnDeleteLayer').addEventListener('click', () => {
    if (app.doc.layers.length <= 1) { toast('至少保留一个图层', 'warn'); return; }
    app.history.begin('删除图层');
    app.doc.removeLayer();
    app.history.commit();
    refresh();
    app.afterEdit();
  });

  $('#btnMergeLayer').addEventListener('click', () => {
    app.history.begin('合并图层');
    if (!app.doc.mergeDown()) { app.history.rollback(); toast('最底层无法向下合并', 'warn'); return; }
    app.history.commit();
    refresh();
    app.afterEdit();
  });

  opacity.addEventListener('input', () => {
    const v = Number(opacity.value) / 100;
    opacityVal.textContent = `${opacity.value}%`;
    app.doc.activeLayer.opacity = v;
    app.doc.invalidate();
    app.requestRender();
    app.markDirty();
  });
  opacity.addEventListener('change', () => { refreshThumbs(); });

  locked.addEventListener('change', () => {
    app.doc.activeLayer.locked = locked.checked;
    refresh();
  });

  function refreshThumbs() {
    const thumbs = $$('.layer-thumb', list);
    [...app.doc.layers].reverse().forEach((l, i) => {
      const t = thumbs[i];
      if (!t) return;
      t.src = thumbURL(l);
    });
  }

  function thumbURL(layer) {
    const { width: w, height: h } = app.doc;
    const out = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < out.length; i++) out[i] = layer.buffer.data[i];
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').putImageData(new ImageData(out, w, h), 0, 0);
    return c.toDataURL();
  }

  function refresh() {
    list.replaceChildren();
    const layers = [...app.doc.layers].reverse();
    layers.forEach((layer, ri) => {
      const index = app.doc.layers.length - 1 - ri;
      const item = el('div', { class: `layer-item${index === app.doc.activeLayerIndex ? ' on' : ''}` }, [
        el('button', {
          class: `layer-eye${layer.visible ? '' : ' off'}`,
          title: layer.visible ? '隐藏' : '显示',
          onclick: (e) => {
            e.stopPropagation();
            layer.visible = !layer.visible;
            app.doc.invalidate();
            refresh();
            app.requestRender();
            app.markDirty();
          },
        }, [el('svg', {}, [el('use', { href: layer.visible ? '#i-eye' : '#i-eyeoff' })])]),
        el('img', { class: 'layer-thumb', src: thumbURL(layer), alt: '' }),
        el('span', { class: 'layer-name', text: layer.name, title: '双击重命名' }),
        layer.locked ? el('span', { class: 'layer-lock', text: '🔒' }) : null,
        el('span', { class: 'layer-meta', text: `${Math.round(layer.opacity * 100)}%` }),
      ]);

      item.addEventListener('click', () => {
        app.doc.activeLayerIndex = index;
        refresh();
        app.updateStatus();
      });
      const nameEl = item.querySelector('.layer-name');
      nameEl.addEventListener('dblclick', () => {
        nameEl.contentEditable = 'true';
        nameEl.focus();
        document.getSelection()?.selectAllChildren(nameEl);
      });
      nameEl.addEventListener('blur', () => {
        nameEl.contentEditable = 'false';
        layer.name = nameEl.textContent.trim() || layer.name;
        nameEl.textContent = layer.name;
        app.markDirty();
      });
      nameEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); }
      });

      list.append(item);
    });

    const al = app.doc.activeLayer;
    opacity.value = String(Math.round(al.opacity * 100));
    opacityVal.textContent = `${Math.round(al.opacity * 100)}%`;
    locked.checked = al.locked;
    $('#btnDeleteLayer').disabled = app.doc.layers.length <= 1;
    $('#btnMergeLayer').disabled = app.doc.activeLayerIndex === 0;
  }

  return { refresh, refreshThumbs };
}

/* ══════════════════════ 色板 ══════════════════════ */

export function initPalette(app) {
  const grid = $('#swatchGrid');
  const preset = $('#palettePreset');
  const colorInput = $('#paletteColorInput');
  const hexInput = $('#paletteHexInput');
  let editingIndex = 0;

  preset.addEventListener('change', () => {
    app.history.begin('切换调色板');
    app.doc.palette = Palette.from(preset.value);
    app.history.commit();
    refresh();
    app.afterEdit();
    toast(`已切换到 ${app.doc.palette.label}`);
  });

  $('#btnExtract').addEventListener('click', extract);
  $('#btnExtract2').addEventListener('click', extract);

  function extract() {
    const colors = Palette.extract(app.doc.composite(), 16, false);
    if (colors.length < 2) { toast('图像内容太少，无法提取色板', 'warn'); return; }
    app.history.begin('提取色板');
    app.doc.palette = new Palette(colors, {}, '提取色板');
    app.history.commit();
    preset.value = '';
    refresh();
    app.afterEdit();
    toast(`已提取 ${colors.length} 色`);
  }

  $('#btnAddColor').addEventListener('click', () => {
    if (app.doc.palette.colors.length >= 256) { toast('色板已达 256 色上限', 'warn'); return; }
    app.history.begin('新增颜色');
    app.doc.palette.colors.push({ r: 255, g: 255, b: 255, a: 255 });
    editingIndex = app.doc.palette.colors.length - 1;
    app.history.commit();
    refresh();
    app.afterEdit();
  });

  $('#btnAddPaletteColor').addEventListener('click', () => $('#btnAddColor').click());
  $('#btnApplyColor').addEventListener('click', applyColor);
  hexInput.addEventListener('change', () => {
    const c = hexToRgba(hexInput.value);
    if (!c) { toast('十六进制颜色格式不正确', 'warn'); return; }
    colorInput.value = rgbaToHex(c);
  });
  colorInput.addEventListener('input', () => { hexInput.value = colorInput.value; });

  function applyColor() {
    const c = hexToRgba(hexInput.value) || hexToRgba(colorInput.value);
    if (!c) { toast('颜色格式不正确', 'warn'); return; }
    app.history.begin('修改颜色');
    app.doc.palette.set(editingIndex, c);
    app.history.commit();
    refresh();
    app.afterEdit();
  }

  function select(index) {
    editingIndex = index;
    const c = app.doc.palette.colors[index];
    colorInput.value = rgbaToHex(c);
    hexInput.value = rgbaToHex(c);
    app.setPrimaryIndex(index);
    refresh();
  }

  function refresh() {
    grid.replaceChildren();
    app.doc.palette.colors.forEach((c, i) => {
      const cell = el('button', {
        class: `swatch-cell${i === editingIndex ? ' on' : ''}`,
        title: `${app.doc.palette.nameOf(i)} · ${rgbaToHex(c)}`,
        style: { background: rgbaToHex(c) },
        onclick: () => select(i),
      }, [el('span', { class: 'ci', text: `c${i}` })]);
      grid.append(cell);
    });
    if (preset.value && app.doc.palette.label !== Palette.from(preset.value).label) preset.value = '';
  }

  return { refresh, select, get editingIndex() { return editingIndex; } };
}

/* ══════════════════════ 脚本 ══════════════════════ */

export function initScript(app) {
  const editor = $('#scriptEditor');
  const gutter = $('#scriptGutter');
  const report = $('#scriptReport');

  const syncGutter = () => {
    const n = editor.value.split('\n').length;
    let s = '';
    for (let i = 1; i <= n; i++) s += `${i}\n`;
    gutter.textContent = s;
    gutter.scrollTop = editor.scrollTop;
  };
  editor.addEventListener('input', () => { syncGutter(); lint(); });
  editor.addEventListener('scroll', () => { gutter.scrollTop = editor.scrollTop; });
  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = editor.selectionStart, en = editor.selectionEnd;
      editor.value = `${editor.value.slice(0, s)}  ${editor.value.slice(en)}`;
      editor.selectionStart = editor.selectionEnd = s + 2;
      syncGutter();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); }
  });

  const lintNow = () => {
    const errors = checkSyntax(editor.value);
    if (!errors.length) {
      report.className = 'script-report';
      report.textContent = `${editor.value.split('\n').length} 行 · 语法检查通过（Ctrl+Enter 运行）`;
      return errors;
    }
    report.className = 'script-report bad';
    report.textContent = errors.slice(0, 8).map((e) => `line ${e.line}: ${e.message}`).join('\n');
    return errors;
  };
  const lint = debounce(lintNow, 260);

  function run() {
    const mode = $('#scriptReplace').checked ? 'replace' : 'append';
    app.history.begin('运行脚本');
    const r = runScript(editor.value, app.doc, { mode });
    app.history.commit();
    const lines = [
      `指令 ${r.ops} 条 · 改动 ${r.changed} px · 耗时 ${r.elapsedMs}ms`,
      ...r.errors.map((e) => `✗ ${e}`),
      ...r.warnings.map((w) => `⚠ ${w}`),
    ];
    report.className = `script-report ${r.ok ? 'ok' : 'bad'}`;
    report.textContent = lines.join('\n');
    if (r.ok) toast(`执行成功，改动 ${r.changed} 像素`, 'ok', 1600);
    app.afterEdit(true);
  }

  $('#btnRunScript').addEventListener('click', run);
  editor.parentElement.addEventListener('mousedown', (e) => e.stopPropagation());

  function format() {
    const out = editor.value
      .split(/\r?\n/)
      .map((l) => l.replace(/[ \t]+/g, ' ').trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n');
    editor.value = out.trim();
    syncGutter();
    lint();
  }
  $('#btnFormatScript').addEventListener('click', format);

  $('#btnCopyScript').addEventListener('click', async () => {
    try { await navigator.clipboard?.writeText(editor.value); } catch { /* 无剪贴板权限 */ }
    toast('脚本已复制', 'ok', 1500);
  });

  $('#btnSamples').addEventListener('click', () => {
    const body = el('div', { class: 'sample-list' });
    for (const s of SAMPLES) {
      body.append(el('button', {
        class: 'sample-item',
        onclick: () => {
          editor.value = s.code;
          syncGutter();
          lint();
          run();
          document.querySelector('#modalBackdrop').hidden = true;
        },
      }, [el('b', { text: s.name }), el('span', { text: s.desc })]));
    }
    modal({
      title: '示例库',
      body,
      actions: [{ label: '导出全部 (.pxs)', kind: 'ghost', onClick: () => downloadText('pixelscribe-samples.pxs', SAMPLES.map((s) => `# === ${s.name} ===\n${s.code}`).join('\n\n'), 'text/plain') }],
    });
  });

  return {
    setValue(code) { editor.value = code; syncGutter(); lintNow(); },
    getValue() { return editor.value; },
    lint: lintNow, lintDebounced: lint, syncGutter,
  };
}
