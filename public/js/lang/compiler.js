/**
 * PixelScript 编译器 / 执行器
 * ---------------------------------------------------------------
 * 设计目标：
 *   1. 单行单指令 —— 错误可精确定位
 *   2. 行级容错   —— 一行失败不终止整段脚本
 *   3. 完全确定性 —— 随机指令必须显式 seed
 *
 * 完整语言参考见 docs/DSL.md
 */

import {
  drawLine, fillEllipse, strokeEllipse, drawRRect, fillPoly, floodFill,
  outline as outlineOp, dither as ditherOp, noise as noiseOp, linearGrad,
  flipBuffer, rotateBuffer, symmetryTransforms, mulberry32,
  drawBezier, arcPoints, ditherGradient,
} from '../core/buffer.js';
import { parseColor, adjust as adjustColor, mix } from '../util/color.js';
import { Palette } from '../core/palette.js';
import { glyph, GLYPH_W, GLYPH_H } from './font5x7.js';
import {
  applyRelief, applySpecular, applyBloom, blur as blurOp, applyTone, applyFbm,
  applyProceduralPipeline, normalizeStyle,
} from '../core/effects.js';

/** @typedef {import('../util/color.js').RGBA} RGBA */
/** @typedef {import('../core/document.js').PixelDocument} PixelDocument */

export class PxError extends Error {}

/* ───────────────────────── 词法分析 ───────────────────────── */

/**
 * 逐行分词。字符串常量保留引号内内容（支持 \\ 转义）。
 * 注释：`//` 任意位置；`#` 仅当其后不是十六进制字符时视为注释。
 * @param {string} text
 * @returns {{value:string, quoted:boolean, col:number}[]}
 */
export function tokenize(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '/') break;
    if (ch === '#' && !/[0-9a-fA-F]/.test(text[i + 1] ?? '')) break;
    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; continue; }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      let s = '';
      while (j < text.length && text[j] !== quote) {
        if (text[j] === '\\' && j + 1 < text.length) { s += text[j + 1]; j += 2; continue; }
        s += text[j];
        j++;
      }
      out.push({ value: s, quoted: true, col: i });
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < text.length && !/[\s]/.test(text[j])) {
      if (text[j] === '/' && text[j + 1] === '/') break;
      j++;
    }
    out.push({ value: text.slice(i, j), quoted: false, col: i });
    i = j;
  }
  return out;
}

/**
 * 语法预检（不做任何绘制），用于编辑器错误标记
 * @param {string} source
 * @returns {{line:number, message:string}[]}
 */
export function checkSyntax(source) {
  const errors = [];
  const lines = String(source).split(/\r?\n/);
  let hasSize = false;
  lines.forEach((text, idx) => {
    const toks = tokenize(text);
    if (!toks.length) return;
    const name = toks[0].value.toLowerCase();
    const cmd = COMMANDS[name];
    if (!cmd) { errors.push({ line: idx + 1, message: `未知指令 '${toks[0].value}'` }); return; }
    const argc = toks.length - 1;
    if (argc < cmd.min) errors.push({ line: idx + 1, message: `'${name}' 至少需要 ${cmd.min} 个参数，实际 ${argc} 个` });
    if (cmd.max !== Infinity && argc > cmd.max) errors.push({ line: idx + 1, message: `'${name}' 最多接受 ${cmd.max} 个参数，实际 ${argc} 个` });
    if (name === 'size') {
      if (hasSize) errors.push({ line: idx + 1, message: "'size' 重复出现，只有第一次生效" });
      hasSize = true;
    }
  });
  return errors;
}

/* ───────────────────────── 参数助手 ───────────────────────── */

function num(tok) {
  if (!tok) throw new PxError('缺少数值参数');
  const v = Number(tok.value);
  if (!Number.isFinite(v)) throw new PxError(`'${tok.value}' 不是合法数值`);
  return v;
}

function numOr(tok, def) { return tok ? num(tok) : def; }

function color(tok, palette) {
  if (!tok) throw new PxError('缺少颜色参数');
  const c = parseColor(tok.value, palette);
  if (!c) throw new PxError(`未知颜色 '${tok.value}'`);
  return c;
}

function mode(token, allowed, def) {
  if (!token) return def;
  const v = String(token.value).toLowerCase();
  if (!allowed.includes(v)) throw new PxError(`'${v}' 不是合法模式，可选：${allowed.join(' / ')}`);
  return v;
}

/** 归一化矩形（宽高转正） */
function normRect(x, y, w, h) {
  if (w < 0) { x += w + 1; w = -w; }
  if (h < 0) { y += h + 1; h = -h; }
  return { x, y, w, h };
}

/* ───────────────────────── 执行上下文 ───────────────────────── */

