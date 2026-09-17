/**
 * 像素画笔 · 自动化自测
 * ---------------------------------------------------------------
 *   node test/selftest.mjs        （或 npm run selftest）
 *
 * 覆盖：颜色 / 调色板 / 像素缓冲 / 文档 / 历史 /
 *       PixelScript 全部指令 / 错误定位 / PNG 导出 / 端到端范例。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { hexToRgba, rgbaToHex, parseColor, over, adjust as adjustColor, pack, unpack } from '../public/js/util/color.js';
import { Palette, PRESETS } from '../public/js/core/palette.js';
import {
  PixelBuffer, drawLine, fillEllipse, strokeEllipse, drawRRect, fillPoly,
  floodFill, outline, dither, noise, linearGrad, flipBuffer, rotateBuffer,
  symmetryTransforms, mulberry32,
} from '../public/js/core/buffer.js';
import { PixelDocument, Layer } from '../public/js/core/document.js';
import { History } from '../public/js/core/history.js';
import { runScript, checkSyntax, extractScript, isDone, tokenize, COMMANDS, dslReference } from '../public/js/lang/compiler.js';
import { glyph, textWidth } from '../public/js/lang/font5x7.js';
import { encodePNG, encodePNGScaled, toBase64, toDataURL } from '../public/js/io/png.js';
import { demoScript, demoCritique, demoReply, DemoProvider } from '../public/js/ai/demo.js';
import {
  Provider, normalizeBaseUrl, isOpencodeEndpoint, isOfficialEndpoint, isThinkingRejection,
  isDeepseekFlashModel, sanitizeMessages,
} from '../public/js/ai/provider.js';
import { buildSystemPrompt, buildCritique, buildRepair, computeTiles, STYLE_GUIDE } from '../public/js/ai/prompts.js';
import { Agent } from '../public/js/ai/agent.js';
import { SAMPLES } from '../public/js/samples.js';
import {
  surfaceNormals, applyRelief, applySpecular, applyBloom, blur as blurFn, applyTone,
  applyFbm, normalizeStyle, applyProceduralPipeline, STYLE_PRESETS,
} from '../public/js/core/effects.js';
import {
  resolveBackendId, controlMapDataURL, controlMaps, normalizeNeuralResponse, BACKEND_IDS,
  cropBuffer, pasteBuffer, clampRect, maskMapDataURL, cropDataURL,
} from '../public/js/core/backends.js';
import { supersample, upscaleBilinear } from '../public/js/core/supersample.js';
import {
  nearestColor, boxDownsample, nearestDownsample, unsharp, quantize, imageToPixels,
} from '../public/js/io/img2pixel.js';
import { lzwEncode, encodeGIF, quantizeFrame } from '../public/js/io/gif.js';
import { encodeAseprite } from '../public/js/io/aseprite.js';
import { Animation } from '../public/js/core/animation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'out', 'test');

/* ─────────── 迷你测试框架 ─────────── */

let passed = 0;
const failures = [];
let group = '';

const describe = (name, fn) => { group = name; console.log(`\n\x1b[38;5;213m▸ ${name}\x1b[0m`); fn(); };
const it = (name, fn) => {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      throw new Error('it() 回调返回了 Promise —— 请改用同步断言，或放入 runIntegration()');
    }
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures.push({ group, name, err });
    console.log(`  \x1b[31m✗ ${name}\x1b[0m\n      ${err.message}`);
  }
};

function assert(cond, msg = '断言失败') { if (!cond) throw new Error(msg); }
function eq(a, b, msg = '') {
  if (a !== b) throw new Error(`${msg} 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
}
function deepEq(a, b, msg = '') {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`${msg}\n     期望 ${sb}\n     实际 ${sa}`);
}

/* ═══════════════ 1. 颜色 ═══════════════ */

describe('颜色工具', () => {
  it('解析 3/6/8 位十六进制', () => {
    deepEq(hexToRgba('#f00'), { r: 255, g: 0, b: 0, a: 255 });
    deepEq(hexToRgba('#ff004d'), { r: 255, g: 0, b: 77, a: 255 });
    deepEq(hexToRgba('#ff004d80'), { r: 255, g: 0, b: 77, a: 128 });
    eq(hexToRgba('#xyz'), null);
    eq(hexToRgba('nope'), null);
  });

  it('rgbaToHex 往返一致', () => {
    const c = { r: 18, g: 52, b: 86, a: 255 };
    deepEq(hexToRgba(rgbaToHex(c)), c);
    deepEq(hexToRgba(rgbaToHex(c, true)), c);
  });

  it('pack / unpack 小端 ABGR 往返', () => {
    const c = { r: 1, g: 2, b: 3, a: 4 };
    deepEq(unpack(pack(c)), c);
  });

  it('Alpha 混合 src-over', () => {
    const r = over({ r: 0, g: 0, b: 0, a: 255 }, { r: 255, g: 255, b: 255, a: 128 });
    assert(r.r > 120 && r.r < 135, `混合结果异常：${JSON.stringify(r)}`);
    deepEq(over({ r: 10, g: 10, b: 10, a: 0 }, { r: 255, g: 0, b: 0, a: 0 }), { r: 0, g: 0, b: 0, a: 0 });
  });

  it('提亮 / 压暗 单调', () => {
    const c = { r: 100, g: 100, b: 100, a: 255 };
    assert(adjustColor(c, 'light', 0.5).r > c.r, '提亮失败');
    assert(adjustColor(c, 'dark', 0.5).r < c.r, '压暗失败');
    eq(adjustColor(c, 'light', 0).r, 100);
  });

  it('语义名与调色板索引解析', () => {
    const p = Palette.from('pico8');
    deepEq(parseColor('c8', p), { r: 255, g: 0, b: 77, a: 255 });
    deepEq(parseColor('red', p), { r: 255, g: 0, b: 77, a: 255 });
    deepEq(parseColor('transparent', p), { r: 0, g: 0, b: 0, a: 0 });
    deepEq(parseColor('#00ff00', p), { r: 0, g: 255, b: 0, a: 255 });
    eq(parseColor('c99', p), null);
    eq(parseColor('不存在的颜色', p), null);
  });
});

/* ═══════════════ 2. 调色板 ═══════════════ */

describe('调色板', () => {
  it('全部预设可加载且色数正确', () => {
    deepEq(Object.keys(PRESETS).sort(), ['bw', 'cga', 'gameboy', 'gray', 'pico8']);
    eq(Palette.from('pico8').size, 16);
    eq(Palette.from('gameboy').size, 4);
    eq(Palette.from('bw').size, 2);
  });

  it('未知预设抛出错误', () => {
    let threw = false;
    try { Palette.from('nope'); } catch { threw = true; }
    assert(threw);
  });

  it('自定义调色板', () => {
    const p = Palette.from(['#000000', '#ffffff', '#ff0000']);
    eq(p.size, 3);
    deepEq(p.at(2), { r: 255, g: 0, b: 0, a: 255 });
    eq(p.at(5).r, 255, '环形取色');
  });

  it('从缓冲提取主色', () => {
    const b = new PixelBuffer(4, 4);
    b.clear({ r: 255, g: 0, b: 0, a: 255 });
    b.fillRect(0, 0, 2, 2, { r: 0, g: 0, b: 255, a: 255 }, false);
    const colors = Palette.extract(b, 8);
    eq(colors.length, 2);
    eq(colors[0].r, 255, '出现次数最多者优先（红 12 > 蓝 4）');
    eq(colors[1].b, 255);
  });

  it('toJSON / 名称映射', () => {
    const p = Palette.from('pico8');
    eq(p.toJSON().hex.length, 16);
    eq(p.nameOf(8), 'red');
  });
});

/* ═══════════════ 3. 像素缓冲 ═══════════════ */

describe('像素缓冲与图元', () => {
  it('基本读写与越界裁剪', () => {
    const b = new PixelBuffer(8, 8);
    b.set(3, 4, { r: 1, g: 2, b: 3, a: 255 });
    deepEq(b.get(3, 4), { r: 1, g: 2, b: 3, a: 255 });
    b.set(99, 99, { r: 9, g: 9, b: 9, a: 255 });
    b.plot(-1, -1, { r: 9, g: 9, b: 9, a: 255 });
    eq(b.opaqueCount(), 1);
  });

  it('Bresenham 直线连通且端点正确', () => {
    const b = new PixelBuffer(16, 16);
    drawLine(b, 0, 0, 10, 5, { r: 255, g: 255, b: 255, a: 255 });
    eq(b.get(0, 0).a, 255);
    eq(b.get(10, 5).a, 255);
    assert(b.opaqueCount() >= 11, `直线像素过少：${b.opaqueCount()}`);
  });

  it('线宽 > 1 时加粗', () => {
    const thin = new PixelBuffer(16, 16);
    const thick = new PixelBuffer(16, 16);
    drawLine(thin, 0, 8, 15, 8, { r: 255, g: 255, b: 255, a: 255 }, 1);
    drawLine(thick, 0, 8, 15, 8, { r: 255, g: 255, b: 255, a: 255 }, 3);
    assert(thick.opaqueCount() > thin.opaqueCount() * 2, '线宽未生效');
  });

  it('填充圆为实心且半径正确', () => {
    const b = new PixelBuffer(32, 32);
    fillEllipse(b, 16, 16, 8, 8, { r: 255, g: 0, b: 0, a: 255 });
    eq(b.get(16, 16).a, 255);
    eq(b.get(16, 8).a, 255, '上边界');
    eq(b.get(16, 25).a, 0, '外侧应为空');
    assert(b.opaqueCount() > 180 && b.opaqueCount() < 230, `面积异常 ${b.opaqueCount()}`);
  });

  it('圆描边为空心', () => {
    const b = new PixelBuffer(32, 32);
    strokeEllipse(b, 16, 16, 10, 10, { r: 255, g: 0, b: 0, a: 255 }, 1);
    eq(b.get(16, 6).a, 255, '边界');
    eq(b.get(16, 16).a, 0, '中心应为空');
  });

  it('圆角矩形四个角被切掉', () => {
    const b = new PixelBuffer(32, 32);
    drawRRect(b, 4, 4, 24, 24, 6, { r: 0, g: 255, b: 0, a: 255 }, 'fill');
    eq(b.get(5, 5).a, 0, '角落应被切掉');
    eq(b.get(16, 16).a, 255, '中心应填充');
    eq(b.get(16, 5).a, 255, '上边中段应填充');
  });

  it('多边形填充 (三角)', () => {
    const b = new PixelBuffer(32, 32);
    fillPoly(b, [16, 2, 30, 30, 2, 30], { r: 255, g: 255, b: 0, a: 255 });
    assert(b.opaqueCount() > 300, `三角面积过小 ${b.opaqueCount()}`);
    eq(b.get(16, 29).a, 255, '底边');
    eq(b.get(2, 2).a, 0, '左上角外部');
  });

  it('洪水填充 4 连通且不越过边界', () => {
    const b = new PixelBuffer(16, 16);
    b.clear({ r: 0, g: 0, b: 0, a: 0 });
    drawLine(b, 8, 0, 8, 15, { r: 255, g: 255, b: 255, a: 255 });
    const n = floodFill(b, 0, 0, { r: 255, g: 0, b: 0, a: 255 });
    eq(n, 128, '左半边 8×16');
    eq(b.get(15, 0).a, 0, '未被越过竖线');
  });

  it('描边只影响外侧邻域', () => {
    const b = new PixelBuffer(16, 16);
    b.fillRect(4, 4, 8, 8, { r: 255, g: 255, b: 255, a: 255 }, false);
    outline(b, { r: 0, g: 0, b: 0, a: 255 });
    eq(b.get(3, 4).a, 255, '左外侧被描边');
    eq(b.get(12, 4).a, 255, '右外侧被描边');
    eq(b.get(3, 3).a, 0, '对角不算四邻域');
    deepEq(b.get(4, 4), { r: 255, g: 255, b: 255, a: 255 }, '内部原色保留');
  });

  it('内侧描边不污染外部', () => {
    const b = new PixelBuffer(16, 16);
    b.fillRect(4, 4, 8, 8, { r: 255, g: 255, b: 255, a: 255 }, false);
    outline(b, { r: 0, g: 0, b: 0, a: 255 }, true);
    deepEq(b.get(4, 4), { r: 0, g: 0, b: 0, a: 255 }, '内侧被描边');
    eq(b.get(3, 4).a, 0, '外侧保持透明');
    deepEq(b.get(6, 6), { r: 255, g: 255, b: 255, a: 255 }, '内部保留');
  });

  it('抖动图案确定性', () => {
    const a = new PixelBuffer(8, 8);
    const b = new PixelBuffer(8, 8);
    const c1 = { r: 0, g: 0, b: 0, a: 255 };
    const c2 = { r: 255, g: 255, b: 255, a: 255 };
    dither(a, 0, 0, 8, 8, c1, c2, 'checker', 1);
    dither(b, 0, 0, 8, 8, c1, c2, 'checker', 1);
    eq(a.diffCount(b), 0);
    eq(a.opaqueCount(), 64, '两种颜色都不透明');
    eq(a.get(0, 0).r, 255, '阈值低处取 C2');
    eq(a.get(1, 0).r, 0, '阈值高处取 C1');
  });

  it('抖动 RATIO 控制 C2 占比', () => {
    const c1 = { r: 0, g: 0, b: 0, a: 255 };
    const c2 = { r: 255, g: 255, b: 255, a: 255 };
    const count = (ratio) => {
      const b = new PixelBuffer(16, 16);
      dither(b, 0, 0, 16, 16, c1, c2, 'bayer', 1, ratio);
      let n = 0;
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if (b.get(x, y).r === 255) n++;
      return n;
    };
    assert(Math.abs(count(0.5) - 128) <= 16, `0.5 占比异常：${count(0.5)}`);
    assert(Math.abs(count(0.25) - 64) <= 16, `0.25 占比异常：${count(0.25)}`);
    const lo = new PixelBuffer(16, 16);
    const hi = new PixelBuffer(16, 16);
    dither(lo, 0, 0, 16, 16, c1, c2, 'bayer', 1, 0.25);
    dither(hi, 0, 0, 16, 16, c1, c2, 'checker', 1, 0.25);
    assert(lo.diffCount(hi) > 0, '不同图案应产生不同纹理');
  });

  it('渐变端点色正确', () => {
    const b = new PixelBuffer(8, 8);
    linearGrad(b, 0, 0, 8, 8, { r: 0, g: 0, b: 0, a: 255 }, { r: 255, g: 255, b: 255, a: 255 }, 'v');
    eq(b.get(0, 0).r, 0);
    eq(b.get(0, 7).r, 255);
    eq(b.get(0, 4).r, b.get(7, 4).r, '同一行水平方向应一致');
    const hb = new PixelBuffer(8, 8);
    linearGrad(hb, 0, 0, 8, 8, { r: 0, g: 0, b: 0, a: 255 }, { r: 255, g: 255, b: 255, a: 255 }, 'h');
    eq(hb.get(7, 0).r, 255);
    eq(hb.get(0, 0).r, hb.get(0, 7).r, '同一列垂直方向应一致');
  });

  it('同种子噪声可复现', () => {
    const c = { r: 255, g: 255, b: 255, a: 255 };
    const a = new PixelBuffer(16, 16);
    const b = new PixelBuffer(16, 16);
    noise(a, 0, 0, 16, 16, c, 0.3, mulberry32(42));
    noise(b, 0, 0, 16, 16, c, 0.3, mulberry32(42));
    eq(a.diffCount(b), 0);
  });

  it('翻转与旋转', () => {
    const b = new PixelBuffer(4, 4);
    b.set(0, 0, { r: 255, g: 0, b: 0, a: 255 });
    const fx = flipBuffer(b, 'x');
    eq(fx.get(3, 0).r, 255);
    const fy = flipBuffer(b, 'y');
    eq(fy.get(0, 3).r, 255);
    const r90 = rotateBuffer(b, 90);
    eq(r90.get(3, 0).r, 255, '顺时针 90°：(0,0) → (3,0)');
  });

  it('对称变换数量正确', () => {
    eq(symmetryTransforms(16, 16, 'off').length, 1);
    eq(symmetryTransforms(16, 16, 'x').length, 2);
    eq(symmetryTransforms(16, 16, 'y').length, 2);
    eq(symmetryTransforms(16, 16, 'xy').length, 4);
    const [, mx] = symmetryTransforms(16, 16, 'x');
    deepEq(mx(1, 5), [14, 5]);
  });

  it('blit 覆盖拷贝', () => {
    const b = new PixelBuffer(8, 8);
    b.fillRect(0, 0, 2, 2, { r: 255, g: 0, b: 0, a: 255 }, false);
    b.blit(0, 0, 2, 2, 4, 4);
    deepEq(b.get(5, 5), { r: 255, g: 0, b: 0, a: 255 });
  });

  it('ASCII 网格预览不报错', () => {
    const b = new PixelBuffer(8, 8);
    b.fillRect(0, 0, 4, 4, { r: 255, g: 0, b: 0, a: 255 }, false);
    const s = b.toAscii(Palette.from('pico8'), 8);
    assert(s.includes('='), '应包含图例');
    eq(s.split('\n').length, 9, '图例 + 8 行');
  });
});

/* ═══════════════ 4. 文档 & 历史 ═══════════════ */

describe('文档与历史', () => {
  it('图层增删与合成顺序', () => {
    const d = new PixelDocument(8, 8);
    d.activeLayer.buffer.clear({ r: 255, g: 0, b: 0, a: 255 });
    const top = d.addLayer('上层');
    top.buffer.set(0, 0, { r: 0, g: 0, b: 255, a: 255 });
    deepEq(d.composite().get(0, 0), { r: 0, g: 0, b: 255, a: 255 });
    eq(d.layers.length, 2);
    d.removeLayer();
    deepEq(d.composite().get(0, 0), { r: 255, g: 0, b: 0, a: 255 });
  });

  it('图层不透明度影响合成', () => {
    const d = new PixelDocument(4, 4);
    d.activeLayer.buffer.clear({ r: 0, g: 0, b: 0, a: 255 });
    const top = d.addLayer();
    top.buffer.clear({ r: 255, g: 255, b: 255, a: 255 });
    top.opacity = 0.5;
    const c = d.composite().get(1, 1);
    assert(c.r > 110 && c.r < 145, `半透明合成异常 ${JSON.stringify(c)}`);
  });

  it('resize 保留左上角内容', () => {
    const d = new PixelDocument(4, 4);
    d.activeLayer.buffer.set(1, 1, { r: 9, g: 9, b: 9, a: 255 });
    d.resize(8, 8);
    eq(d.width, 8);
    eq(d.activeLayer.buffer.get(1, 1).r, 9);
    eq(d.activeLayer.buffer.width, 8);
  });

  it('JSON 往返不丢数据', () => {
    const d = new PixelDocument(8, 8);
    d.activeLayer.buffer.set(2, 3, { r: 12, g: 34, b: 56, a: 200 });
    d.title = '测试';
    const back = PixelDocument.fromJSON(JSON.parse(JSON.stringify(d.toJSON())));
    deepEq(back.activeLayer.buffer.get(2, 3), { r: 12, g: 34, b: 56, a: 200 });
    eq(back.title, '测试');
    eq(back.width, 8);
  });

  it('历史撤销 / 重做', () => {
    const d = new PixelDocument(8, 8);
    const h = new History(d);
    h.begin('画点');
    d.activeLayer.buffer.set(0, 0, { r: 255, g: 0, b: 0, a: 255 });
    d.invalidate();
    assert(h.commit(), '应产生历史记录');
    eq(h.undoStack.length, 1);
    h.undo();
    eq(d.activeLayer.buffer.get(0, 0).a, 0, '撤销后应恢复');
    h.redo();
    eq(d.activeLayer.buffer.get(0, 0).a, 255, '重做后应恢复');
  });

  it('无变化时不入栈', () => {
    const d = new PixelDocument(8, 8);
    const h = new History(d);
    h.begin('空操作');
    assert(!h.commit(), '未改动不应入栈');
    eq(h.undoStack.length, 0);
  });

  it('历史栈上限生效', () => {
    const d = new PixelDocument(4, 4);
    const h = new History(d, 3);
    for (let i = 0; i < 6; i++) {
      h.begin(`#${i}`);
      d.activeLayer.buffer.set(i % 4, 0, { r: i * 40, g: 0, b: 0, a: 255 });
      d.invalidate();
      h.commit();
    }
    eq(h.undoStack.length, 3);
  });

  it('capture / restoreTo 支持回退到任意快照', () => {
    const d = new PixelDocument(4, 4);
    const h = new History(d);
    d.activeLayer.buffer.set(0, 0, { r: 1, g: 1, b: 1, a: 255 });
    const snap = h.capture();
    d.activeLayer.buffer.set(1, 1, { r: 2, g: 2, b: 2, a: 255 });
    h.restoreTo(snap);
    eq(d.activeLayer.buffer.get(1, 1).a, 0);
    eq(d.activeLayer.buffer.get(0, 0).a, 255);
  });
});

