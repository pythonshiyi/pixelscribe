/**
 * 风格预设（v2.3）
 * ---------------------------------------------------------------
 * 把「文档风格 + DSL 渲染指令 + 神经后端提示」打包成一个可命名的预设，
 * 便于一键复用与在项目间共享。预设是纯数据，可 JSON 持久化。
 */

import { PixelDocument } from '../core/document.js';
import { runScript } from '../lang/compiler.js';
import { Palette } from './palette.js';

/** 内置风格预设。 */
export const STYLE_PRESETS = Object.freeze([
  {
    id: 'pixel-clean',
    name: '像素 · 清爽',
    style: 'pixel',
    palette: 'pico8',
    script: '',
    note: '硬边有限色板，无光照。适合图标、角色、UI。',
  },
  {
    id: 'pixel-dither',
    name: '像素 · 抖动渐变',
    style: 'pixel',
    palette: 'gameboy',
    script: 'graddither 0 0 100% 100% c1 c3 bayer v',
    note: '有序抖动做明暗过渡，保留像素味。',
  },
  {
    id: 'painting',
    name: '手绘 · 油画',
    style: 'painting',
    palette: 'pico8',
    script: 'light -1 -1 1 1\nrelief 0.9 0.35\ntone 1.05 1.12 1.08 0 0.12\nrender painting',
    note: '大色块 + 浮雕塑形 + 相机色调。',
  },
  {
    id: 'ink',
    name: '水墨 · 线稿',
    style: 'ink',
    palette: 'bw',
    script: 'map 0 0 100% 100% gray 1\ntone 1.2 1.4 0.2 0 0.2\nrender ink',
    note: '单色高对比，适合线稿与留白。',
  },
  {
    id: 'anime',
    name: '动画 · 赛璐璐',
    style: 'anime',
    palette: 'pico8',
    script: 'light -1 -1 1 1\nbloom 0.75 0.5 2\ntone 1.05 1.1 1.15 0.02 0.1\nrender anime',
    note: '平涂 + 明确描边 + 高光溢出。',
  },
  {
    id: 'clay',
    name: '3D · 黏土',
    style: '3d',
    palette: 'pico8',
    script: 'light -1 -1 1 1\nrelief 1.0 0.4\nspecular 0.5 12\ntone 1.0 1.15 1.05 0.02 0.18\nrender 3d',
    note: '体积感与柔和高光。',
  },
  {
    id: 'photo',
    name: '写实 · 照片',
    style: 'photo',
    palette: 'pico8',
    script: 'light -1 -1 1 1\nfbm 0 0 100% 100% c1 c5 4 8 mod\nrelief 0.9 0.3\nspecular 0.6 16\nbloom 0.7 0.5 2\ntone 1.08 1.12 1.05 0 0.15\nrender photo',
    note: '分形材质 + 光照 + 色调，交给神经后端补细节。',
  },
]);

/** @param {string} id */
export function getStylePreset(id) {
  return STYLE_PRESETS.find((p) => p.id === id) || null;
}

/**
 * 应用风格预设到文档（可选：把预设脚本作为增量执行）。
 * @param {PixelDocument} doc
 * @param {string|object} presetOrId
 * @param {{applyScript?:boolean, script?:string}} [opts]
 * @returns {{ok:boolean, preset:object|null, report?:any}}
 */
export function applyStylePreset(doc, presetOrId, opts = {}) {
  const preset = typeof presetOrId === 'string' ? getStylePreset(presetOrId) : presetOrId;
  if (!preset) return { ok: false, preset: null };
  doc.style = preset.style || 'pixel';
  let report = null;
  if (preset.palette) {
    try { doc.palette = Palette.from(preset.palette); } catch { /* 未知预设忽略 */ }
  }
  const script = opts.script ?? preset.script;
  if ((opts.applyScript !== false) && script && script.trim()) {
    report = runScript(script, doc, { mode: 'append', deferRender: true });
  }
  doc.invalidate();
  return { ok: true, preset, report };
}

/** 把预设序列化为可分享的 JSON 文本。 */
export function serializeStylePreset(preset) {
  return JSON.stringify({
    id: preset.id, name: preset.name, style: preset.style,
    palette: preset.palette, script: preset.script || '', note: preset.note || '',
  }, null, 2);
}

/** 从 JSON 文本解析预设（宽松校验）。 */
export function parseStylePreset(text) {
  const j = JSON.parse(text);
  if (!j || typeof j !== 'object' || !j.name) throw new Error('预设缺少 name 字段');
  return {
    id: j.id || `custom-${Date.now().toString(36)}`,
    name: String(j.name),
    style: j.style || 'pixel',
    palette: j.palette || 'pico8',
    script: String(j.script || ''),
    note: String(j.note || ''),
  };
}
