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
  const collapsedGroups = new Set();

  $('#btnAddLayer').addEventListener('click', () => {
    app.history.begin('新建图层');
    app.doc.addLayer();
    selectOnly(app.doc.activeLayer);
    app.history.commit();
    refresh();
    app.afterEdit();
  });

  $('#btnDeleteLayer').addEventListener('click', () => {
    const targets = selectedLayerIndices();
    if (targets.length >= app.doc.layers.length) { toast('至少保留一个图层', 'warn'); return; }
    app.history.begin('删除图层');
    for (const i of targets.sort((a, b) => b - a)) app.doc.removeLayer(i);
    app.selectedLayerIds = new Set([app.doc.activeLayer.id]);
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

  $('#btnGroupLayer')?.addEventListener('click', () => {
    const ids = [...app.selectedLayerIds];
    if (!ids.length) { toast('请先选中图层', 'warn'); return; }
    app.history.begin('编组');
    const g = app.doc.groupLayers(ids);
    app.history.commit();
    refresh();
    app.afterEdit();
    if (g) toast(`已编组 ${ids.length} 个图层`, 'ok', 1600);
  });

  opacity.addEventListener('input', () => {
    const v = Number(opacity.value) / 100;
    opacityVal.textContent = `${opacity.value}%`;
    for (const l of selectedLayers()) l.opacity = v;
    app.doc.invalidate();
    app.requestRender();
    app.markDirty();
  });
  opacity.addEventListener('change', () => { refreshThumbs(); });

  locked.addEventListener('change', () => {
    for (const l of selectedLayers()) l.locked = locked.checked;
    refresh();
  });

  function selectedLayers() {
    const out = app.doc.layers.filter((l) => app.selectedLayerIds.has(l.id));
    return out.length ? out : [app.doc.activeLayer];
  }

  function selectedLayerIndices() {
    const ids = app.selectedLayerIds;
    const idx = [];
    app.doc.layers.forEach((l, i) => { if (ids.has(l.id)) idx.push(i); });
    return idx.length ? idx : [app.doc.activeLayerIndex];
  }

  function selectOnly(layer) {
    app.selectedLayerIds = new Set([layer.id]);
  }

  function refreshThumbs() {
    const thumbs = $$('.layer-thumb', list);
    let k = 0;
    for (let i = app.doc.layers.length - 1; i >= 0; i--) {
      const t = thumbs[k];
      k++;
      if (t && t.tagName === 'IMG') t.src = thumbURL(app.doc.layers[i]);
    }
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

  /** 图层 + 组头，按显示顺序（顶层在上）。 */
  function refresh() {
    list.replaceChildren();
    const layers = app.doc.layers;
    const shownGroups = new Set();
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i];
      const groupId = layer.group;
      const isGroupLast = groupId && (i === 0 || layers[i - 1].group !== groupId);
      const isGroupFirstShown = groupId && !shownGroups.has(groupId);

      if (isGroupFirstShown) shownGroups.add(groupId);
      if (groupId && isGroupLast) {
        const g = app.doc.getGroup(groupId);
        list.append(buildGroupHeader(g, groupId));
      }

      const index = i;
      const isSel = app.selectedLayerIds.has(layer.id);
      const item = el('div', { class: `layer-item${index === app.doc.activeLayerIndex ? ' on' : ''}${isSel ? ' selected' : ''}` }, [
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

      item.addEventListener('click', (e) => {
        app.doc.activeLayerIndex = index;
        if (e.shiftKey && app._layerAnchor != null) {
          const a = Math.min(app._layerAnchor, index), b = Math.max(app._layerAnchor, index);
          app.selectedLayerIds = new Set(layers.slice(a, b + 1).map((l) => l.id));
        } else if (e.ctrlKey || e.metaKey) {
          if (app.selectedLayerIds.has(layer.id) && app.selectedLayerIds.size > 1) app.selectedLayerIds.delete(layer.id);
          else app.selectedLayerIds.add(layer.id);
          app._layerAnchor = index;
        } else {
          selectOnly(layer);
          app._layerAnchor = index;
        }
        refresh();
        app.updateStatus();
      });
      const nameEl = item.querySelector('.layer-name');
      nameEl.addEventListener('dblclick', () => {
        nameEl.contentEditable = 'true';
        nameEl.focus();
        document.getSelection()?.selectAllContents?.(nameEl);
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
    }

    const sel = selectedLayers();
    const al = sel[0] || app.doc.activeLayer;
    const sameOpacity = sel.every((l) => Math.abs(l.opacity - al.opacity) < 1e-6);
    opacity.value = String(Math.round(al.opacity * 100));
    opacityVal.textContent = sameOpacity ? `${Math.round(al.opacity * 100)}%` : '混合';
    locked.checked = sel.every((l) => l.locked);
    $('#btnDeleteLayer').disabled = selectedLayerIndices().length >= app.doc.layers.length;
    $('#btnMergeLayer').disabled = app.doc.activeLayerIndex === 0;
    const cnt = $('#layerSelCount');
    if (cnt) cnt.textContent = sel.length > 1 ? `已选 ${sel.length}` : '';
  }

  function buildGroupHeader(g, groupId) {
    if (!g) return el('span');
    const collapsed = g.collapsed || collapsedGroups.has(groupId);
    const kids = app.doc.layersInGroup(groupId);
    const anyVisible = kids.some((l) => l.visible);
    return el('div', { class: `layer-group${collapsed ? ' collapsed' : ''}` }, [
      el('button', {
        class: 'layer-group-toggle',
        title: collapsed ? '展开组' : '折叠组',
        text: collapsed ? '▸' : '▾',
        onclick: (e) => {
          e.stopPropagation();
          g.collapsed = !collapsed;
          refresh();
        },
      }),
      el('button', {
        class: `layer-eye${anyVisible ? '' : ' off'}`,
        title: anyVisible ? '隐藏组' : '显示组',
        onclick: (e) => {
          e.stopPropagation();
          const next = !anyVisible;
          for (const l of kids) l.visible = next;
          app.doc.invalidate();
          refresh();
          app.requestRender();
          app.markDirty();
        },
      }, [el('svg', {}, [el('use', { href: anyVisible ? '#i-eye' : '#i-eyeoff' })])]),
      el('span', {
        class: 'layer-group-name',
        text: g.name,
        title: '双击重命名，右键解散',
        onclick: (e) => {
          e.stopPropagation();
          app.selectedLayerIds = new Set(kids.map((l) => l.id));
          refresh();
        },
        oncontextmenu: (e) => {
          e.preventDefault();
          app.history.begin('解散图层组');
          app.doc.removeGroup(groupId);
          app.history.commit();
          refresh();
          app.afterEdit();
          toast('已解散图层组', 'ok', 1400);
        },
        ondblclick: (e) => {
          const t = e.currentTarget;
          t.contentEditable = 'true';
          t.focus();
          document.getSelection()?.selectAllContents?.(t);
        },
        onblur: (e) => {
          const t = e.currentTarget;
          t.contentEditable = 'false';
          g.name = t.textContent.trim() || g.name;
          t.textContent = g.name;
          app.markDirty();
        },
      }),
      el('span', { class: 'layer-meta', text: `${kids.length} 层` }),
    ]);
  }

  return { refresh, refreshThumbs, selectedLayers };
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