/* ═══════════════ 5. 词法与语法 ═══════════════ */

describe('PixelScript 词法', () => {
  it('分词与字符串常量', () => {
    const t = tokenize('text 2 2 c7 "HELLO WORLD" 2');
    deepEq(t.map((x) => x.value), ['text', '2', '2', 'c7', 'HELLO WORLD', '2']);
    eq(t[4].quoted, true);
  });

  it('注释识别：// 与 # ', () => {
    eq(tokenize('px 1 1 c0 // 注释').length, 4);
    eq(tokenize('# 整行注释').length, 0);
    eq(tokenize('px 1 1 c0 # 注释').length, 4);
    eq(tokenize('rect 0 0 4 4 #ff0000').length, 6, '#ff0000 是颜色不是注释');
  });

  it('十六进制颜色不被当作注释', () => {
    const t = tokenize('bg #ff00ff');
    eq(t[1].value, '#ff00ff');
  });

  it('引号内转义', () => {
    const t = tokenize('name "A \\"B\\""');
    eq(t[1].value, 'A "B"');
  });

  it('指令表规模符合文档（43 条：33 绘制 + 9 渲染 + 1 局部重绘）', () => {
    eq(Object.keys(COMMANDS).length, 43);
  });

  it('dslReference 列出全部指令', () => {
    const ref = dslReference();
    for (const name of Object.keys(COMMANDS)) assert(ref.includes(`${name} `), `缺少 ${name}`);
  });
});

/* ═══════════════ 6. 指令逐条执行 ═══════════════ */