class Context {
  /** @param {PixelDocument} doc */
  constructor(doc, options) {
    this.doc = doc;
    this.options = options;
    this.palette = doc.palette;
    this.report = { ok: true, ops: 0, changed: 0, errors: [], warnings: [], elapsedMs: 0 };
    this._rngSeed = options.seed ?? doc.seed ?? (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
    this.rng = mulberry32(this._rngSeed);
    this.sawDraw = false;
  }

  get layer() { return this.doc.activeLayer; }
  get buf() { return this.options.buffer || this.doc.activeLayer.buffer; }
  get W() { return this.doc.width; }
  get H() { return this.doc.height; }

  transforms() { return symmetryTransforms(this.W, this.H, this.doc.symmetry); }

  reseed(seed) {
    this._rngSeed = seed >>> 0;
    this.rng = mulberry32(this._rngSeed);
  }
}

/** 对每个对称变换执行回调，回调收到 (tx, ty) 两个函数 */
function eachMirror(ctx, cb) {
  for (const t of ctx.transforms()) cb(t);
}

/** 把一个矩形经变换后归一化 */
function xformRect(t, x, y, w, h) {
  const [ax, ay] = t(x, y);
  const [bx, by] = t(x + w - 1, y + h - 1);
  return {
    x: Math.min(ax, bx), y: Math.min(ay, by),
    w: Math.abs(bx - ax) + 1, h: Math.abs(by - ay) + 1,
  };
}

/* ───────────────────────── 指令表 ───────────────────────── */

export const COMMANDS = {
  /* ── 指令型 ── */
  size: {
    min: 2, max: 2,
    doc: 'size W H —— 设定画布尺寸（1–512）',
    run(ctx, a) {
      const w = Math.round(num(a[0])), h = Math.round(num(a[1]));
      if (w < 1 || h < 1 || w > 512 || h > 512) throw new PxError(`尺寸超出范围 1–512：${w}×${h}`);
      if (ctx.sawDraw) throw new PxError("'size' 必须位于所有绘制指令之前");
      ctx.doc.resize(w, h);
      ctx.doc.invalidate();
      ctx.report.warnings.push(`size 已设为 ${w}×${h}，图元坐标请据此调整`);
      return { structural: true };
    },
  },

  palette: {
    min: 1, max: Infinity,
    doc: 'palette NAME | palette #h [#h ...] —— 切换或自定义调色板',
    run(ctx, a) {
      let p;
      if (a.length === 1 && !a[0].value.startsWith('#')) {
        p = Palette.from(a[0].value);
      } else {
        const hexes = a.map((t) => {
          const c = parseColor(t.value, null);
          if (!c) throw new PxError(`未知颜色 '${t.value}'`);
          return c;
        });
        p = Palette.from(hexes.map((c) => `#${[c.r, c.g, c.b, c.a].map((v) => v.toString(16).padStart(2, '0')).join('')}`));
      }
      ctx.doc.palette = p;
      ctx.palette = p;
      return { structural: true };
    },
  },

  bg: {
    min: 1, max: 1,
    doc: 'bg COLOR —— 用 COLOR 填满当前图层',
    run(ctx, a) {
      ctx.buf.clear(color(a[0], ctx.palette));
      ctx.sawDraw = true;
    },
  },

  clear: {
    min: 0, max: 1,
    doc: 'clear [COLOR] —— 清空为透明或指定色',
    run(ctx, a) {
      ctx.buf.clear(a.length ? color(a[0], ctx.palette) : { r: 0, g: 0, b: 0, a: 0 });
      ctx.sawDraw = true;
    },
  },

  sym: {
    min: 1, max: 1,
    doc: 'sym off|x|y|xy —— 开启镜像对称',
    run(ctx, a) {
      const v = String(a[0].value).toLowerCase();
      const map = { off: 'off', none: 'off', '0': 'off', false: 'off', x: 'x', y: 'y', xy: 'xy', both: 'xy' };
      if (!(v in map)) throw new PxError(`'${v}' 不是合法对称模式，可选：off / x / y / xy`);
      ctx.doc.symmetry = map[v];
      return { structural: true };
    },
  },

  seed: {
    min: 1, max: 1,
    doc: 'seed N —— 设定随机种子',
    run(ctx, a) {
      const s = Math.round(num(a[0]));
      ctx.reseed(s);
      ctx.doc.seed = s;
      return { structural: true };
    },
  },

  name: {
    min: 1, max: 1,
    doc: 'name "TITLE" —— 设置文档标题',
    run(ctx, a) {
      ctx.doc.title = a[0].value;
      return { structural: true };
    },
  },

  style: {
    min: 1, max: 1,
    doc: 'style pixel|painting|ink|anime|3d|photo —— 设定作品风格（决定渲染后端）',
    run(ctx, a) {
      const s = normalizeStyle(a[0].value);
      ctx.doc.style = s;
      return { structural: true };
    },
  },

  light: {
    min: 2, max: 5,
    doc: 'light DX DY [Z] [STRENGTH] [COLOR] —— 声明方向光（DX DY 指向光源，如 -1 -1 表示左上）',
    run(ctx, a) {
      const dx = num(a[0]), dy = num(a[1]);
      let z = 1, strength = 1, color = { r: 255, g: 255, b: 255 };
      const nums = [];
      for (let i = 2; i < a.length; i++) {
        const tok = a[i];
        if (!tok.quoted && Number.isFinite(Number(tok.value))) { nums.push(Number(tok.value)); continue; }
        const c = parseColor(tok.value, ctx.palette);
        if (c) color = c;
      }
      if (nums.length >= 1) z = nums[0];
      if (nums.length >= 2) strength = nums[1];
      if (!Array.isArray(ctx.doc.lights)) ctx.doc.lights = [];
      ctx.doc.lights.push({ dx, dy, z, strength, color });
      return { structural: true };
    },
  },

  /* ── 绘制型 ── */
  px: {
    min: 3, max: 3,
    doc: 'px X Y COLOR —— 单像素',
    run(ctx, a) {
      const x = num(a[0]), y = num(a[1]);
      const c = color(a[2], ctx.palette);
      eachMirror(ctx, (t) => { const [nx, ny] = t(x, y); ctx.buf.plot(nx, ny, c); });
    },
  },

  hline: {
    min: 4, max: 4,
    doc: 'hline X Y LEN COLOR —— 水平线',
    run(ctx, a) {
      const x = num(a[0]), y = num(a[1]), len = Math.round(num(a[2]));
      const c = color(a[3], ctx.palette);
      if (len <= 0) throw new PxError('LEN 必须为正数');
      eachMirror(ctx, (t) => {
        const [ax, ay] = t(x, y);
        const [bx, by] = t(x + len - 1, y);
        drawLine(ctx.buf, ax, ay, bx, by, c, 1);
      });
    },
  },

  vline: {
    min: 4, max: 4,
    doc: 'vline X Y LEN COLOR —— 垂直线',
    run(ctx, a) {
      const x = num(a[0]), y = num(a[1]), len = Math.round(num(a[2]));
      const c = color(a[3], ctx.palette);
      if (len <= 0) throw new PxError('LEN 必须为正数');
      eachMirror(ctx, (t) => {
        const [ax, ay] = t(x, y);
        const [bx, by] = t(x, y + len - 1);
        drawLine(ctx.buf, ax, ay, bx, by, c, 1);
      });
    },
  },

  line: {
    min: 5, max: 6,
    doc: 'line X1 Y1 X2 Y2 COLOR [W] —— 直线',
    run(ctx, a) {
      const x1 = num(a[0]), y1 = num(a[1]), x2 = num(a[2]), y2 = num(a[3]);
      const c = color(a[4], ctx.palette);
      const w = Math.max(1, Math.round(numOr(a[5], 1)));
      eachMirror(ctx, (t) => {
        const [ax, ay] = t(x1, y1);
        const [bx, by] = t(x2, y2);
        drawLine(ctx.buf, ax, ay, bx, by, c, w);
      });
    },
  },

  rect: {
    min: 5, max: 7,
    doc: 'rect X Y W H COLOR [stroke|fill] [W] —— 矩形',
    run(ctx, a) {
      const r = normRect(Math.round(num(a[0])), Math.round(num(a[1])), Math.round(num(a[2])), Math.round(num(a[3])));
      const c = color(a[4], ctx.palette);
      const m = mode(a[5], ['stroke', 'outline', 'fill', 'solid'], 'fill');
      const w = Math.max(1, Math.round(numOr(a[6], 1)));
      eachMirror(ctx, (t) => {
        const q = xformRect(t, r.x, r.y, r.w, r.h);
        if (m === 'fill') { ctx.buf.fillRect(q.x, q.y, q.w, q.h, c, false); return; }
        const bw = Math.min(w, Math.ceil(Math.min(q.w, q.h) / 2));
        ctx.buf.fillRect(q.x, q.y, q.w, bw, c, false);
        ctx.buf.fillRect(q.x, q.y + q.h - bw, q.w, bw, c, false);
        ctx.buf.fillRect(q.x, q.y, bw, q.h, c, false);
        ctx.buf.fillRect(q.x + q.w - bw, q.y, bw, q.h, c, false);
      });
    },
  },

  rrect: {
    min: 6, max: 7,
    doc: 'rrect X Y W H R COLOR [stroke|fill] —— 圆角矩形',
    run(ctx, a) {
      const r = normRect(Math.round(num(a[0])), Math.round(num(a[1])), Math.round(num(a[2])), Math.round(num(a[3])));
      const rad = Math.max(0, num(a[4]));
      const c = color(a[5], ctx.palette);
      const m = mode(a[6], ['stroke', 'outline', 'fill', 'solid'], 'fill');
      eachMirror(ctx, (t) => {
        const q = xformRect(t, r.x, r.y, r.w, r.h);
        drawRRect(ctx.buf, q.x, q.y, q.w, q.h, rad, c, m === 'fill' ? 'fill' : 'stroke', 1);
      });
    },
  },

  circle: {
    min: 4, max: 5,
    doc: 'circle CX CY R COLOR [stroke|fill] —— 圆',
    run(ctx, a) {
      const cx = num(a[0]), cy = num(a[1]), rr = Math.abs(num(a[2]));
      const c = color(a[3], ctx.palette);
      const m = mode(a[4], ['stroke', 'outline', 'fill', 'solid'], 'fill');
      eachMirror(ctx, (t) => {
        const [nx, ny] = t(cx, cy);
        if (m === 'fill') fillEllipse(ctx.buf, nx, ny, rr, rr, c);
        else strokeEllipse(ctx.buf, nx, ny, rr, rr, c, 1);
      });
    },
  },

  ellipse: {
    min: 5, max: 6,
    doc: 'ellipse CX CY RX RY COLOR [stroke|fill] —— 椭圆',
    run(ctx, a) {
      const cx = num(a[0]), cy = num(a[1]);
      const rx = Math.abs(num(a[2])), ry = Math.abs(num(a[3]));
      const c = color(a[4], ctx.palette);
      const m = mode(a[5], ['stroke', 'outline', 'fill', 'solid'], 'fill');
      eachMirror(ctx, (t) => {
        const [nx, ny] = t(cx, cy);
        if (m === 'fill') fillEllipse(ctx.buf, nx, ny, rx, ry, c);
        else strokeEllipse(ctx.buf, nx, ny, rx, ry, c, 1);
      });
    },
  },

  poly: {
    min: 7, max: Infinity,
    doc: 'poly COLOR [stroke|fill] X1 Y1 X2 Y2 ... —— 多边形',
    run(ctx, a) {
      const c = color(a[0], ctx.palette);
      let idx = 1;
      let m = 'fill';
      const maybe = String(a[1]?.value ?? '').toLowerCase();
      if (['stroke', 'outline', 'fill', 'solid'].includes(maybe)) { m = maybe; idx = 2; }
      const rest = a.slice(idx);
      if (rest.length % 2 !== 0) throw new PxError('顶点坐标必须成对出现（X Y）');
      if (rest.length < 6) throw new PxError('多边形至少需要 3 个顶点');
      const verts = [];
      for (let i = 0; i < rest.length; i += 2) verts.push([num(rest[i]), num(rest[i + 1])]);
      const doStroke = m !== 'fill';
      eachMirror(ctx, (t) => {
        const pts = [];
        for (const [vx, vy] of verts) {
          const [nx, ny] = t(vx, vy);
          pts.push(nx, ny);
        }
        if (!doStroke) fillPoly(ctx.buf, pts, c);
        else {
          for (let i = 0; i < pts.length / 2; i++) {
            const j = (i + 1) % (pts.length / 2);
            drawLine(ctx.buf, pts[i * 2], pts[i * 2 + 1], pts[j * 2], pts[j * 2 + 1], c, 1);
          }
        }
      });
    },
  },

  fill: {
    min: 3, max: 3,
    doc: 'fill X Y COLOR —— 洪水填充',
    run(ctx, a) {
      const x = Math.round(num(a[0])), y = Math.round(num(a[1]));
      const c = color(a[2], ctx.palette);
      eachMirror(ctx, (t) => { const [nx, ny] = t(x, y); floodFill(ctx.buf, nx, ny, c); });
    },
  },

  replace: {
    min: 2, max: 2,
    doc: 'replace OLD NEW —— 全图换色',
    run(ctx, a) {
      const from = color(a[0], ctx.palette), to = color(a[1], ctx.palette);
      const u32 = ctx.buf.u32;
      const fu = (from.a << 24 | from.b << 16 | from.g << 8 | from.r) >>> 0;
      const tu = (to.a << 24 | to.b << 16 | to.g << 8 | to.r) >>> 0;
      for (let i = 0; i < u32.length; i++) if (u32[i] === fu) u32[i] = tu;
    },
  },

  outline: {
    min: 1, max: 2,
    doc: 'outline COLOR [inside|outside] —— 为不透明区域描边',
    run(ctx, a) {
      const c = color(a[0], ctx.palette);
      const where = mode(a[1], ['inside', 'outside', 'in', 'out'], 'outside');
      outlineOp(ctx.buf, c, where.startsWith('in'));
    },
  },

  grad: {
    min: 6, max: 7,
    doc: 'grad X Y W H C1 C2 [v|h] —— 线性渐变',
    run(ctx, a) {
      const r = normRect(Math.round(num(a[0])), Math.round(num(a[1])), Math.round(num(a[2])), Math.round(num(a[3])));
      const c1 = color(a[4], ctx.palette), c2 = color(a[5], ctx.palette);
      const dir = mode(a[6], ['v', 'vertical', 'h', 'horizontal'], 'v');
      eachMirror(ctx, (t) => {
        const q = xformRect(t, r.x, r.y, r.w, r.h);
        linearGrad(ctx.buf, q.x, q.y, q.w, q.h, c1, c2, dir.startsWith('h') ? 'h' : 'v');
      });
    },
  },

  dither: {
    min: 6, max: 9,
    doc: 'dither X Y W H C1 C2 [checker|bayer|h|v] [SCALE] [RATIO] —— 有序抖动，RATIO 为 C2 占比',
    run(ctx, a) {
      const r = normRect(Math.round(num(a[0])), Math.round(num(a[1])), Math.round(num(a[2])), Math.round(num(a[3])));
      const c1 = color(a[4], ctx.palette), c2 = color(a[5], ctx.palette);
      const pat = mode(a[6], ['checker', 'bayer', 'h', 'v'], 'checker');
      const sc = Math.max(1, Math.round(numOr(a[7], 1)));
      const ratio = Math.max(0, Math.min(1, numOr(a[8], 0.5)));
      eachMirror(ctx, (t) => {
        const q = xformRect(t, r.x, r.y, r.w, r.h);
        ditherOp(ctx.buf, q.x, q.y, q.w, q.h, c1, c2, pat, sc, ratio);
      });
    },
  },

  noise: {
    min: 5, max: 7,
    doc: 'noise X Y W H COLOR [DENSITY] [SEED] —— 随机噪点',
    run(ctx, a) {
      const r = normRect(Math.round(num(a[0])), Math.round(num(a[1])), Math.round(num(a[2])), Math.round(num(a[3])));
      const c = color(a[4], ctx.palette);
      const density = Math.max(0, Math.min(1, numOr(a[5], 0.1)));
      const localSeed = a[6] !== undefined ? mulberry32(Math.round(num(a[6]))) : ctx.rng;
      eachMirror(ctx, (t) => {
        const q = xformRect(t, r.x, r.y, r.w, r.h);
        noiseOp(ctx.buf, q.x, q.y, q.w, q.h, c, density, localSeed);
      });
    },
  },

  copy: {
    min: 6, max: 6,
    doc: 'copy SX SY W H DX DY —— 区域拷贝',
    run(ctx, a) {
      const r = normRect(Math.round(num(a[0])), Math.round(num(a[1])), Math.round(num(a[2])), Math.round(num(a[3])));
      const dx = Math.round(num(a[4])), dy = Math.round(num(a[5]));
      eachMirror(ctx, (t) => {
        const s = xformRect(t, r.x, r.y, r.w, r.h);
        const [ndx, ndy] = t(dx, dy);
        ctx.buf.blit(s.x, s.y, r.w, r.h, ndx, ndy);
      });
    },
  },

  flip: {
    min: 1, max: 1,
    doc: 'flip x|y —— 整层翻转',
    run(ctx, a) {
      const raw = mode(a[0], ['x', 'y', 'h', 'v', 'horizontal', 'vertical'], 'x');
      const axis = raw.startsWith('h') ? 'x' : raw.startsWith('v') ? 'y' : raw;
      const nb = flipBuffer(ctx.buf, axis);
      ctx.buf.data.set(nb.data);
      ctx.doc.invalidate();
    },
  },

  rot: {
    min: 1, max: 1,
    doc: 'rot 90|180|270 —— 整层顺时针旋转',
    run(ctx, a) {
      const raw = num(a[0]);
      const deg = ((Math.round(raw) % 360) + 360) % 360;
      if (![0, 90, 180, 270].includes(deg)) throw new PxError(`旋转角度必须是 90 / 180 / 270（收到 ${raw}）`);
      if (deg === 0) return;
      if (ctx.W !== ctx.H) ctx.report.warnings.push('rot on non-square canvas will crop');
      const nb = rotateBuffer(ctx.buf, deg);
      ctx.buf.data.set(nb.data);
      ctx.doc.invalidate();
    },
  },

  erase: {
    min: 4, max: 4,
    doc: 'erase X Y W H —— 擦除为透明',
    run(ctx, a) {
      const r = normRect(Math.round(num(a[0])), Math.round(num(a[1])), Math.round(num(a[2])), Math.round(num(a[3])));
      eachMirror(ctx, (t) => {
        const q = xformRect(t, r.x, r.y, r.w, r.h);
        ctx.buf.fillRect(q.x, q.y, q.w, q.h, { r: 0, g: 0, b: 0, a: 0 }, false);
      });
    },
  },

  adjust: {
    min: 5, max: 6,
    doc: 'adjust X Y W H light|dark [AMOUNT] —— 区域明暗调整',
    run(ctx, a) {
      const r = normRect(Math.round(num(a[0])), Math.round(num(a[1])), Math.round(num(a[2])), Math.round(num(a[3])));
      const m = mode(a[4], ['light', 'dark', 'lighter', 'darker'], 'light');
      const amount = Math.max(0, Math.min(1, numOr(a[5], 0.2)));
      const light = m.startsWith('light');
      eachMirror(ctx, (t) => {
        const q = xformRect(t, r.x, r.y, r.w, r.h);
        for (let y = q.y; y < q.y + q.h; y++) {
          for (let x = q.x; x < q.x + q.w; x++) {
            if (!ctx.buf.inBounds(x, y)) continue;
            const cur = ctx.buf.get(x, y);
            if (cur.a === 0) continue;
            ctx.buf.set(x, y, adjustColor(cur, light ? 'light' : 'dark', amount));
          }
        }
      });
    },
  },

  text: {
    min: 4, max: 5,
    doc: 'text X Y COLOR "STRING" [SCALE] —— 5×7 位图文字',
    run(ctx, a) {
      const x0 = Math.round(num(a[0])), y0 = Math.round(num(a[1]));
      const c = color(a[2], ctx.palette);
      const s = String(a[3].value);
      const sc = Math.max(1, Math.round(numOr(a[4], 1)));
      let cx = x0;
      for (const ch of s) {
        const g = glyph(ch);
        for (let gy = 0; gy < GLYPH_H; gy++) {
          for (let gx = 0; gx < GLYPH_W; gx++) {
            if (g[gy][gx] !== '1') continue;
            for (let sy = 0; sy < sc; sy++) {
              for (let sx = 0; sx < sc; sx++) {
                ctx.buf.plot(cx + gx * sc + sx, y0 + gy * sc + sy, c);
              }
            }
          }
        }
        cx += (GLYPH_W + 1) * sc;
      }
    },
  },

  /* ── 精细化/可控扩展（v1.2）── */
  curve: {
    min: 7, max: 8,
    doc: 'curve X1 Y1 CX CY X2 Y2 COLOR [W] —— 二次贝塞尔曲线（有机轮廓/叶形/飘带）',
    run(ctx, a) {
      const x1 = num(a[0]), y1 = num(a[1]), cx = num(a[2]), cy = num(a[3]);
      const x2 = num(a[4]), y2 = num(a[5]);
      const c = color(a[6], ctx.palette);
      const w = Math.max(1, Math.round(numOr(a[7], 1)));
      eachMirror(ctx, (t) => {
        const [ax, ay] = t(x1, y1);
        const [bx, by] = t(cx, cy);
        const [dx, dy] = t(x2, y2);
        drawBezier(ctx.buf, ax, ay, bx, by, dx, dy, c, w);
      });
    },
  },

  arc: {
    min: 6, max: 7,
    doc: 'arc CX CY R A0 A1 COLOR [W] —— 圆弧（角度制：0=右 90=下）',
    run(ctx, a) {
      const cx = num(a[0]), cy = num(a[1]), r = Math.abs(num(a[2]));
      const a0 = num(a[3]), a1 = num(a[4]);
      const c = color(a[5], ctx.palette);
      const w = Math.max(1, Math.round(numOr(a[6], 1)));
      const pts = arcPoints(cx, cy, r, a0, a1);
      eachMirror(ctx, (t) => {
        for (let i = 0; i + 3 < pts.length; i += 2) {
          const [ax, ay] = t(pts[i], pts[i + 1]);
          const [bx, by] = t(pts[i + 2], pts[i + 3]);
          drawLine(ctx.buf, ax, ay, bx, by, c, w);
        }
      });
    },
  },

  shade: {
    min: 5, max: 6,
    doc: 'shade X Y W H COLOR [AMOUNT] —— 区域整体向 COLOR 靠拢（同色系受光/阴影，比 adjust 更可控）',
    run(ctx, a) {
      const r = normRect(Math.round(num(a[0])), Math.round(num(a[1])), Math.round(num(a[2])), Math.round(num(a[3])));
      const target = color(a[4], ctx.palette);
      const amount = Math.max(0, Math.min(1, numOr(a[5], 0.25)));
      eachMirror(ctx, (t) => {
        const q = xformRect(t, r.x, r.y, r.w, r.h);
        for (let y = q.y; y < q.y + q.h; y++) {
          for (let x = q.x; x < q.x + q.w; x++) {
            if (!ctx.buf.inBounds(x, y)) continue;
            const cur = ctx.buf.get(x, y);
            if (cur.a === 0) continue;
            ctx.buf.set(x, y, mix(cur, target, amount));
          }
        }
      });
    },
  },

  bevel: {
    min: 4, max: 6,
    doc: 'bevel X Y W H [SIZE] [STRENGTH] —— 立体浮雕（左上受光、右下阴影，给道具/按钮加体积）',
    run(ctx, a) {
      const r = normRect(Math.round(num(a[0])), Math.round(num(a[1])), Math.round(num(a[2])), Math.round(num(a[3])));
      const size = Math.max(1, Math.round(numOr(a[4], 2)));
      const strength = Math.max(0, Math.min(1, numOr(a[5], 0.3)));
      eachMirror(ctx, (t) => {
        const q = xformRect(t, r.x, r.y, r.w, r.h);
        for (let y = q.y; y < q.y + q.h; y++) {
          for (let x = q.x; x < q.x + q.w; x++) {
            if (!ctx.buf.inBounds(x, y)) continue;
            const cur = ctx.buf.get(x, y);
            if (cur.a === 0) continue;
            const lightAmt = Math.max(0, 1 - Math.min(x - q.x, y - q.y) / size);
            const darkAmt = Math.max(0, 1 - Math.min(q.x + q.w - 1 - x, q.y + q.h - 1 - y) / size);
            if (lightAmt <= 0 && darkAmt <= 0) continue;
            ctx.buf.set(x, y, lightAmt >= darkAmt
              ? adjustColor(cur, 'light', strength * lightAmt)
              : adjustColor(cur, 'dark', strength * darkAmt));
          }
        }
      });
    },
  },

  graddither: {
    min: 6, max: 8,
    doc: 'graddither X Y W H C1 C2 [checker|bayer|h|v] [v|h] —— 抖动渐变（比 grad 更像素、更有质感）',
    run(ctx, a) {
      const r = normRect(Math.round(num(a[0])), Math.round(num(a[1])), Math.round(num(a[2])), Math.round(num(a[3])));
      const c1 = color(a[4], ctx.palette), c2 = color(a[5], ctx.palette);
      const pat = mode(a[6], ['checker', 'bayer', 'h', 'v'], 'bayer');
      const dir = mode(a[7], ['v', 'h', 'vertical', 'horizontal'], 'v');
      eachMirror(ctx, (t) => {
        const q = xformRect(t, r.x, r.y, r.w, r.h);
        ditherGradient(ctx.buf, q.x, q.y, q.w, q.h, c1, c2, pat, dir.startsWith('h') ? 'h' : 'v');
      });
    },
  },

  /* ── 程序化渲染（S1：写实质感） ── */
  relief: {
    min: 0, max: 3,
    doc: 'relief [STRENGTH] [AMBIENT] [NORMAL_STRENGTH] —— 方向光浮雕（用已声明的 light 给画面加体积）',
    run(ctx, a) {
      applyRelief(ctx.buf, {
        strength: numOr(a[0], 0.85),
        ambient: numOr(a[1], 0.35),
        normalStrength: numOr(a[2], 2),
        lights: ctx.doc.lights,
      });
    },
  },

  specular: {
    min: 0, max: 3,
    doc: 'specular [STRENGTH] [POWER] [NORMAL_STRENGTH] —— 镜面高光（给材质加湿润/金属光泽）',
    run(ctx, a) {
      applySpecular(ctx.buf, {
        strength: numOr(a[0], 0.6),
        power: numOr(a[1], 16),
        normalStrength: numOr(a[2], 2),
        lights: ctx.doc.lights,
      });
    },
  },

  bloom: {
    min: 0, max: 3,
    doc: 'bloom [THRESHOLD] [STRENGTH] [RADIUS] —— 高光溢出/辉光（光源、金属、魔法效果）',
    run(ctx, a) {
      applyBloom(ctx.buf, { threshold: numOr(a[0], 0.7), strength: numOr(a[1], 0.6), radius: numOr(a[2], 2) });
    },
  },

  blur: {
    min: 0, max: 1,
    doc: 'blur [RADIUS] —— 高斯近似模糊（软化、景深感）',
    run(ctx, a) {
      blurOp(ctx.buf, numOr(a[0], 1));
    },
  },

  tone: {
    min: 0, max: 5,
    doc: 'tone [GAMMA] [CONTRAST] [SATURATION] [BRIGHTNESS] [VIGNETTE] —— 相机色调映射（写实的关键一步）',
    run(ctx, a) {
      applyTone(ctx.buf, {
        gamma: numOr(a[0], 1.08),
        contrast: numOr(a[1], 1.12),
        saturation: numOr(a[2], 1.05),
        brightness: numOr(a[3], 0),
        vignette: numOr(a[4], 0.15),
      });
    },
  },

  fbm: {
    min: 6, max: 9,
    doc: 'fbm X Y W H C1 C2 [OCTAVES] [SCALE] [fill|over|mod] —— 分形噪声材质（石头/木纹/云/皮革）',
    run(ctx, a) {
      const r = normRect(Math.round(num(a[0])), Math.round(num(a[1])), Math.round(num(a[2])), Math.round(num(a[3])));
      const c1 = color(a[4], ctx.palette), c2 = color(a[5], ctx.palette);
      const octaves = Math.max(1, Math.min(8, Math.round(numOr(a[6], 4))));
      const scale = Math.max(0.5, numOr(a[7], 4));
      const m = mode(a[8], ['fill', 'over', 'mod', 'add', 'multiply', 'mult'], 'fill');
      const md = m.startsWith('mult') ? 'mod' : m === 'add' ? 'over' : m;
      eachMirror(ctx, (t) => {
        const q = xformRect(t, r.x, r.y, r.w, r.h);
        applyFbm(ctx.buf, { x: q.x, y: q.y, w: q.w, h: q.h, c1, c2, octaves, scale, mode: md, seed: ctx._rngSeed ^ (q.x * 73856093) ^ (q.y * 19349663) });
      });
    },
  },

  render: {
    min: 0, max: 1,
    doc: 'render [STYLE] —— 按风格执行渲染管线（程序化先验；在线时可由视觉闭环升级为神经渲染）',
    run(ctx, a) {
      const style = a.length ? normalizeStyle(a[0].value) : (ctx.doc.style || 'pixel');
      ctx.doc.style = style;
      ctx.doc.renderRequested = style;
      // 闭环中由 Agent 以非破坏方式统一渲染到神经残差层，
      // 避免多轮迭代把 tone/relief 重复叠加到程序层（deferRender）。
      if (!ctx.options.deferRender) {
        applyProceduralPipeline(ctx.buf, style, { lights: ctx.doc.lights, seed: ctx._rngSeed });
      }
    },
  },

  inpaint: {
    min: 5, max: 6,
    doc: 'inpaint X Y W H "PROMPT" [STRENGTH] —— 局部重绘（只细化该区域，其余保持不变）',
    run(ctx, a) {
      const r = normRect(Math.round(num(a[0])), Math.round(num(a[1])), Math.round(num(a[2])), Math.round(num(a[3])));
      const prompt = String(a[4].value);
      const strength = Math.max(0, Math.min(1, numOr(a[5], 0.6)));
      if (!Array.isArray(ctx.doc.inpaintRequests)) ctx.doc.inpaintRequests = [];
      ctx.doc.inpaintRequests.push({ ...r, prompt, strength });
      return { structural: true };
    },
  },
};

/* ───────────────────────── 主入口 ───────────────────────── */

function countDiff(after, before) {
  const A = new Uint32Array(after.buffer, after.byteOffset, after.length / 4);
  const B = new Uint32Array(before.buffer, before.byteOffset, before.length / 4);
  const n = Math.min(A.length, B.length);
  let c = 0;
  for (let i = 0; i < n; i++) if (A[i] !== B[i]) c++;
  return c;
}

/**
 * 执行一段 PixelScript
 * @param {string} source
 * @param {PixelDocument} doc
 * @param {{mode?:'replace'|'append', seed?:number, maxOps?:number, silent?:boolean}} [options]
 */
export function runScript(source, doc, options = {}) {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const mode = options.mode ?? 'replace';
  const ctx = new Context(doc, options);

  if (doc.activeLayer.locked && !options.buffer) {
    ctx.report.ok = false;
    ctx.report.errors.push('当前图层已锁定，无法绘制');
    return ctx.report;
  }

  if (mode === 'replace') ctx.buf.clear({ r: 0, g: 0, b: 0, a: 0 });

  const before = ctx.buf.snapshot();
  const srcLines = String(source ?? '').split(/\r?\n/);
  const maxOps = options.maxOps ?? 20000;
  const NON_DRAW = new Set(['size', 'palette', 'sym', 'seed', 'name', 'style', 'light', 'inpaint']);

  srcLines.forEach((text, i) => {
    const toks = tokenize(text);
    if (!toks.length) return;
    const lineNo = i + 1;
    const name = toks[0].value.toLowerCase();
    const cmd = COMMANDS[name];
    if (!cmd) {
      ctx.report.errors.push(`line ${lineNo}: 未知指令 '${toks[0].value}'`);
      return;
    }
    const args = toks.slice(1);
    if (args.length < cmd.min || (cmd.max !== Infinity && args.length > cmd.max)) {
      const range = cmd.max === Infinity ? `至少 ${cmd.min}` : `${cmd.min}–${cmd.max}`;
      ctx.report.errors.push(`line ${lineNo}: '${name}' 需要 ${range} 个参数，实际 ${args.length} 个`);
      return;
    }
    if (ctx.report.ops >= maxOps) return;
    try {
      cmd.run(ctx, args);
      if (!NON_DRAW.has(name)) ctx.sawDraw = true;
      ctx.report.ops++;
    } catch (err) {
      ctx.report.errors.push(`line ${lineNo}: ${err instanceof PxError ? err.message : String((err && err.message) || err)}`);
    }
  });

  ctx.report.changed = countDiff(ctx.buf.data, before);
  ctx.report.ok = ctx.report.errors.length === 0;
  ctx.report.elapsedMs = Math.round(((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0) * 100) / 100;
  doc.invalidate();
  return ctx.report;
}

const FENCE_LANGS = new Set(['', 'pixelscript', 'px', 'pxs', 'pix', 'text']);

function _firstToken(line) {
  return String(line || '').trim().split(/\s+/)[0].toLowerCase();
}

/** 至少两条「首 token 是已知指令」的有效行，才认为像脚本（防把散文当脚本）。 */
function _looksLikeScript(src) {
  let n = 0;
  for (const l of String(src).split(/\r?\n/)) {
    const t = l.trim();
    if (!t || t.startsWith('#') || t.startsWith('//')) continue;
    if (Object.prototype.hasOwnProperty.call(COMMANDS, _firstToken(t))) n++;
  }
  return n >= 2;
}

/**
 * 从模型回复中抽取 PixelScript 代码块
 *
 * 兼容三类输出：标准围栏（闭合围栏可缺失，适配流式截断）、语言标签与首行同行、
 * 以及无围栏时的「纯指令行」兜底（仅接受首 token 是已知指令的行，绝不执行散文）。
 * @param {string} text
 * @returns {string|null}
 */
export function extractScript(text) {
  if (!text) return null;
  const s = String(text);

  // 1) 标准围栏
  const re = /```[ \t]*([A-Za-z0-9_-]*)[ \t]*\r?\n([\s\S]*?)(?:```|$)/g;
  const candidates = [];
  let m;
  while ((m = re.exec(s)) !== null) {
    if (FENCE_LANGS.has(m[1].toLowerCase())) candidates.push(m[2]);
  }
  if (candidates.length) {
    const best = candidates.find((c) => _looksLikeScript(c)) || candidates[0];
    const t = String(best).trim();
    if (t) return t;
  }

  // 2) 语言标签与首行同行：```pixelscript size 32 32
  const inline = /```[ \t]*(?:pixelscript|px|pxs|pix)[ \t]+([^\n]*)(?:\r?\n([\s\S]*?))?(?:```|$)/i.exec(s);
  if (inline) {
    const t = `${inline[1] || ''}\n${inline[2] || ''}`.trim();
    if (t) return t;
  }

  // 3) 兜底：仅取已知指令行，且必须含 size
  const lines = s.split(/\r?\n/).filter((l) => {
    const t = l.trim();
    if (!t || t.startsWith('#') || t.startsWith('//')) return false;
    return Object.prototype.hasOwnProperty.call(COMMANDS, _firstToken(t));
  });
  if (lines.length >= 2 && lines.some((l) => _firstToken(l) === 'size')) {
    return lines.join('\n').trim();
  }
  return null;
}

/**
 * 回复是否表示完成。
 * 只要回复里还有可执行脚本，就不算完成（防止「脚本 + DONE」被误判为收工）；
 * 否则容忍结尾多一句说明，任意一行是单独的 done/完成 即判定完成。
 */
export function isDone(text) {
  const s = String(text ?? '').trim();
  if (!s) return false;
  if (extractScript(s)) return false;
  return s.split(/\r?\n/).some((l) => {
    const t = l.trim().replace(/[.!。！:：\s]+$/, '');
    return /^(done|finished|完成|已完成)$/i.test(t);
  });
}

/** 生成给模型的紧凑语言手册（用于系统提示） */
export function dslReference() {
  return Object.entries(COMMANDS).map(([name, c]) => `- ${c.doc}`).join('\n');
}
