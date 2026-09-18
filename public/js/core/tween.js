/**
 * 帧间补间（tween / in-between）v1.8
 * ---------------------------------------------------------------
 * 在两张关键帧之间按缓动曲线生成中间帧。
 *
 *  - 程序化补间：逐像素按缓动进度做 Alpha 加权交叉溶解（cross-fade），
 *    确定性、可复现，Node 可直接测试。
 *  - AI 补间：由 Agent.tween 调用模型为每个中间时刻补出更合理的运动姿态，
 *    失败时回退到这里的程序化结果。
 */

import { PixelBuffer } from './buffer.js';
import { ease, easingFn } from './easing.js';

const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, v | 0));

/**
 * 两张同尺寸帧的逐像素交叉溶解。
 * @param {{width:number,height:number,layers:any[]}} a
 * @param {{width:number,height:number,layers:any[]}} b
 * @param {number} t 0=A，1=B
 */
export function blendFrames(a, b, t) {
  const width = a.width, height = b.height;
  const layers = [];
  const n = Math.max(a.layers.length, b.layers.length);
  for (let i = 0; i < n; i++) {
    const la = a.layers[i];
    const lb = b.layers[i];
    const base = la || lb;
    const da = la ? la.data : new Uint8ClampedArray(width * height * 4);
    const db = lb ? lb.data : new Uint8ClampedArray(width * height * 4);
    const out = new Uint8ClampedArray(width * height * 4);
    const pa = da, pb = db;
    for (let k = 0; k < out.length; k += 4) {
      const aa = pa[k + 3] / 255;
      const ab = pb[k + 3] / 255;
      const oa = aa * (1 - t) + ab * t;
      if (oa <= 0) continue;
      out[k + 3] = Math.round(oa * 255);
      out[k] = Math.round((pa[k] * aa * (1 - t) + pb[k] * ab * t) / oa);
      out[k + 1] = Math.round((pa[k + 1] * aa * (1 - t) + pb[k + 1] * ab * t) / oa);
      out[k + 2] = Math.round((pa[k + 2] * aa * (1 - t) + pb[k + 2] * ab * t) / oa);
    }
    layers.push({
      id: base.id,
      name: base.name,
      kind: base.kind || 'raster',
      meta: base.meta ? { ...base.meta } : null,
      visible: la ? la.visible : lb.visible,
      opacity: la ? la.opacity : lb.opacity,
      locked: la ? la.locked : lb.locked,
      data: out,
    });
  }
  return { width, height, duration: Math.round(((a.duration || 0) + (b.duration || 0)) / 2) || a.duration, layers, tween: true, t };
}

/** 对两帧合成结果（PixelBuffer）做交叉溶解。 */
export function blendBuffers(a, b, t) {
  const out = new PixelBuffer(a.width, a.height);
  const da = a.data, db = b.data, d = out.data;
  for (let k = 0; k < d.length; k += 4) {
    const aa = da[k + 3] / 255;
    const ab = db[k + 3] / 255;
    const oa = aa * (1 - t) + ab * t;
    if (oa <= 0) continue;
    d[k + 3] = Math.round(oa * 255);
    d[k] = Math.round((da[k] * aa * (1 - t) + db[k] * ab * t) / oa);
    d[k + 1] = Math.round((da[k + 1] * aa * (1 - t) + db[k + 1] * ab * t) / oa);
    d[k + 2] = Math.round((da[k + 2] * aa * (1 - t) + db[k + 2] * ab * t) / oa);
  }
  return out;
}

/** 规范化补间参数。 */
function normalizeTween(animation, opts = {}) {
  const len = animation.frames.length;
  const from = clampInt(opts.from ?? animation.current, 0, Math.max(0, len - 1));
  let to = clampInt(opts.to ?? from + 1, 0, Math.max(0, len - 1));
  if (to === from) to = clampInt(from + 1, 0, len - 1);
  const steps = clampInt(opts.steps ?? 2, 1, 64);
  const easing = easingFn(opts.easing || animation.frames[from]?.easing || 'easeInOutQuad');
  return { from, to, steps, easing };
}

/**
 * 生成 from→to 之间的中间帧数组（不修改 animation）。
 * @returns {any[]}
 */
export function tweenFrameList(animation, opts = {}) {
  const { from, to, steps, easing } = normalizeTween(animation, opts);
  const A = animation.frames[from];
  const B = animation.frames[to];
  if (!A || !B) return [];
  const out = [];
  for (let i = 1; i <= steps; i++) {
    const t = easing(i / (steps + 1));
    out.push(blendFrames(A, B, t));
  }
  return out;
}

/**
 * 在 animation 的 from 帧之后插入 steps 张补间帧。
 * @returns {{inserted:number, at:number, easing:string}}
 */
export function insertTween(animation, opts = {}) {
  const { from, steps } = normalizeTween(animation, opts);
  const list = tweenFrameList(animation, opts);
  if (!list.length) return { inserted: 0, at: from + 1, easing: opts.easing || 'easeInOutQuad' };
  animation.frames.splice(from + 1, 0, ...list);
  animation.current = from + 1;
  return { inserted: list.length, at: from + 1, easing: opts.easing || 'easeInOutQuad' };
}

/**
 * 生成一条跨多个关键帧的补间时间线：对相邻关键帧分别补间。
 * @param {number[][]} keyIndices 关键帧索引（升序）
 */
export function tweenAcrossKeys(animation, keyIndices, opts = {}) {
  const keys = [...new Set((keyIndices || []).filter((i) => i >= 0 && i < animation.frames.length))].sort((a, b) => a - b);
  if (keys.length < 2) return { inserted: 0 };
  let inserted = 0;
  // 从后往前插，避免索引位移
  for (let i = keys.length - 2; i >= 0; i--) {
    inserted += insertTween(animation, { ...opts, from: keys[i], to: keys[i + 1] }).inserted;
  }
  return { inserted };
}