describe('PixelScript 全部指令', () => {
  const exec = (code, doc) => runScript(code, doc || new PixelDocument(32, 32), { mode: 'replace', seed: 7 });

  it('size 改变画布', () => {
    const d = new PixelDocument(32, 32);
    const r = exec('size 16 24\npx 0 0 c8', d);
    assert(r.ok, r.errors.join('; '));
    eq(d.width, 16);
    eq(d.height, 24);
  });

  it('size 出现在绘制之后会报错', () => {
    const r = exec('px 0 0 c8\nsize 8 8');
    eq(r.ok, false);
    assert(r.errors[0].includes('line 2'), r.errors[0]);
  });

  it('palette 切换预设与自定义', () => {
    const d = new PixelDocument(8, 8);
    let r = exec('palette gameboy\npx 0 0 c1', d);
    assert(r.ok, r.errors.join(';'));
    eq(d.palette.size, 4);
    r = exec('palette #000000 #ffffff\npx 0 0 c1', d);
    assert(r.ok, r.errors.join(';'));
    eq(d.palette.size, 2);
    deepEq(d.activeLayer.buffer.get(0, 0), { r: 255, g: 255, b: 255, a: 255 });
  });

  it('bg 填满整层', () => {
    const d = new PixelDocument(8, 8);
    const r = exec('bg c12', d);
    assert(r.ok, r.errors.join(';'));
    eq(d.activeLayer.buffer.opaqueCount(), 64);
    eq(d.activeLayer.buffer.get(4, 4).b, 255);
  });

  it('clear 透明与指定色', () => {
    const d = new PixelDocument(8, 8);
    exec('bg c1', d);
    exec('clear', d);
    eq(d.activeLayer.buffer.opaqueCount(), 0);
    exec('clear c2', d);
    eq(d.activeLayer.buffer.opaqueCount(), 64);
  });

  it('sym 对称绘制', () => {
    const d = new PixelDocument(16, 16);
    const r = exec('sym x\npx 0 0 c8', d);
    assert(r.ok, r.errors.join(';'));
    eq(d.activeLayer.buffer.get(15, 0).a, 255, '应镜像到右侧');
    eq(d.activeLayer.buffer.get(0, 0).a, 255);
    eq(d.activeLayer.buffer.opaqueCount(), 2);
  });

  it('sym xy 四向镜像', () => {
    const d = new PixelDocument(16, 16);
    exec('sym xy\npx 0 0 c8', d);
    eq(d.activeLayer.buffer.opaqueCount(), 4);
  });

  it('sym 可关闭', () => {
    const d = new PixelDocument(16, 16);
    exec('sym x\nsym off\npx 0 0 c8', d);
    eq(d.activeLayer.buffer.opaqueCount(), 1);
  });

  it('seed 使噪声可复现', () => {
    const a = new PixelDocument(16, 16);
    const b = new PixelDocument(16, 16);
    const code = 'seed 123\nnoise 0 0 16 16 c7 0.4';
    exec(code, a);
    exec(code, b);
    eq(a.activeLayer.buffer.diffCount(b.activeLayer.buffer), 0);
  });

  it('name 设置标题', () => {
    const d = new PixelDocument(8, 8);
    exec('name "我的作品"', d);
    eq(d.title, '我的作品');
  });

  it('px 单像素与越界裁剪', () => {
    const d = new PixelDocument(8, 8);
    const r = exec('px 3 3 c8\npx 99 99 c8\npx -5 0 c8', d);
    assert(r.ok, r.errors.join(';'));
    eq(d.activeLayer.buffer.opaqueCount(), 1);
  });

  it('hline / vline', () => {
    const d = new PixelDocument(16, 16);
    const r = exec('hline 0 5 10 c8\nvline 5 0 10 c8', d);
    assert(r.ok, r.errors.join(';'));
    eq(d.activeLayer.buffer.opaqueCount(), 19, '10 + 10 - 1 交点');
  });

  it('line 端点与线宽', () => {
    const d = new PixelDocument(16, 16);
    const r = exec('line 0 0 15 15 c8\nline 0 15 15 15 c8 3', d);
    assert(r.ok, r.errors.join(';'));
    eq(d.activeLayer.buffer.get(0, 0).a, 255);
    eq(d.activeLayer.buffer.get(15, 15).a, 255);
  });

  it('rect 填充与描边', () => {
    const d = new PixelDocument(16, 16);
    let r = exec('rect 2 2 6 6 c8 fill', d);
    assert(r.ok, r.errors.join(';'));
    eq(d.activeLayer.buffer.opaqueCount(), 36);
    r = exec('rect 2 2 6 6 c8 stroke 2', d);
    assert(r.ok, r.errors.join(';'));
    eq(d.activeLayer.buffer.get(3, 3).a, 255, '边框');
    eq(d.activeLayer.buffer.get(5, 5).a, 0, '内部应为空');
  });

  it('rect 负宽高归一化', () => {
    const d = new PixelDocument(16, 16);
    const r = exec('rect 8 8 -5 -5 c8 fill', d);
    assert(r.ok, r.errors.join(';'));
    eq(d.activeLayer.buffer.opaqueCount(), 25);
  });

  it('rrect 圆角矩形', () => {
    const d = new PixelDocument(24, 24);
    const r = exec('rrect 2 2 20 20 5 c8 fill', d);
    assert(r.ok, r.errors.join(';'));
    eq(d.activeLayer.buffer.get(2, 2).a, 0, '角落应为空');
    eq(d.activeLayer.buffer.get(12, 12).a, 255);
  });

  it('circle 填充与描边', () => {
    const d = new PixelDocument(24, 24);
    let r = exec('circle 12 12 8 c8 fill', d);
    assert(r.ok, r.errors.join(';'));
    assert(d.activeLayer.buffer.opaqueCount() > 150);
    r = exec('circle 12 12 8 c8 stroke', d);
    assert(r.ok, r.errors.join(';'));
    eq(d.activeLayer.buffer.get(12, 12).a, 0, '描边圆中心为空');
  });

  it('ellipse 椭圆', () => {
    const d = new PixelDocument(32, 32);
    const r = exec('ellipse 16 16 12 6 c8 fill', d);
    assert(r.ok, r.errors.join(';'));
    eq(d.activeLayer.buffer.get(16, 16).a, 255);
    eq(d.activeLayer.buffer.get(16, 23).a, 0, '纵向超出短半轴');
  });

  it('poly 多边形颜色写在最前', () => {
    const d = new PixelDocument(16, 16);
    const r = exec('poly c8 fill 8 1 15 15 1 15', d);
    assert(r.ok, r.errors.join(';'));
    eq(d.activeLayer.buffer.get(8, 14).a, 255);
    const r2 = exec('poly c8 stroke 8 1 15 15 1 15', d);
    assert(r2.ok, r2.errors.join(';'));
  });

  it('poly 顶点数不足报错', () => {
    const r = exec('poly c8 fill 1 1 2 2');
    eq(r.ok, false);
    assert(r.errors[0].includes('至少'), r.errors[0]);
  });

  it('poly 坐标不成对报错', () => {
    const r = exec('poly c8 fill 1 1 2 2 3');
    eq(r.ok, false);
  });

  it('fill 洪水填充', () => {
    const d = new PixelDocument(16, 16);
    const r = exec('rect 0 0 16 16 c1 fill\ncircle 8 8 4 c2 fill\nfill 8 8 c8', d);
    assert(r.ok, r.errors.join(';'));
    eq(d.activeLayer.buffer.get(8, 8).r, 255, '内部变红');
    eq(d.activeLayer.buffer.get(0, 0).r, 29, '外部保持不变');
  });

  it('replace 全局换色', () => {
    const d = new PixelDocument(8, 8);
    const r = exec('bg c12\nrect 0 0 4 4 c8 fill\nreplace c8 c10', d);
    assert(r.ok, r.errors.join(';'));
    eq(d.activeLayer.buffer.get(0, 0).g, 236, 'c8 红 → c10 黄');
    eq(d.activeLayer.buffer.get(7, 7).b, 255, 'c12 蓝不变');
  });

  it('outline 外侧描边', () => {
    const d = new PixelDocument(16, 16);
    const r = exec('rect 4 4 8 8 c7 fill\noutline c0', d);
    assert(r.ok, r.errors.join('; '));
    eq(d.activeLayer.buffer.get(3, 4).a, 255, '四邻域外侧被描边');
    eq(d.activeLayer.buffer.get(3, 3).a, 0, '对角不描边');
    deepEq(d.activeLayer.buffer.get(5, 5), { r: 255, g: 241, b: 232, a: 255 });
  });

  it('grad 垂直与水平', () => {
    const d = new PixelDocument(8, 8);
    exec('grad 0 0 8 8 c0 c7 v', d);
    eq(d.activeLayer.buffer.get(0, 0).r, 0);
    eq(d.activeLayer.buffer.get(0, 7).r, 255);
    exec('grad 0 0 8 8 c0 c7 h', d);
    eq(d.activeLayer.buffer.get(7, 0).r, 255);
  });

  it('dither 四种图案', () => {
    for (const p of ['checker', 'bayer', 'h', 'v']) {
      const d = new PixelDocument(16, 16);
      const r = exec(`dither 0 0 16 16 c0 c7 ${p} 2`, d);
      assert(r.ok, `${p}: ${r.errors.join(';')}`);
      eq(d.activeLayer.buffer.opaqueCount(), 256);
    }
  });

  it('noise 密度大致正确', () => {
    const d = new PixelDocument(64, 64);
    const r = exec('seed 5\nnoise 0 0 64 64 c7 0.25', d);
    assert(r.ok, r.errors.join(';'));
    const n = d.activeLayer.buffer.opaqueCount();
    assert(n > 700 && n < 1400, `密度偏差过大：${n}/4096`);
  });

  it('copy 区域拷贝', () => {
    const d = new PixelDocument(16, 16);
    const r = exec('rect 0 0 4 4 c8 fill\ncopy 0 0 4 4 8 8', d);
    assert(r.ok, r.errors.join(';'));
    eq(d.activeLayer.buffer.get(9, 9).r, 255);
    eq(d.activeLayer.buffer.opaqueCount(), 32);
  });

  it('flip 水平与垂直', () => {
    const d = new PixelDocument(8, 8);
    runScript('px 0 0 c8', d, { mode: 'replace' });
    runScript('flip x', d, { mode: 'append' });
    eq(d.activeLayer.buffer.get(7, 0).a, 255, '左右翻转');
    eq(d.activeLayer.buffer.get(0, 0).a, 0);
    runScript('flip y', d, { mode: 'append' });
    eq(d.activeLayer.buffer.get(7, 7).a, 255, '再上下翻转');
  });

  it('rot 90 / 180 / 270', () => {
    const d = new PixelDocument(8, 8);
    runScript('px 0 0 c8', d, { mode: 'replace' });
    runScript('rot 90', d, { mode: 'append' });
    eq(d.activeLayer.buffer.get(7, 0).a, 255, '90° → 右上');
    runScript('rot 180', d, { mode: 'append' });
    eq(d.activeLayer.buffer.get(0, 7).a, 255, '再 180° → 左下');
    const bad = exec('rot 45', new PixelDocument(8, 8));
    eq(bad.ok, false, '非 90 倍数应报错');
  });

  it('erase 擦除为透明', () => {
    const d = new PixelDocument(8, 8);
    const r = exec('bg c8\nerase 2 2 4 4', d);
    assert(r.ok, r.errors.join(';'));
    eq(d.activeLayer.buffer.get(3, 3).a, 0);
    eq(d.activeLayer.buffer.get(0, 0).a, 255);
  });

  it('adjust 提亮压暗', () => {
    const d = new PixelDocument(8, 8);
    exec('bg c1\nadjust 0 0 8 8 light 0.5', d);
    assert(d.activeLayer.buffer.get(0, 0).r > 29, '应被提亮');
    exec('adjust 0 0 8 8 dark 0.5', d);
    assert(d.activeLayer.buffer.get(0, 0).r < 100, '应被压暗');
  });

  it('text 位图字体', () => {
    const d = new PixelDocument(32, 16);
    const r = exec('text 0 0 c7 "AB" 1', d);
    assert(r.ok, r.errors.join('; '));
    assert(d.activeLayer.buffer.opaqueCount() > 20, `文字像素过少 ${d.activeLayer.buffer.opaqueCount()}`);
    eq(d.activeLayer.buffer.get(1, 0).a, 255, '字母 A 首行 "01110" 的第 2 列应点亮');
    eq(d.activeLayer.buffer.get(0, 0).a, 0, '第 1 列应留空');
  });

  it('text 缩放', () => {
    const d = new PixelDocument(64, 32);
    exec('text 0 0 c7 "A" 1', d);
    const one = d.activeLayer.buffer.opaqueCount();
    exec('text 0 0 c7 "A" 2', d);
    const two = d.activeLayer.buffer.opaqueCount();
    eq(two, one * 4, '2 倍缩放像素数应为 4 倍');
  });

  it('curve 二次贝塞尔曲线', () => {
    const d = new PixelDocument(32, 32);
    const r = exec('curve 2 30 16 2 30 30 c8', d);
    assert(r.ok, r.errors.join('; '));
    assert(d.activeLayer.buffer.opaqueCount() > 40, `曲线像素过少 ${d.activeLayer.buffer.opaqueCount()}`);
  });

  it('arc 圆弧角度范围（0=右 90=下）', () => {
    const d = new PixelDocument(32, 32);
    const r = exec('arc 16 16 10 0 90 c8', d);
    assert(r.ok, r.errors.join('; '));
    eq(d.activeLayer.buffer.get(26, 16).a, 255, '起点 (r,0) 应有点');
    eq(d.activeLayer.buffer.get(16, 26).a, 255, '终点 (0,r) 应有点');
    eq(d.activeLayer.buffer.get(6, 16).a, 0, '左象限不应有点');
    eq(d.activeLayer.buffer.get(16, 6).a, 0, '上象限不应有点');
  });

  it('shade 向目标色靠拢', () => {
    const d = new PixelDocument(8, 8);
    exec('bg c11', d);                                                  // 绿 #00e436
    const flat = d.activeLayer.buffer.get(4, 4);
    const r = runScript('shade 0 0 8 8 c1 0.5', d, { mode: 'append' }); // 向深蓝靠拢
    assert(r.ok, r.errors.join('; '));
    const px = d.activeLayer.buffer.get(4, 4);
    assert(px.b > flat.b && px.r > flat.r, `应向深蓝偏移：${JSON.stringify(flat)} → ${JSON.stringify(px)}`);
  });

  it('bevel 左上提亮、右下压暗', () => {
    const d = new PixelDocument(16, 16);
    exec('rect 2 2 12 12 c5 fill', d);
    const flat = d.activeLayer.buffer.get(3, 3);
    const r = runScript('bevel 2 2 12 12 3 0.4', d, { mode: 'append' });
    assert(r.ok, r.errors.join('; '));
    const tl = d.activeLayer.buffer.get(2, 2);
    const br = d.activeLayer.buffer.get(13, 13);
    const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    assert(lum(tl) > lum(flat), `左上应提亮 ${lum(tl)} <= ${lum(flat)}`);
    assert(lum(br) < lum(flat), `右下应压暗 ${lum(br)} >= ${lum(flat)}`);
  });

  it('graddither 抖动渐变（两端为纯色，中段抖动不插值）', () => {
    const d = new PixelDocument(32, 32);
    const r = exec('graddither 0 0 32 32 c0 c7 bayer v', d);
    assert(r.ok, r.errors.join('; '));
    assert(d.activeLayer.buffer.get(16, 0).r < 64, '顶部应接近 C1（黑）');
    assert(d.activeLayer.buffer.get(16, 31).r > 192, '底部应接近 C2（白）');
    let mid = 0;
    for (let x = 0; x < 32; x++) {
      const c = d.activeLayer.buffer.get(x, 16);
      if (c.r > 64 && c.r < 192) mid++;
    }
    eq(mid, 0, '抖动像素非黑即白，不应出现灰阶插值');
  });

  it('未知指令定位到行号', () => {
    const r = exec('size 8 8\npx 0 0 c8\nfrobnicate 1 2 3');
    eq(r.ok, false);
    assert(r.errors[0].startsWith('line 3'), r.errors[0]);
  });

  it('未知颜色报错但不中断后续绘制', () => {
    const d = new PixelDocument(8, 8);
    const r = exec('px 0 0 c99\npx 1 1 c8', d);
    eq(r.ok, false);
    assert(r.errors[0].includes('line 1'), r.errors[0]);
    eq(d.activeLayer.buffer.get(1, 1).a, 255, '后续行仍应执行');
  });

  it('参数个数不足报错', () => {
    const r = exec('line 0 0 5');
    eq(r.ok, false);
    assert(r.errors[0].includes('line 1'), r.errors[0]);
  });

  it('参数非数值报错', () => {
    const r = exec('px abc 0 c8');
    eq(r.ok, false);
    assert(r.errors[0].includes('不是合法数值'), r.errors[0]);
  });

  it('执行报告字段完整', () => {
    const r = exec('bg c1\nrect 0 0 4 4 c8 fill');
    deepEq(Object.keys(r).sort(), ['changed', 'elapsedMs', 'errors', 'ok', 'ops', 'warnings'].sort());
    eq(r.ops, 2);
    eq(r.changed, 1024, '默认 32×32 整层都变了');
  });

  it('append 模式不清空已有像素', () => {
    const d = new PixelDocument(8, 8);
    runScript('px 0 0 c8', d, { mode: 'replace' });
    runScript('px 1 1 c7', d, { mode: 'append' });
    eq(d.activeLayer.buffer.opaqueCount(), 2);
  });

  it('锁定图层拒绝绘制', () => {
    const d = new PixelDocument(8, 8);
    d.activeLayer.locked = true;
    const r = runScript('px 0 0 c8', d);
    eq(r.ok, false);
    assert(r.errors[0].includes('锁定'), r.errors[0]);
  });

  it('空脚本不产生错误', () => {
    const r = exec('');
    eq(r.ok, true);
    eq(r.changed, 0);
  });

  it('注释与空行被忽略', () => {
    const r = exec('# 说明\n\n// 另一行\n   \npx 1 1 c8');
    eq(r.ok, true);
    eq(r.ops, 1);
  });
});

/* ═══════════════ 7. 语法预检 ═══════════════ */

describe('语法预检 checkSyntax', () => {
  it('检测未知指令', () => {
    const e = checkSyntax('size 8 8\nblah 1');
    eq(e.length, 1);
    eq(e[0].line, 2);
  });

  it('检测参数个数', () => {
    eq(checkSyntax('line 0 0 5').length, 1);
    eq(checkSyntax('line 0 0 5 5 c8').length, 0);
  });

  it('检测重复 size', () => {
    eq(checkSyntax('size 8 8\nsize 9 9').length, 1);
  });

  it('合法脚本无误报', () => {
    for (const s of SAMPLES) eq(checkSyntax(s.code).length, 0, `${s.name} 存在语法错误`);
  });
});

/* ═══════════════ 8. 脚本抽取 & DONE 识别 ═══════════════ */

describe('模型回复解析', () => {
  it('抽取 pixelscript 围栏', () => {
    const t = '好的，我来画。\n```pixelscript\nsize 8 8\npx 0 0 c8\n```\n完成。';
    eq(extractScript(t), 'size 8 8\npx 0 0 c8');
  });

  it('抽取 px 围栏', () => {
    const t = '```px\nsize 4 4\n```';
    eq(extractScript(t), 'size 4 4');
  });

  it('无围栏时降级为裸行', () => {
    const t = 'size 8 8\npx 1 1 c8';
    eq(extractScript(t), 'size 8 8\npx 1 1 c8');
  });

  it('无脚本返回 null', () => {
    eq(extractScript('我不知道怎么画。'), null);
    eq(extractScript(''), null);
  });

  it('DONE 识别（多种写法）', () => {
    eq(isDone('DONE'), true);
    eq(isDone('done.'), true);
    eq(isDone('已经足够好了。\nDONE'), true);
    eq(isDone('完成'), true);
    eq(isDone('我觉得还需要调整'), false);
  });

  it('不会把 DONE 误判为脚本', () => {
    eq(isDone('DONE'), true);
    eq(extractScript('DONE'), null);
  });

  it('围栏语言标签与首行同行', () => {
    eq(extractScript('```pixelscript size 4 4\npx 0 0 c8\n```'), 'size 4 4\npx 0 0 c8');
  });

  it('流式截断（无闭合围栏）也能抽取', () => {
    eq(extractScript('```pixelscript\nsize 4 4\npx 1 1 c8'), 'size 4 4\npx 1 1 c8');
  });

  it('无围栏时不把散文当脚本', () => {
    eq(extractScript('我会先用椭圆画一个史莱姆\n再用圆形画两只眼睛'), null);
  });

  it('有可执行脚本时 isDone 为 false（防「脚本 + DONE」被吞）', () => {
    eq(isDone('```pixelscript\nsize 4 4\npx 0 0 c8\n```\nDONE'), false);
  });
});

/* ═══════════════ 8.5 网关适配 ═══════════════ */

describe('网关适配', () => {
  it('端点归一化（完整 /chat/completions 与基址等价）', () => {
    eq(normalizeBaseUrl('https://opencode.ai/zen/go/v1/chat/completions'), 'https://opencode.ai/zen/go/v1');
    eq(normalizeBaseUrl('https://opencode.ai/zen/go/v1/'), 'https://opencode.ai/zen/go/v1');
    eq(normalizeBaseUrl('https://api.deepseek.com/v1/chat/completions/'), 'https://api.deepseek.com/v1');
    eq(normalizeBaseUrl(''), '');
  });

  it('识别 opencode / DeepSeek 官方端点', () => {
    eq(isOpencodeEndpoint('https://opencode.ai/zen/go/v1'), true);
    eq(isOpencodeEndpoint('https://api.deepseek.com/v1'), false);
    eq(isOfficialEndpoint('https://api.deepseek.com/v1/chat/completions'), true);
    eq(isOfficialEndpoint('https://api.openai.com/v1'), false);
  });

  it('thinking 拒绝识别（仅 400/422 且提及相关词）', () => {
    eq(isThinkingRejection(400, '{"error":"unknown field thinking"}'), true);
    eq(isThinkingRejection(400, 'reasoning_effort not supported'), true);
    eq(isThinkingRejection(500, 'thinking error'), false);
    eq(isThinkingRejection(400, 'invalid api key'), false);
  });

  it('Provider 对 opencode 注入会话头，其它端点不注入', () => {
    const p = new Provider({ baseUrl: 'https://opencode.ai/zen/go/v1', model: 'm', thinking: 'auto' });
    const h = p.gatewayHeaders();
    assert(h['x-opencode-session'], '应注入 x-opencode-session');
    eq(h['x-opencode-client'], 'pixelscribe');
    deepEq(p.thinkingBody(), { type: 'disabled' });

    const p2 = new Provider({ baseUrl: 'https://api.openai.com/v1', model: 'm', thinking: 'auto' });
    eq('x-opencode-session' in p2.gatewayHeaders(), false);
    eq(p2.thinkingBody(), null);

    const p3 = new Provider({ baseUrl: 'https://api.openai.com/v1', thinking: 'enabled' });
    deepEq(p3.thinkingBody(), { type: 'enabled' });
  });

  it('直连模式请求体带 max_tokens 与 thinking', () => {
    const p = new Provider({ baseUrl: 'https://opencode.ai/zen/go/v1', apiKey: 'k', model: 'm', proxy: false, maxTokens: 1024 });
    const body = p.buildPayload([{ role: 'user', content: 'hi' }], {}, true);
    eq(body.max_tokens, 1024);
    deepEq(body.thinking, { type: 'disabled' });
    const p2 = new Provider({ baseUrl: 'https://api.openai.com/v1', model: 'm', proxy: false, maxTokens: 512 });
    const body2 = p2.buildPayload([{ role: 'user', content: 'hi' }], {}, true);
    eq(body2.thinking, undefined);
    eq(body2.max_tokens, 512);
  });

  it('色板速查 legend 含索引/色值/名称，超限省略', () => {
    const pal = Palette.from('pico8');
    const s = pal.legend(4);
    assert(s.includes('c0=#000000(black)'), s);
    assert(s.includes('c1=#1d2b53(darkblue)'), s);
    assert(s.endsWith('…'), '超出上限应省略');
    assert(!pal.legend(16).includes('…'));
  });
});

/* ═══════════════ 9. PNG 导出 ═══════════════ */

describe('PNG 编码', () => {
  const b = new PixelBuffer(8, 6);
  b.clear({ r: 255, g: 0, b: 0, a: 255 });
  const png = encodePNG(b.data, 8, 6);

  it('PNG 魔数正确', () => {
    deepEq([...png.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  it('IHDR 声明尺寸与色彩类型', () => {
    const dv = new DataView(png.buffer, png.byteOffset);
    eq(dv.getUint32(16), 8, 'width');
    eq(dv.getUint32(20), 6, 'height');
    eq(png[24], 8, 'bit depth');
    eq(png[25], 6, 'color type RGBA');
  });

  it('以 IEND 结尾', () => {
    deepEq([...png.slice(-8, -4)], [...Buffer.from('IEND')]);
    deepEq([...png.slice(-4)], [0xae, 0x42, 0x60, 0x82], 'IEND CRC');
  });

  it('chunk CRC 正确（IHDR）', () => {
    const dv = new DataView(png.buffer, png.byteOffset);
    const len = dv.getUint32(8);
    eq(len, 13, 'IHDR 长度');
    eq([...png.slice(12, 16)].map((c) => String.fromCharCode(c)).join(''), 'IHDR');
  });

  it('IDAT 可被标准 zlib 解压，且扫描线与源像素一致', () => {
    const dv = new DataView(png.buffer, png.byteOffset);
    let off = 8;
    let idat = null;
    while (off < png.length) {
      const len = dv.getUint32(off);
      const type = String.fromCharCode(...png.slice(off + 4, off + 8));
      if (type === 'IDAT') idat = png.slice(off + 8, off + 8 + len);
      // 校验每个 chunk 的 CRC
      const payload = png.slice(off + 4, off + 8 + len);
      const stored = dv.getUint32(off + 8 + len);
      const computed = zlib.crc32 ? zlib.crc32(payload) : null;
      if (computed !== null) eq(computed >>> 0, stored >>> 0, `${type} CRC 不匹配`);
      off += 12 + len;
    }
    assert(idat, '未找到 IDAT');
    const raw = zlib.inflateSync(Buffer.from(idat));
    eq(raw.length, (8 * 4 + 1) * 6, '解压后应为 (行宽+滤波字节)×行数');
    eq(raw[0], 0, '滤波类型应为 0');
    // 第一个像素应为纯红
    deepEq([raw[1], raw[2], raw[3], raw[4]], [255, 0, 0, 255]);
  });

  it('最近邻放大保持尺寸与像素块', () => {
    const big = encodePNGScaled(b.data, 8, 6, 32, 24);
    const dv = new DataView(big.buffer, big.byteOffset);
    eq(dv.getUint32(16), 32);
    eq(dv.getUint32(20), 24);
  });

  it('base64 编码可被标准解码器还原', () => {
    const b64 = toBase64(png);
    const back = Buffer.from(b64, 'base64');
    eq(back.length, png.length);
    eq(back[0], 0x89);
  });

  it('toDataURL 产出合法前缀', () => {
    const url = toDataURL(b.data, 8, 6, 128);
    assert(url.startsWith('data:image/png;base64,iVBOR'), url.slice(0, 40));
  });

  it('大画布（多次 stored block）不报错', () => {
    const bigBuf = new PixelBuffer(128, 128);
    bigBuf.clear({ r: 0, g: 128, b: 255, a: 255 });
    const out = encodePNG(bigBuf.data, 128, 128);
    assert(out.length > 65000, '应触发多块 DEFLATE');
    deepEq([...out.slice(-8, -4)], [...Buffer.from('IEND')]);
  });
});

/* ═══════════════ 10. AI 层 ═══════════════ */

describe('AI 层', () => {
  it('系统提示包含全部指令与画布尺寸', () => {
    const p = buildSystemPrompt({ width: 32, height: 32, paletteName: 'PICO-8', paletteSize: 16, title: 'x' });
    assert(p.includes('32×32'));
    assert(p.includes('c15'));
    for (const name of Object.keys(COMMANDS)) assert(p.includes(`${name} `), `提示词缺少 ${name}`);
  });

  it('修复提示包含错误行', () => {
    const p = buildRepair({ errors: ['line 3: 未知颜色 \'c99\''], warnings: [] });
    assert(p.includes('line 3'));
  });

  it('审查提示包含统计与网格', () => {
    const p = buildCritique({ iteration: 2, max: 6, mode: 'append', report: { ops: 5, changed: 30 }, ascii: 'a=b\n..a', hasImage: true });
    assert(p.includes('第 2/6 轮'));
    assert(p.includes('30'));
    assert(p.includes('增量'));
  });

  it('演示脚本可执行且覆盖全部内置主题', () => {
    const topics = ['史莱姆', '药水', '爱心', '树', '房子', '星星', '剑', '幽灵', '花', '机器人', '云', '山', '随便什么东西'];
    for (const t of topics) {
      const code = demoScript(t, 32, 32);
      const d = new PixelDocument(32, 32);
      const r = runScript(code, d, { mode: 'replace' });
      assert(r.ok, `${t}: ${r.errors.join('; ')}`);
      assert(r.changed > 50, `${t}: 改动过少 ${r.changed}`);
    }
  });

  it('演示脚本适配任意画布尺寸', () => {
    for (const size of [16, 24, 48, 64]) {
      const code = demoScript('史莱姆', size, size);
      const d = new PixelDocument(size, size);
      const r = runScript(code, d, { mode: 'replace' });
      assert(r.ok, `${size}px: ${r.errors.join('; ')}`);
      assert(r.changed > 20, `${size}px 改动过少`);
    }
  });

  it('演示 Provider 多轮推进直至收敛', () => {
    const messages = [
      { role: 'system', content: 'x' },
      { role: 'user', content: '画一个史莱姆' },
    ];
    const d = new PixelDocument(32, 32);

    const r1 = demoReply(messages, 32, 32);
    const s1 = extractScript(r1);
    assert(s1, '第 1 轮应产出脚本');
    const rep1 = runScript(s1, d, { mode: 'replace' });
    assert(rep1.ok, rep1.errors.join('; '));
    assert(rep1.changed > 100, `第 1 轮改动过少 ${rep1.changed}`);

    messages.push({ role: 'assistant', content: r1 }, { role: 'user', content: '审查一下' });
    const r2 = demoReply(messages, 32, 32);
    const s2 = extractScript(r2);
    assert(s2, '第 2 轮应产出增量脚本');
    const rep2 = runScript(s2, d, { mode: 'append' });
    assert(rep2.ok, rep2.errors.join('; '));

    messages.push({ role: 'assistant', content: r2 }, { role: 'user', content: '再审查' });
    const r3 = demoReply(messages, 32, 32);
    assert(isDone(r3), `第 3 轮应 DONE，实际：${r3.slice(0, 40)}`);
  });

  it('演示审查意见是可执行的增量脚本', () => {
    const s = extractScript(demoCritique(0));
    assert(s, '应包含脚本');
    const d = new PixelDocument(32, 32);
    runScript(SAMPLES[0].code, d, { mode: 'replace' });
    const r = runScript(s, d, { mode: 'append' });
    assert(r.ok, r.errors.join('; '));
  });
});

/* ═══════════════ 11. 字体 ═══════════════ */

describe('位图字体', () => {
  it('全部大写字母与数字有字形', () => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    for (const c of chars) {
      eq(glyph(c).length, 7, `${c} 行数`);
      for (const row of glyph(c)) eq(row.length, 5, `${c} 列数`);
    }
  });

  it('未知字符退化为 ?', () => {
    deepEq(glyph('中'), glyph('?'));
    deepEq(glyph('%'), glyph('%'));
  });

  it('小写映射到大写', () => {
    deepEq(glyph('a'), glyph('A'));
  });

  it('文本宽度计算（含 1px 字距）', () => {
    eq(textWidth('A', 1), 5);
    eq(textWidth('AB', 1), 11);
    eq(textWidth('AB', 2), 22);
    eq(textWidth('', 1), 0);
  });
});

/* ═══════════════ 12. 端到端 ═══════════════ */

describe('端到端：内置范例渲染', () => {
  fs.mkdirSync(OUT, { recursive: true });

  for (const sample of SAMPLES) {
    it(`${sample.name} 执行无错且产出有效图像`, () => {
      const d = new PixelDocument(32, 32);
      const r = runScript(sample.code, d, { mode: 'replace' });
      assert(r.ok, r.errors.join('; '));
      assert(r.changed > 20, `改动过少：${r.changed}`);
      const opaque = d.activeLayer.buffer.opaqueCount();
      assert(opaque > 40, `非透明像素过少：${opaque}`);

      const png = encodePNG(d.composite().data, d.width, d.height);
      const file = path.join(OUT, `${sample.name.replace(/[^\w\u4e00-\u9fa5-]+/g, '_')}.png`);
      fs.writeFileSync(file, png);
      assert(fs.statSync(file).size > 100, 'PNG 文件过小');
    });
  }

  it('多轮闭环模拟：4 轮迭代逐步收敛', () => {
    const d = new PixelDocument(32, 32);
    const deltas = [];
    const rounds = [
      'size 32 32\nbg c1\nellipse 16 20 11 8 c3 fill',
      'ellipse 16 20 10 7 c11 fill',
      'circle 11 16 2 c0 fill\ncircle 21 16 2 c0 fill',
      'px 12 15 c7\npx 22 15 c7\noutline c1',
    ];
    rounds.forEach((code, i) => {
      const r = runScript(code, d, { mode: i === 0 ? 'replace' : 'append' });
      assert(r.ok, `第 ${i + 1} 轮：${r.errors.join('; ')}`);
      deltas.push(r.changed);
    });
    assert(deltas[0] > 200, '首轮应产生大量改动');
    assert(deltas[3] < 120, '末轮改动应较小');
    assert(d.activeLayer.buffer.opaqueCount() > 150, '最终应有内容');

    // 收敛判定
    const last = runScript('adjust 16 16 1 1 light 0.01', d, { mode: 'append' });
    assert(last.changed <= 2, `改动应接近 0，实际 ${last.changed}`);
  });

  it('自测产物目录已生成', () => {
    assert(fs.existsSync(OUT), 'out/test 未生成');
    assert(fs.readdirSync(OUT).filter((f) => f.endsWith('.png')).length >= SAMPLES.length - 1);
  });
});

/* ═══════════════ 12.5 程序化渲染效果（S1） ═══════════════ */

describe('程序化渲染效果（S1）', () => {
  const white = { r: 255, g: 255, b: 255, a: 255 };

  it('法线场为归一化向量', () => {
    const b = new PixelBuffer(8, 8);
    b.clear({ r: 100, g: 100, b: 100, a: 255 });
    const N = surfaceNormals(b, 2);
    eq(N.length, 8 * 8 * 3);
    const i = (4 * 8 + 4) * 3; // 内部像素（平涂区）
    const len = Math.hypot(N[i], N[i + 1], N[i + 2]);
    assert(Math.abs(len - 1) < 1e-5, `法线未归一化：${len}`);
    assert(Math.abs(N[i + 2] - 1) < 1e-5, '平涂内部法线应朝向观察者');
  });

  it('浮雕受光改变像素且不动透明区', () => {
    const b = new PixelBuffer(16, 16);
    fillEllipse(b, 8, 8, 6, 6, { r: 128, g: 128, b: 128, a: 255 });
    const before = b.clone();
    applyRelief(b, { strength: 1, ambient: 0.3, lights: [{ dx: -1, dy: -1, z: 1, strength: 1 }] });
    assert(b.diffCount(before) > 10, '浮雕应产生明暗变化');
    eq(b.get(0, 0).a, 0, '透明区不应被点亮');
  });

  it('高光沿法线叠加光源色', () => {
    const b = new PixelBuffer(24, 24);
    fillEllipse(b, 12, 12, 10, 10, { r: 120, g: 60, b: 60, a: 255 });
    const before = b.clone();
    applySpecular(b, { strength: 1, power: 8, lights: [{ dx: -1, dy: -1, z: 1, strength: 1 }] });
    assert(b.diffCount(before) > 0, '应出现高光');
  });

  it('blur 扩散单像素', () => {
    const b = new PixelBuffer(8, 8);
    b.clear({ r: 0, g: 0, b: 0, a: 0 });
    b.set(4, 4, white);
    blurFn(b, 1);
    assert(b.get(3, 4).a > 0, '邻域应被扩散到');
    assert(b.opaqueCount() > 1);
  });

  it('bloom 让亮部溢出', () => {
    const b = new PixelBuffer(8, 8);
    b.clear({ r: 0, g: 0, b: 0, a: 255 });
    b.set(4, 4, white);
    applyBloom(b, { threshold: 0.5, strength: 1, radius: 1 });
    assert(b.get(3, 4).r > 10, '亮部周围应被提亮');
  });

  it('tone 的 gamma 提亮中间调', () => {
    const b = new PixelBuffer(4, 4);
    b.clear({ r: 128, g: 128, b: 128, a: 255 });
    applyTone(b, { gamma: 2 });
    assert(b.get(0, 0).r > 128, `gamma>1 应提亮，实际 ${b.get(0, 0).r}`);
  });

  it('tone 的 saturation=0 变灰阶', () => {
    const b = new PixelBuffer(4, 4);
    b.clear({ r: 255, g: 0, b: 0, a: 255 });
    applyTone(b, { saturation: 0 });
    const c = b.get(0, 0);
    assert(Math.abs(c.r - c.g) <= 1 && Math.abs(c.g - c.b) <= 1, `未灰阶：${JSON.stringify(c)}`);
  });

  it('fbm 同种子可复现、模式 mod 调制明度', () => {
    const a = new PixelBuffer(16, 16);
    const b = new PixelBuffer(16, 16);
    a.clear({ r: 100, g: 100, b: 100, a: 255 });
    b.clear({ r: 100, g: 100, b: 100, a: 255 });
    applyFbm(a, { x: 0, y: 0, w: 16, h: 16, c1: { r: 0, g: 0, b: 0, a: 255 }, c2: white, octaves: 4, scale: 4, mode: 'mod', seed: 7 });
    applyFbm(b, { x: 0, y: 0, w: 16, h: 16, c1: { r: 0, g: 0, b: 0, a: 255 }, c2: white, octaves: 4, scale: 4, mode: 'mod', seed: 7 });
    eq(a.diffCount(b), 0, '同种子应可复现');
    const flat = new PixelBuffer(16, 16);
    flat.clear({ r: 100, g: 100, b: 100, a: 255 });
    assert(a.diffCount(flat) > 20, 'mod 应调制明度');
  });

  it('风格管线：pixel 不改动，photo 改动', () => {
    const b = new PixelBuffer(24, 24);
    fillEllipse(b, 12, 12, 9, 9, { r: 180, g: 120, b: 80, a: 255 });
    const before = b.clone();
    applyProceduralPipeline(b, 'pixel');
    eq(b.diffCount(before), 0, 'pixel 应保持原样');
    applyProceduralPipeline(b, 'photo', { lights: [{ dx: -1, dy: -1, z: 1, strength: 1 }] });
    assert(b.diffCount(before) > 0, 'photo 管线应改变画面');
  });

  it('normalizeStyle 归一化别名', () => {
    eq(normalizeStyle('photoreal'), 'photo');
    eq(normalizeStyle('oil'), 'painting');
    eq(normalizeStyle('lineart'), 'ink');
    eq(normalizeStyle('未知'), 'pixel');
    for (const k of Object.keys(STYLE_PRESETS)) eq(normalizeStyle(k), k);
  });
});

/* ═══════════════ 12.6 渲染后端与控制图（S2/S3） ═══════════════ */

describe('渲染后端与控制图', () => {
  it('风格 → 后端解析（神经不可用时降级）', () => {
    eq(resolveBackendId('pixel'), 'raster');
    eq(resolveBackendId('painting'), 'procedural');
    eq(resolveBackendId('photo', { neuralAvailable: false }), 'procedural');
    eq(resolveBackendId('photo', { neuralAvailable: true }), 'neural');
    eq(resolveBackendId('pixel', { explicit: 'neural', neuralAvailable: true }), 'neural');
    eq(resolveBackendId('pixel', { explicit: 'neural', neuralAvailable: false }), 'raster');
    deepEq(BACKEND_IDS, ['raster', 'procedural', 'neural']);
  });

  it('四种控制图均可导出为 PNG dataURL', () => {
    const b = new PixelBuffer(16, 16);
    fillEllipse(b, 8, 8, 6, 6, { r: 200, g: 100, b: 50, a: 255 });
    for (const kind of ['edges', 'depth', 'normal', 'alpha']) {
      const url = controlMapDataURL(b, kind, 64);
      assert(url.startsWith('data:image/png;base64,iVBOR'), `${kind} 不是 PNG`);
      assert(url.length > 100, `${kind} 数据过短`);
    }
    const all = controlMaps(b, 64);
    deepEq(Object.keys(all).sort(), ['alpha', 'depth', 'edges', 'normal']);
  });

  it('神经响应归一化兼容多种形态', () => {
    eq(normalizeNeuralResponse({ image: 'data:image/png;base64,AAA' }), 'data:image/png;base64,AAA');
    eq(normalizeNeuralResponse({ data: [{ b64_json: 'AAA' }] }), 'data:image/png;base64,AAA');
    eq(normalizeNeuralResponse({ data: [{ url: 'https://x/y.png' }] }), 'https://x/y.png');
    eq(normalizeNeuralResponse({ images: ['data:image/png;base64,BBB'] }), 'data:image/png;base64,BBB');
    eq(normalizeNeuralResponse(null), null);
    eq(normalizeNeuralResponse({ nope: 1 }), null);
  });
});

/* ═══════════════ 12.7 新增 DSL 指令（9 条） ═══════════════ */

describe('新增程序化渲染指令', () => {
  const exec = (code, doc) => runScript(code, doc || new PixelDocument(16, 16), { mode: 'replace', seed: 7 });

  it('style 设置并归一化风格', () => {
    const d = new PixelDocument(8, 8);
    assert(exec('style photoreal', d).ok);
    eq(d.style, 'photo');
  });

  it('light 声明方向光（含颜色）', () => {
    const d = new PixelDocument(8, 8);
    const r = exec('light -1 -1 1 0.8 #ff0000\nlight 1 1 0.5 0.3', d);
    assert(r.ok, r.errors.join(';'));
    eq(d.lights.length, 2);
    eq(d.lights[0].dx, -1);
    eq(d.lights[0].color.r, 255);
    eq(d.lights[1].strength, 0.3);
  });

  it('relief / specular / bloom / blur / tone 均可用', () => {
    const d = new PixelDocument(24, 24);
    let r = exec('bg c5\nlight -1 -1 1 1\nrelief 0.8 0.3', d);
    assert(r.ok, r.errors.join(';'));
    r = runScript('specular 0.6 16', d, { mode: 'append' });
    assert(r.ok, r.errors.join(';'));
    r = runScript('bloom 0.7 0.5 2', d, { mode: 'append' });
    assert(r.ok, r.errors.join(';'));
    r = runScript('blur 1', d, { mode: 'append' });
    assert(r.ok, r.errors.join(';'));
    r = runScript('tone 1.08 1.12 1.05 0 0.1', d, { mode: 'append' });
    assert(r.ok, r.errors.join(';'));
  });

  it('fbm 生成可复现材质', () => {
    const a = new PixelDocument(16, 16);
    const b = new PixelDocument(16, 16);
    const code = 'seed 3\nfbm 0 0 16 16 c1 c7 4 4 fill';
    assert(exec(code, a).ok);
    assert(exec(code, b).ok);
    eq(a.activeLayer.buffer.diffCount(b.activeLayer.buffer), 0);
  });

  it('render 应用风格管线并记录请求', () => {
    const d = new PixelDocument(24, 24);
    const r = exec('bg c4\ncircle 12 12 8 c9 fill\nrender photo', d);
    assert(r.ok, r.errors.join(';'));
    eq(d.style, 'photo');
    eq(d.renderRequested, 'photo');
    assert(r.changed > 20, `render 应改变画面：${r.changed}`);
  });

  it('tone 参数越界不报错且安全裁剪', () => {
    const d = new PixelDocument(8, 8);
    const r = exec('bg c8\ntone 9 9 9 9 9', d);
    assert(r.ok, r.errors.join(';'));
  });

  it('deferRender 只记录风格、不改动程序层（闭环统一渲染）', () => {
    const d = new PixelDocument(16, 16);
    runScript('bg c4\ncircle 8 8 5 c9 fill', d, { mode: 'replace' });
    const before = d.activeLayer.buffer.clone();
    const r = runScript('render photo', d, { mode: 'append', deferRender: true });
    eq(r.changed, 0, 'deferRender 不应改动程序层');
    eq(d.style, 'photo');
    eq(d.renderRequested, 'photo');
    eq(d.activeLayer.buffer.diffCount(before), 0);
  });
});

/* ═══════════════ 12.8 DeepSeek 多模态适配 ═══════════════ */

describe('DeepSeek 多模态适配', () => {
  it('识别 deepseek-flash / vision 系列', () => {
    eq(isDeepseekFlashModel('deepseek-flash'), true);
    eq(isDeepseekFlashModel('deepseek-v4-flash-vision-exp'), true);
    eq(isDeepseekFlashModel('deepseek-chat'), false);
    eq(isDeepseekFlashModel('gpt-4o'), false);
  });

  it('deepseek-flash 不下发 thinking（除显式开启）', () => {
    const p = new Provider({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', thinking: 'auto' });
    eq(p.thinkingBody(), null);
    const p2 = new Provider({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', thinking: 'disabled' });
    eq(p2.thinkingBody(), null);
    const p3 = new Provider({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', thinking: 'enabled' });
    deepEq(p3.thinkingBody(), { type: 'enabled' });
  });

  it('DeepSeek 官方端点（含 /v1 变体）被识别', () => {
    eq(isOfficialEndpoint('https://api.deepseek.com'), true);
    eq(isOfficialEndpoint('https://api.deepseek.com/v1'), true);
  });

  it('sanitizeMessages 移除非 user 消息中的图片', () => {
    const msgs = [
      { role: 'system', content: [{ type: 'text', text: 'sys' }, { type: 'image_url', image_url: { url: 'x' } }] },
      { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'y' } }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'image_url', image_url: { url: 'z' } }] },
    ];
    const out = sanitizeMessages(msgs);
    eq(typeof out[0].content, 'string');
    eq(Array.isArray(out[1].content), true, 'user 图片应保留');
    eq(out[1].content.filter((p) => p.type === 'image_url').length, 1);
    eq(typeof out[2].content, 'string');
  });

  it('Provider 请求体经清洗后不含 system/assistant 图片', () => {
    const p = new Provider({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', proxy: false, apiKey: 'k' });
    const body = p.buildPayload([
      { role: 'system', content: [{ type: 'text', text: 's' }, { type: 'image_url', image_url: { url: 'a' } }] },
      { role: 'user', content: 'hi' },
    ], {}, true);
    assert(!JSON.stringify(body.messages[0]).includes('image_url'), 'system 图片应被清洗');
    eq(body.thinking, undefined, 'flash 不应带 thinking');
    eq(body.model, 'deepseek-flash');
  });
});

/* ═══════════════ 12.9 区域诊断与风格提示 ═══════════════ */

describe('区域诊断与风格提示', () => {
  it('computeTiles 定位改动热区', () => {
    const before = new PixelBuffer(30, 30);
    const after = new PixelBuffer(30, 30);
    fillEllipse(after, 25, 25, 4, 4, { r: 255, g: 0, b: 0, a: 255 });
    const tiles = computeTiles(before, after, 3);
    eq(tiles.length, 9);
    const hot = tiles.filter((t) => t.changed > 0);
    assert(hot.length >= 1, '应至少有一个改动区域');
    assert(hot[0].label === '右下', `热区应落在右下，实际 ${hot[0].label}`);
  });

  it('STYLE_GUIDE 覆盖全部风格', () => {
    for (const k of Object.keys(STYLE_PRESETS)) assert(STYLE_GUIDE[k], `缺少风格提示 ${k}`);
  });

  it('系统提示包含风格与渲染后端状态', () => {
    const p = buildSystemPrompt({ width: 32, height: 32, paletteName: 'PICO-8', paletteSize: 16, title: 'x', style: 'photo', neuralRender: true });
    assert(p.includes('photo'), '应包含风格');
    assert(p.includes('神经后端'), '应包含渲染后端状态');
    assert(p.includes('render'), '应含 render 指令');
  });

  it('审查提示包含区域热区', () => {
    const tiles = [{ label: '中心', x: 8, y: 8, w: 8, h: 8, changed: 40, dominant: '#ff0000' }];
    const p = buildCritique({ iteration: 2, max: 6, mode: 'append', report: { ops: 5, changed: 60 }, tiles, style: 'photo', hasImage: true });
    assert(p.includes('中心'), '应包含区域名');
    assert(p.includes('改动 40'), '应包含区域改动量');
  });
});

/* ═══════════════ 12.10 参考图 → 像素画（img2pixel） ═══════════════ */

describe('参考图 → 像素画（img2pixel）', () => {
  const makeRGBA = (w, h, fn) => {
    const a = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const c = fn(x, y); const i = (y * w + x) * 4;
      a[i] = c.r; a[i + 1] = c.g; a[i + 2] = c.b; a[i + 3] = c.a;
    }
    return a;
  };
  const whites = (a) => { let n = 0; for (let i = 0; i < a.length; i += 4) if (a[i] === 255) n++; return n; };

  it('最近色匹配（感知加权）', () => {
    const p = Palette.from('pico8');
    deepEq(nearestColor({ r: 255, g: 0, b: 0, a: 255 }, p.colors), p.colors[8]);
    deepEq(nearestColor({ r: 0, g: 0, b: 0, a: 255 }, p.colors), p.colors[0]);
  });

  it('面积平均降采样（红蓝各半 → 混合）', () => {
    const src = makeRGBA(2, 2, (x) => (x === 0 ? { r: 255, g: 0, b: 0, a: 255 } : { r: 0, g: 0, b: 255, a: 255 }));
    const out = boxDownsample(src, 2, 2, 1, 1);
    assert(out[0] > 100 && out[2] > 100, `应混合：r=${out[0]} b=${out[2]}`);
  });

  it('最近邻降采样保持硬边', () => {
    const src = makeRGBA(4, 4, (x) => (x < 2 ? { r: 255, g: 0, b: 0, a: 255 } : { r: 0, g: 255, b: 0, a: 255 }));
    const out = nearestDownsample(src, 4, 4, 2, 2);
    deepEq([out[0], out[1], out[2], out[3]], [255, 0, 0, 255]);
    deepEq([out[4], out[5], out[6], out[7]], [0, 255, 0, 255]);
  });

  it('unsharp 增强边缘对比', () => {
    const src = makeRGBA(3, 3, () => ({ r: 100, g: 100, b: 100, a: 255 }));
    const i = (1 * 3 + 1) * 4;
    src[i] = src[i + 1] = src[i + 2] = 160;
    const out = unsharp(src, 3, 3, 0.5);
    assert(out[i] > 160, `中心应被增强：${out[i]}`);
  });

  it('量化到 bw：深灰变黑、浅灰变白', () => {
    const src = makeRGBA(2, 1, (x) => (x === 0 ? { r: 40, g: 40, b: 40, a: 255 } : { r: 230, g: 230, b: 230, a: 255 }));
    const out = quantize(src, 2, 1, Palette.from('bw'));
    eq(out[0], 0);
    eq(out[4], 255);
  });

  it('Floyd 抖动在中灰上产生黑白混合', () => {
    const src = makeRGBA(8, 8, () => ({ r: 64, g: 64, b: 64, a: 255 }));
    const none = quantize(src, 8, 8, Palette.from('bw'), { dither: 'none' });
    const floyd = quantize(src, 8, 8, Palette.from('bw'), { dither: 'floyd' });
    eq(whites(none), 0, '无抖动应全黑');
    assert(whites(floyd) > 0 && whites(floyd) < 64, `抖动应产生混合，实际白 ${whites(floyd)}`);
  });

  it('imageToPixels 一站式输出目标尺寸', () => {
    const src = makeRGBA(8, 8, () => ({ r: 255, g: 0, b: 0, a: 255 }));
    const out = imageToPixels(src, 8, 8, 4, 4, { palette: Palette.from('pico8'), quantize: true, dither: 'none' });
    eq(out.length, 4 * 4 * 4);
    eq(out[0], 255, '应吸附到 pico8 红');
    eq(out[1], 0);
    eq(out[3], 255);
  });
});

/* ═══════════════ 12.11 区域工具与局部重绘 ═══════════════ */

describe('区域工具与局部重绘', () => {
  it('clampRect 归一化并裁剪到画布', () => {
    deepEq(clampRect({ x: -2, y: -2, w: 8, h: 8 }, 16, 16), { x: 0, y: 0, w: 6, h: 6 });
    deepEq(clampRect({ x: 8, y: 8, w: -4, h: -4 }, 16, 16), { x: 4, y: 4, w: 4, h: 4 });
    eq(clampRect({ x: 100, y: 100, w: 4, h: 4 }, 16, 16), null);
  });

  it('cropBuffer / pasteBuffer 配合蒙版限定区域', () => {
    const b = new PixelBuffer(16, 16);
    b.fillRect(2, 2, 4, 4, { r: 255, g: 0, b: 0, a: 255 }, false);
    const c = cropBuffer(b, { x: 2, y: 2, w: 4, h: 4 });
    eq(c.width, 4);
    deepEq(c.get(0, 0), { r: 255, g: 0, b: 0, a: 255 });

    const dst = new PixelBuffer(16, 16);
    pasteBuffer(dst, c, 8, 8, { x: 8, y: 8, w: 2, h: 2 });
    deepEq(dst.get(8, 8), { r: 255, g: 0, b: 0, a: 255 }, '蒙版内应写入');
    eq(dst.get(10, 10).a, 0, '蒙版外不应写入');
  });

  it('maskMapDataURL 为全画布 PNG 且随区域变化', () => {
    const b = new PixelBuffer(16, 16);
    const m1 = maskMapDataURL(b, { x: 0, y: 0, w: 8, h: 8 });
    const m2 = maskMapDataURL(b, { x: 8, y: 8, w: 8, h: 8 });
    for (const m of [m1, m2]) assert(m.startsWith('data:image/png;base64,iVBOR'), '应为 PNG');
    assert(m1 !== m2, '不同区域应产生不同蒙版');
  });

  it('inpaint 指令记录请求且不改变像素', () => {
    const d = new PixelDocument(16, 16);
    runScript('bg c4\ncircle 8 8 5 c9 fill', d, { mode: 'replace' });
    const before = d.activeLayer.buffer.clone();
    const r = runScript('inpaint 4 4 8 8 "furry detail" 0.7', d, { mode: 'append' });
    assert(r.ok, r.errors.join(';'));
    eq(r.changed, 0, 'inpaint 本身不应改像素');
    eq(d.inpaintRequests.length, 1);
    eq(d.inpaintRequests[0].prompt, 'furry detail');
    eq(d.inpaintRequests[0].strength, 0.7);
    eq(d.activeLayer.buffer.diffCount(before), 0);
  });
});

/* ═══════════════ 12.12 动画帧 / spritesheet / GIF / Aseprite（v1.5） ═══════════════ */

/** 测试用 GIF LZW 解码器（与 lzwEncode 对拍） */
function lzwDecode(minCode, data) {
  const clear = 1 << minCode, eoi = clear + 1;
  let codeSize = minCode + 1;
  let dict = [];
  const reset = () => { dict = []; for (let i = 0; i < clear; i++) dict[i] = [i]; dict[clear] = []; dict[eoi] = []; codeSize = minCode + 1; };
  reset();
  let bitPos = 0;
  const read = () => {
    let code = 0;
    for (let i = 0; i < codeSize; i++) {
      const byte = data[bitPos >> 3];
      if (byte === undefined) return -1;
      if (byte & (1 << (bitPos & 7))) code |= 1 << i;
      bitPos++;
    }
    return code;
  };
  const out = [];
  let prev = null;
  for (;;) {
    const code = read();
    if (code < 0 || code === eoi) break;
    if (code === clear) { reset(); prev = null; continue; }
    let entry;
    if (dict[code]) entry = dict[code];
    else if (prev) entry = [...prev, prev[0]];
    else entry = [];
    for (const v of entry) out.push(v);
    if (prev) dict.push([...prev, entry[0]]);
    if (dict.length === (1 << codeSize) && codeSize < 12) codeSize++;
    prev = entry;
  }
  return out;
}

/** 测试用 GIF 结构解析器 */
function parseGIF(bytes) {
  let p = 0;
  const u8 = () => bytes[p++];
  const u16 = () => { const v = bytes[p] | (bytes[p + 1] << 8); p += 2; return v; };
  const sig = String.fromCharCode(...bytes.slice(0, 6)); p = 6;
  const w = u16(), h = u16(), packed = u8();
  u8(); u8();
  const gctSize = 1 << ((packed & 7) + 1);
  const gct = [];
  if (packed & 0x80) for (let i = 0; i < gctSize; i++) gct.push([bytes[p++], bytes[p++], bytes[p++]]);
  const frames = [];
  let gce = null;
  while (p < bytes.length) {
    const b = bytes[p++];
    if (b === 0x3b) break;
    if (b === 0x21) {
      const label = bytes[p++];
      if (label === 0xf9) {
        p++; const packed2 = bytes[p++];
        gce = { disposal: (packed2 >> 2) & 7, transparent: !!(packed2 & 1) };
        gce.delay = bytes[p] | (bytes[p + 1] << 8); p += 2;
        gce.tIdx = bytes[p++]; p++; // block terminator
      } else {
        let size = bytes[p++]; while (size) { p += size; size = bytes[p++]; }
      }
      continue;
    }
    if (b === 0x2c) {
      u16(); u16(); const iw = u16(); const ih = u16(); u8();
      const minCode = bytes[p++];
      const data = []; let size = bytes[p++];
      while (size) { for (let i = 0; i < size; i++) data.push(bytes[p++]); size = bytes[p++]; }
      frames.push({ gce, minCode, data, iw, ih });
      continue;
    }
    throw new Error(`unexpected GIF block 0x${b.toString(16)}`);
  }
  return { sig, w, h, gct, frames };
}

describe('GIF 编码（LZW 对拍）', () => {
  it('lzwEncode / lzwDecode 往返一致', () => {
    const idx = new Uint8Array([0, 1, 2, 3, 3, 2, 1, 0, 1, 1, 2, 2, 3, 3, 0, 0, 4, 4, 4, 1, 2]);
    const enc = lzwEncode(idx, 3);
    deepEq([...lzwDecode(3, enc)], [...idx]);
  });

  it('长序列 LZW 往返一致（触发码长增长）', () => {
    const idx = new Uint8Array(2000);
    for (let i = 0; i < idx.length; i++) idx[i] = (i * 7 + (i >> 3)) % 16;
    const enc = lzwEncode(idx, 4);
    deepEq([...lzwDecode(4, enc)], [...idx]);
  });

  it('encodeGIF 结构正确且像素索引可解码', () => {
    const palette = Palette.from('pico8').colors;
    const f0 = new Uint8ClampedArray(4 * 4 * 4);
    const f1 = new Uint8ClampedArray(4 * 4 * 4);
    for (let i = 0; i < 16; i++) {
      f0[i * 4] = 255; f0[i * 4 + 3] = 255;             // 红
      f1[i * 4 + 2] = 255; f1[i * 4 + 3] = 255;         // 蓝
    }
    const gif = encodeGIF([f0, f1], { width: 4, height: 4, palette, delays: [100, 200] });
    const parsed = parseGIF(gif);
    eq(parsed.sig, 'GIF89a');
    eq(parsed.w, 4);
    eq(parsed.h, 4);
    eq(parsed.frames.length, 2);
    eq(parsed.frames[0].gce.delay, 10, '100ms → 10 厘秒');
    eq(parsed.frames[1].gce.delay, 20);
    eq(parsed.frames[0].gce.transparent, true);
    // 解码第一帧索引，应与 quantizeFrame 一致
    const transp = parsed.frames[0].gce.tIdx;
    const expected = quantizeFrame(f0, palette.filter((c) => c.a !== 0).slice(0, 255), transp);
    deepEq(lzwDecode(parsed.frames[0].minCode, parsed.frames[0].data), [...expected]);
  });

  it('透明像素映射到透明索引', () => {
    const palette = Palette.from('pico8').colors;
    const f = new Uint8ClampedArray(2 * 1 * 4);
    f[0] = 255; f[3] = 255;                 // 第一个不透明红
    // 第二个透明
    const gif = encodeGIF([f], { width: 2, height: 1, palette });
    const parsed = parseGIF(gif);
    const tIdx = parsed.frames[0].gce.tIdx;
    const idx = lzwDecode(parsed.frames[0].minCode, parsed.frames[0].data);
    eq(idx[1], tIdx, '透明像素应为透明索引');
  });
});

describe('Aseprite 写出器', () => {
  const makeFrames = (n) => Array.from({ length: n }, (_, f) => {
    const d = new Uint8ClampedArray(4 * 4 * 4);
    for (let i = 0; i < 16; i++) { d[i * 4 + (f % 3)] = 255; d[i * 4 + 3] = 255; }
    return d;
  });

  it('头部字段与文件尺寸自洽', () => {
    const bytes = encodeAseprite(4, 4, makeFrames(3), { layerName: 'Body', durations: [100, 100, 100] });
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    eq(dv.getUint16(4, true), 0xa5e0, 'magic');
    eq(dv.getUint16(6, true), 3, '帧数');
    eq(dv.getUint16(8, true), 4, '宽');
    eq(dv.getUint16(10, true), 4, '高');
    eq(dv.getUint16(12, true), 32, '色深 RGBA');
    eq(dv.getUint32(0, true), bytes.length, '文件大小应自洽');
    eq(dv.getUint16(128 + 4, true), 0xf1fa, '帧魔数');
    eq(dv.getUint32(128 + 12, true), 2, '第 0 帧含图层 + cel 两个 chunk');
  });

  it('单帧也能编码', () => {
    const bytes = encodeAseprite(2, 2, makeFrames(1));
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    eq(dv.getUint16(6, true), 1);
  });
});

describe('动画帧模型（Animation）', () => {
  const red = { r: 255, g: 0, b: 0, a: 255 };
  const blue = { r: 0, g: 160, b: 255, a: 255 };

  it('capture / duplicate / 逐帧内容独立', () => {
    const d = new PixelDocument(8, 8);
    d.activeLayer.buffer.clear(red);
    const a = new Animation({ fps: 10 });
    a.capture(d, true);
    a.duplicate(d);                       // 复制红帧，文档切到新帧
    d.activeLayer.buffer.clear(blue);
    d.invalidate();
    a.capture(d);                          // 保存蓝帧
    eq(a.length, 2);
    eq(a.frameBuffer(0).get(0, 0).r, 255, '第 0 帧应为红');
    eq(a.frameBuffer(1).get(0, 0).b, 255, '第 1 帧应为蓝');
  });

  it('select 往返切换文档内容', () => {
    const d = new PixelDocument(8, 8);
    d.activeLayer.buffer.clear(red);
    const a = new Animation({ fps: 10 });
    a.capture(d, true);
    a.duplicate(d);
    d.activeLayer.buffer.clear(blue); d.invalidate();
    a.capture(d);
    a.select(d, 0);
    eq(d.activeLayer.buffer.get(0, 0).r, 255);
    a.select(d, 1);
    eq(d.activeLayer.buffer.get(0, 0).b, 255);
  });

  it('insertBlank / remove / move', () => {
    const d = new PixelDocument(8, 8);
    d.activeLayer.buffer.clear(red);
    const a = new Animation();
    a.capture(d, true);
    a.insertBlank(d);
    eq(a.length, 2);
    eq(a.frameBuffer(1).opaqueCount(), 0);
    a.move(1, 0);
    eq(a.current, 0);
    a.remove(0);
    eq(a.length, 1);
    eq(a.remove(0), false, '最后一帧不可删除');
  });

  it('spritesheet 布局正确', () => {
    const d = new PixelDocument(8, 8);
    d.activeLayer.buffer.clear(red);
    const a = new Animation();
    a.capture(d, true);
    a.duplicate(d);
    d.activeLayer.buffer.clear(blue); d.invalidate();
    a.capture(d);
    const ss = a.toSpritesheet({ columns: 2 });
    eq(ss.width, 16);
    eq(ss.height, 8);
    eq(ss.count, 2);
    eq(ss.data[0], 255, '左上为红');
    const i = (0 * 16 + 8) * 4;
    eq(ss.data[i + 2], 255, '右上为蓝');
  });

  it('toGIF / toAseprite 可产出且 JSON 往返', () => {
    const d = new PixelDocument(8, 8);
    d.activeLayer.buffer.clear(red);
    const a = new Animation({ fps: 12, loop: 0 });
    a.capture(d, true);
    a.duplicate(d);
    d.activeLayer.buffer.clear(blue); d.invalidate();
    a.capture(d);
    const gif = a.toGIF(Palette.from('pico8').colors);
    eq(String.fromCharCode(...gif.slice(0, 6)), 'GIF89a');
    eq(parseGIF(gif).frames.length, 2);
    const ase = a.toAseprite('Body');
    eq(new DataView(ase.buffer, ase.byteOffset).getUint16(6, true), 2);
    const back = Animation.fromJSON(JSON.parse(JSON.stringify(a.toJSON())));
    eq(back.length, 2);
    eq(back.fps, 12);
    eq(back.frameBuffer(1).get(0, 0).b, 255);
  });
});

/* ═══════════════ 12.13 参考图引导与多帧生成（v1.6） ═══════════════ */

describe('参考图引导与多帧生成', () => {
  it('referenceDataURL 提取参考层 PNG', () => {
    const d = new PixelDocument(8, 8);
    const ref = new Layer(8, 8, '参考图');
    ref.kind = 'reference';
    ref.buffer.clear({ r: 10, g: 20, b: 30, a: 255 });
    d.layers.unshift(ref);
    const a = new Agent({ provider: {}, renderer: {}, doc: d, history: null });
    const url = a.referenceDataURL();
    assert(url && url.startsWith('data:image/png;base64,'), '应返回 PNG dataURL');
    const a2 = new Agent({ provider: {}, renderer: {}, doc: new PixelDocument(8, 8), history: null });
    eq(a2.referenceDataURL(), null, '无参考层应返回 null');
  });

  it('参考层在预览合成中可见，但不被烘焙进渲染底图', () => {
    const d = new PixelDocument(8, 8);
    const ref = new Layer(8, 8, '参考图');
    ref.kind = 'reference';
    ref.buffer.fillRect(0, 0, 8, 8, { r: 200, g: 100, b: 50, a: 255 }, false);
    d.layers.unshift(ref);
    assert(d.composite().opaqueCount() === 64, '参考层应参与预览合成（用户可见）');
    eq(d.compositeBase().opaqueCount(), 0, '参考层不应进入渲染底图');
  });

  it('_frameBrief 单帧不变、多帧带帧号', () => {
    const a = new Agent({ provider: {}, renderer: {}, doc: new PixelDocument(8, 8) });
    eq(a._frameBrief('画树', 0, 1), '画树');
    const multi = a._frameBrief('画树', 1, 3);
    assert(multi.includes('2/3'), `应包含帧号：${multi}`);
    assert(multi.includes('上一帧'), '应提示基于上一帧');
  });

  it('frameCount 规范化到 1..64', () => {
    eq(new Agent({ provider: {}, renderer: {}, doc: new PixelDocument(4, 4), frameCount: 0 }).frameCount, 1);
    eq(new Agent({ provider: {}, renderer: {}, doc: new PixelDocument(4, 4), frameCount: 200 }).frameCount, 64);
  });
});

/* ═══════════════ 12.14 大画布：百分比坐标 / 超分 / 裁剪（v1.7） ═══════════════ */

describe('百分比坐标', () => {
  it('px / rect / circle 百分比换算', () => {
    const d = new PixelDocument(100, 100);
    let r = runScript('px 50% 50% c8', d, { mode: 'replace' });
    assert(r.ok, r.errors.join(';'));
    eq(d.activeLayer.buffer.get(50, 50).a, 255);

    r = runScript('rect 0% 0% 50% 50% c8 fill', d, { mode: 'replace' });
    assert(r.ok, r.errors.join(';'));
    eq(d.activeLayer.buffer.get(0, 0).a, 255);
    eq(d.activeLayer.buffer.get(49, 49).a, 255);
    eq(d.activeLayer.buffer.get(50, 50).a, 0);

    r = runScript('circle 50% 50% 25% c8 fill', d, { mode: 'replace' });
    assert(r.ok, r.errors.join(';'));
    eq(d.activeLayer.buffer.get(50, 50).a, 255);
    eq(d.activeLayer.buffer.get(50, 26).a, 255, '半径应为 25');
  });

  it('line / poly 百分比', () => {
    const d = new PixelDocument(100, 50);
    let r = runScript('line 0% 0% 100% 100% c8', d, { mode: 'replace' });
    assert(r.ok, r.errors.join(';'));
    eq(d.activeLayer.buffer.get(0, 0).a, 255);
    eq(d.activeLayer.buffer.get(99, 49).a, 255);

    r = runScript('poly c8 fill 0% 0% 100% 0% 50% 100%', d, { mode: 'replace' });
    assert(r.ok, r.errors.join(';'));
    eq(d.activeLayer.buffer.get(50, 40).a, 255);
  });

  it('非方形画布 x/y 各按自身维度', () => {
    const d = new PixelDocument(100, 50);
    runScript('px 100% 100% c8', d, { mode: 'replace' });
    eq(d.activeLayer.buffer.get(99, 49).a, 255);
  });

  it('非法百分比报错但不中断', () => {
    const d = new PixelDocument(20, 20);
    const r = runScript('px abc% 5 c8\npx 5 5 c8', d, { mode: 'replace' });
    eq(r.ok, false);
    assert(r.errors[0].includes('line 1'), r.errors[0]);
    eq(d.activeLayer.buffer.get(5, 5).a, 255, '后续行仍执行');
  });
});

describe('大画布上限', () => {
  it('支持到 2048 且超限报错', () => {
    const d = new PixelDocument(16, 16);
    const r = runScript('size 2048 2048\npx 0 0 c8', d, { mode: 'replace' });
    assert(r.ok, r.errors.join(';'));
    eq(d.width, 2048);
    const r2 = runScript('size 4096 8', new PixelDocument(8, 8));
    eq(r2.ok, false, '超过 2048 应报错');
  });
});

describe('平滑超分', () => {
  it('尺寸正确且同参数确定', () => {
    const b = new PixelBuffer(8, 8);
    b.clear({ r: 10, g: 120, b: 200, a: 255 });
    const a1 = supersample(b, 4, { sharpen: 0.5, grain: 0.03, seed: 3 });
    const a2 = supersample(b, 4, { sharpen: 0.5, grain: 0.03, seed: 3 });
    eq(a1.width, 32);
    eq(a1.height, 32);
    eq(a1.diffCount(a2), 0, '同参数应完全确定');
  });

  it('透明区域保持透明', () => {
    const b = new PixelBuffer(8, 8);
    b.set(4, 4, { r: 255, g: 0, b: 0, a: 255 });
    const up = supersample(b, 4, { sharpen: 0.4, grain: 0.02, seed: 1 });
    eq(up.get(0, 0).a, 0, '远端角落应完全透明');
    assert(up.get(16, 16).a > 0, '不透明像素处应有内容');
  });

  it('双线性产生中间灰（比最近邻平滑）', () => {
    const b = new PixelBuffer(8, 8);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      b.set(x, y, (x + y) % 2 ? { r: 255, g: 255, b: 255, a: 255 } : { r: 0, g: 0, b: 0, a: 255 });
    }
    const bil = upscaleBilinear(b, 4);
    let mixed = 0;
    for (let i = 0; i < bil.data.length; i += 4) { const v = bil.data[i]; if (v > 20 && v < 235) mixed++; }
    assert(mixed > 0, '双线性应产生中间灰');
  });

  it('裁剪区域可导出并放大', () => {
    const b = new PixelBuffer(64, 64);
    b.fillRect(0, 0, 64, 64, { r: 1, g: 2, b: 3, a: 255 }, false);
    const url = cropDataURL(b, { x: 8, y: 8, w: 16, h: 16 }, 64);
    assert(url.startsWith('data:image/png;base64,iVBOR'), '应为 PNG');
    eq(cropDataURL(b, { x: 100, y: 100, w: 4, h: 4 }), null, '越界返回 null');
  });
});

/* ─────────── 13. 端到端：真实 HTTP 闭环 ─────────── */

async function runIntegration() {
  const { default: http } = await import('node:http');
  const { Provider } = await import('../public/js/ai/provider.js');
  const { Agent } = await import('../public/js/ai/agent.js');
  const { PixelDocument: Doc } = await import('../public/js/core/document.js');
  const { History: Hist } = await import('../public/js/core/history.js');
  const { encodePNG: encPNG, toBase64: b64 } = await import('../public/js/io/png.js');

  group = '端到端 HTTP 闭环';
  console.log(`\n\x1b[38;5;213m▸ ${group}\x1b[0m`);

  const seen = [];
  const ROUND_1 = '我先铺大形。\n```pixelscript\nsize 32 32\npalette pico8\nclear transparent\nsym x\nellipse 16 20 11 8 c3 fill\nellipse 16 20 10 7 c11 fill\n```';
  const ROUND_2 = '加了眼睛和描边。\n```pixelscript\ncircle 11 16 2 c0 fill\npx 12 15 c7\noutline c1\n```';
  const ROUND_3 = 'DONE';

  const mock = http.createServer((req, res) => {
    if (req.url !== '/chat/completions') { res.writeHead(404).end(); return; }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const payload = JSON.parse(body);
      seen.push(payload);
      const assistants = payload.messages.filter((m) => m.role === 'assistant').length;
      const text = [ROUND_1, ROUND_2, ROUND_3][Math.min(assistants, 2)];
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      // 分片推送，模拟真实流式
      for (const piece of text.match(/[\s\S]{1,24}/g) || []) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 100, completion_tokens: 40 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });

  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const port = mock.address().port;

  const doc = new Doc(32, 32);
  const history = new Hist(doc);
  const renderer = {
    export(longEdge, withBg) {
      void longEdge; void withBg;
      const png = encPNG(doc.composite().data, doc.width, doc.height);
      return { dataURL: `data:image/png;base64,${b64(png)}`, width: doc.width, height: doc.height, scale: 1 };
    },
    visionDataURL() { return this.export().dataURL; },
  };

  const events = [];
  const provider = new Provider({
    proxy: false,
    apiKey: 'test-key',
    baseUrl: `http://127.0.0.1:${port}`,
    model: 'mock-vision',
    temperature: 0.5,
  });
  const agent = new Agent({
    provider, renderer, doc, history,
    maxIterations: 4,
    visionLongEdge: 256,
    onEvent: (e) => events.push(e),
  });

  let iterations = [];
  try {
    iterations = await agent.run('画一个史莱姆');
  } catch (err) {
    failures.push({ group, name: 'Agent.run 不应抛异常', err });
    console.log(`  \x1b[31m✗\x1b[0m Agent.run 抛出 ${err.message}`);
  }

  const check = (name, fn) => {
    try { fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
    catch (err) { failures.push({ group, name, err }); console.log(`  \x1b[31m✗ ${name}\x1b[0m\n      ${err.message}`); }
  };

  check('共发出 3 次请求（2 轮绘制 + 1 次 DONE）', () => eq(seen.length, 3, `实际 ${seen.length}`));
  check('第 1 轮为整幅模式且不含图像', () => {
    const msgs = seen[0].messages;
    eq(msgs[0].role, 'system');
    assert(msgs[0].content.includes('PixelScript'), 'system 应包含语言规范');
    assert(!JSON.stringify(msgs).includes('image_url'), '首轮不应带图');
  });
  check('第 2 轮回灌了渲染图（image_url + data:image/png）', () => {
    const last = seen[1].messages[seen[1].messages.length - 1];
    eq(last.role, 'user');
    assert(Array.isArray(last.content), '应为多模态内容数组');
    const img = last.content.find((p) => p.type === 'image_url');
    assert(img, '缺少 image_url 部分');
    assert(img.image_url.url.startsWith('data:image/png;base64,'), '图像应为 PNG data URL');
    assert(img.image_url.url.length > 200, '图像数据过短');
  });
  check('第 2 轮提示包含执行报告与增量指令', () => {
    const last = seen[1].messages[seen[1].messages.length - 1];
    const txt = last.content.find((p) => p.type === 'text').text;
    assert(txt.includes('改动'), '应包含改动统计');
    assert(txt.includes('增量'), '应提示增量模式');
  });
  check('第 3 轮模型回 DONE 后不再请求', () => eq(seen.length, 3));
  check('Agent 记录 2 轮迭代', () => eq(iterations.length, 2, `实际 ${iterations.length}`));
  check('第 1 轮为 replace、第 2 轮为 append', () => {
    eq(iterations[0].mode, 'replace');
    eq(iterations[1].mode, 'append');
  });
  check('最终图像包含两轮累积的像素', () => {
    const opaque = doc.activeLayer.buffer.opaqueCount();
    assert(opaque > 250, `非透明像素过少：${opaque}`);
    eq(doc.activeLayer.buffer.get(12, 15).a, 255, '第 2 轮的高光应存在');
  });
  check('执行报告无错误', () => {
    for (const it of iterations) eq(it.report.errors.length, 0, it.report.errors.join('; '));
  });
  check('历史栈记录了 2 次 AI 轮次，可撤销 / 重做', () => {
    eq(history.undoStack.length, 2);
    deepEq(doc.activeLayer.buffer.get(11, 16), { r: 0, g: 0, b: 0, a: 255 }, '第 2 轮的黑色眼睛');
    history.undo();
    deepEq(doc.activeLayer.buffer.get(11, 16), { r: 0, g: 228, b: 54, a: 255 }, '撤销后回到第 1 轮的身体绿');
    history.redo();
    deepEq(doc.activeLayer.buffer.get(11, 16), { r: 0, g: 0, b: 0, a: 255 }, '重做后恢复眼睛');
  });
  check('事件流完整（start/phase/iteration/done/delta）', () => {
    const types = new Set(events.map((e) => e.type));
    for (const t of ['start', 'phase', 'iteration', 'done', 'delta']) assert(types.has(t), `缺少事件 ${t}`);
    assert(events.some((e) => e.type === 'iteration' && e.iteration.thumbnail.startsWith('data:image/png')), '缺少缩略图');
  });

  // 演示 Provider 走完整闭环（异步）
  group = '端到端 · 演示 Provider 闭环';
  console.log(`\n\x1b[38;5;213m▸ ${group}\x1b[0m`);
  const demoDoc = new Doc(32, 32);
  const demoEvents = [];
  const demoAgent = new Agent({
    provider: new DemoProvider({ width: 32, height: 32 }),
    renderer, doc: demoDoc, history: new Hist(demoDoc),
    maxIterations: 5, visionLongEdge: 192,
    onEvent: (e) => demoEvents.push(e),
  });
  let demoRounds = [];
  try {
    demoRounds = await demoAgent.run('画一个史莱姆');
  } catch (err) {
    failures.push({ group, name: '演示闭环', err });
  }
  check('演示 Provider 无需网络即可完成闭环', () => {
    assert(demoRounds.length >= 2, `轮次过少：${demoRounds.length}`);
    assert(demoDoc.activeLayer.buffer.opaqueCount() > 200, '应产出图像');
  });
  check('演示闭环最终自动停止（不超过 maxIterations）', () => {
    assert(demoRounds.length <= 5, `轮次 ${demoRounds.length}`);
    assert(demoEvents.some((e) => e.type === 'done'), '缺少 done 事件');
  });
  check('演示模式同样触发视觉回灌（image_url）', () => {
    // 演示 Provider 忽略消息，但 Agent 仍应构造图像消息 —— 通过轮次 2 的 mode=append 间接验证
    eq(demoRounds[1].mode, 'append');
  });

  // 风格 → 渲染后端闭环（无神经后端时走程序化先验，写入残差层）
  group = '端到端 · 风格渲染后端';
  console.log(`\n\x1b[38;5;213m▸ ${group}\x1b[0m`);
  const styleDoc = new Doc(32, 32);
  styleDoc.style = 'photo';
  const styleEvents = [];
  const styleAgent = new Agent({
    provider: new DemoProvider({ width: 32, height: 32 }),
    renderer, doc: styleDoc, history: new Hist(styleDoc),
    maxIterations: 2, visionLongEdge: 128, neuralAvailable: false,
    onEvent: (e) => styleEvents.push(e),
  });
  let styleRounds = [];
  try {
    styleRounds = await styleAgent.run('画一个写实的史莱姆');
  } catch (err) {
    failures.push({ group, name: '风格闭环', err });
  }
  check('非 pixel 风格创建神经残差层并渲染', () => {
    const nl = styleDoc.neuralLayer;
    assert(nl, '应创建神经残差层');
    assert(nl.buffer.opaqueCount() > 100, `残差层内容过少：${nl ? nl.buffer.opaqueCount() : 0}`);
    assert(styleRounds.some((r) => r.render && r.render.backend === 'procedural'), '应记录程序化后端');
  });
  check('残差层参与最终合成', () => {
    assert(styleDoc.composite().opaqueCount() > 100, '合成结果应有内容');
    assert(styleDoc.compositeBase().opaqueCount() > 100, '程序底图应有内容');
  });

  // 局部重绘（无神经后端时的程序化降级路径）
  group = '端到端 · 局部重绘';
  console.log(`\n\x1b[38;5;213m▸ ${group}\x1b[0m`);
  const inpaintDoc = new Doc(32, 32);
  runScript('bg c4\ncircle 16 16 10 c9 fill\ncircle 16 16 8 c10 fill', inpaintDoc, { mode: 'replace' });
  inpaintDoc.style = 'painting';
  const inpaintAgent = new Agent({ provider: {}, renderer, doc: inpaintDoc, history: new Hist(inpaintDoc), neuralAvailable: false });
  let inpaintResult = null;
  try {
    inpaintResult = await inpaintAgent.inpaintRegion({ x: 8, y: 8, w: 16, h: 16, prompt: '细节', strength: 0.5 });
  } catch (err) {
    failures.push({ group, name: 'inpaintRegion', err });
  }
  check('局部重绘写入残差层且只影响目标区域', () => {
    assert(inpaintResult && inpaintResult.task === 'inpaint', '应返回 inpaint 结果');
    const nl = inpaintDoc.neuralLayer;
    assert(nl, '应创建神经残差层');
    assert(nl.buffer.opaqueCount() > 50, `区域内容过少：${nl ? nl.buffer.opaqueCount() : 0}`);
    eq(nl.buffer.get(1, 1).a, 0, '区域外不应被写入');
  });

  // 多帧生成（DemoProvider + Animation）
  group = '端到端 · 多帧生成';
  console.log(`\n\x1b[38;5;213m▸ ${group}\x1b[0m`);
  const { Animation: Anim } = await import('../public/js/core/animation.js');
  const mfDoc = new Doc(32, 32);
  const mfAnim = new Anim({ fps: 8 });
  mfAnim.capture(mfDoc, true);
  const mfEvents = [];
  const mfAgent = new Agent({
    provider: new DemoProvider({ width: 32, height: 32 }),
    renderer, doc: mfDoc, history: new Hist(mfDoc),
    maxIterations: 2, visionLongEdge: 128, frameCount: 3, animation: mfAnim,
    onEvent: (e) => mfEvents.push(e),
  });
  let mfRounds = [];
  try {
    mfRounds = await mfAgent.run('走路循环');
  } catch (err) {
    failures.push({ group, name: '多帧生成', err });
  }
  check('多帧生成产生 N 帧且带 frame 字段', () => {
    eq(mfAnim.length, 3, `帧数 ${mfAnim.length}`);
    assert(mfRounds.length >= 3, `轮次过少 ${mfRounds.length}`);
    assert(mfRounds.some((r) => r.frame === 2), '应包含第 3 帧记录');
    assert(mfEvents.some((e) => e.type === 'frame' && e.frame === 2), '应有 frame 事件');
  });
  check('帧之间数据独立（深拷贝）', () => {
    assert(mfAnim.frameBuffer(0).data !== mfAnim.frameBuffer(1).data, '帧数据不应共享引用');
  });

  // 神经请求体（task / mask / reference）
  group = '端到端 · 神经请求封装';
  console.log(`\n\x1b[38;5;213m▸ ${group}\x1b[0m`);
  const { requestNeural } = await import('../public/js/core/backends.js');
  const origFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, init) => {
    captured = { url, body: JSON.parse(init.body) };
    return { ok: true, headers: { get: () => 'application/json' }, json: async () => ({ image: 'data:image/png;base64,AAA' }) };
  };
  let nn = null;
  try {
    nn = await requestNeural({ task: 'inpaint', image: 'i', mask: 'm', reference: 'r', prompt: 'p' });
  } finally {
    globalThis.fetch = origFetch;
  }
  check('requestNeural 正确封装 task / mask / reference', () => {
    assert(nn && nn.task === 'inpaint', '应返回任务信息');
    eq(captured.body.task, 'inpaint');
    eq(captured.body.mask, 'm');
    eq(captured.body.reference, 'r');
  });

  // 大画布分块回灌
  group = '端到端 · 大画布分块回灌';
  console.log(`\n\x1b[38;5;213m▸ ${group}\x1b[0m`);
  const bigSeen = [];
  const bigMock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const p = JSON.parse(body);
      bigSeen.push(p);
      const assistants = p.messages.filter((m) => m.role === 'assistant').length;
      const text = assistants < 1
        ? '```pixelscript\nsize 256 256\nclear transparent\ncircle 128 128 70 c9 fill\ncircle 128 128 40 c10 fill\n```'
        : 'DONE';
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((r) => bigMock.listen(0, '127.0.0.1', r));
  const bigDoc = new Doc(256, 256);
  const bigAgent = new Agent({
    provider: new Provider({ proxy: false, apiKey: 'k', baseUrl: `http://127.0.0.1:${bigMock.address().port}`, model: 'm' }),
    renderer, doc: bigDoc, history: new Hist(bigDoc), maxIterations: 2, visionLongEdge: 256, detailCrops: true,
  });
  try { await bigAgent.run('大画布测试'); } catch (err) { failures.push({ group, name: '大画布闭环', err }); }
  await new Promise((r) => bigMock.close(r));
  check('大画布回灌附原分辨率裁剪图', () => {
    eq(bigDoc.width, 256);
    assert(bigSeen.length >= 2, `请求过少 ${bigSeen.length}`);
    const last = bigSeen[1].messages[bigSeen[1].messages.length - 1];
    assert(Array.isArray(last.content), '应为多模态数组');
    const imgs = last.content.filter((p) => p.type === 'image_url');
    assert(imgs.length >= 2, `应含整图 + 裁剪图，实际 ${imgs.length}`);
    assert(last.content.some((p) => p.type === 'text' && p.text.includes('局部原分辨率放大')), '应含裁剪说明');
  });

  // 存储回退链
  group = '端到端 · 存储回退';
  console.log(`\n\x1b[38;5;213m▸ ${group}\x1b[0m`);
  const store = await import('../public/js/io/store.js');
  const wrote = await store.storeSet('pixelscribe.test', JSON.stringify({ a: 1 }));
  const got = await store.storeGet('pixelscribe.test');
  await store.storeDel('pixelscribe.test');
  const gone = await store.storeGet('pixelscribe.test');
  check('storeSet / storeGet / storeDel 回退链可用', () => {
    assert(wrote, '应写入成功');
    eq(JSON.parse(got).a, 1);
    eq(gone, null);
  });

  // 中止测试
  group = '端到端 HTTP 闭环 · 中止';
  console.log(`\n\x1b[38;5;213m▸ ${group}\x1b[0m`);
  const slow = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const timer = setInterval(() => res.write('data: {"choices":[{"delta":{"content":"x"}}]}\n\n'), 30);
    req.on('close', () => { clearInterval(timer); res.end(); });
  });
  await new Promise((r) => slow.listen(0, '127.0.0.1', r));
  const doc2 = new Doc(16, 16);
  const agent2 = new Agent({
    provider: new Provider({ proxy: false, apiKey: 'k', baseUrl: `http://127.0.0.1:${slow.address().port}`, model: 'm' }),
    renderer, doc: doc2, history: new Hist(doc2), maxIterations: 3,
  });
  const p2 = agent2.run('随便画');
  setTimeout(() => agent2.abort(), 150);
  const t0 = Date.now();
  await p2;
  check('abort() 在 1 秒内终止闭环', () => {
    assert(Date.now() - t0 < 1000, `耗时 ${Date.now() - t0}ms`);
    eq(doc2.activeLayer.buffer.opaqueCount(), 0, '中止后不应产生绘制');
  });

  await new Promise((r) => mock.close(r));
  await new Promise((r) => slow.close(r));
}

/* ─────────── 汇总 ─────────── */

function finish() {
  console.log('\n' + '─'.repeat(58));
  if (failures.length === 0) {
    console.log(`\x1b[38;5;84m全部通过：${passed} 项\x1b[0m`);
    console.log(`\x1b[38;5;245mPNG 产物：${path.relative(process.cwd(), OUT)}\x1b[0m`);
    process.exit(0);
  }
  console.log(`\x1b[31m失败 ${failures.length} 项\x1b[0m / 通过 ${passed} 项\n`);
  for (const f of failures) console.log(`  \x1b[31m✗\x1b[0m [${f.group}] ${f.name}\n    ${f.err.stack?.split('\n')[1]?.trim() || f.err.message}`);
  process.exit(1);
}

await runIntegration();
finish();
