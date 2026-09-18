/**
 * 光流形变补间（v2.4）
 * ---------------------------------------------------------------
 * 交叉溶解（tween.js）只是把两帧叠在一起，运动物体的轮廓会「重影」。
 * 形变补间（morph）先估算 A→B 的稠密位移场，再按缓动进度把像素「推移」过去，
 * 得到真正的位移中间帧。
 *
 * 这里用块匹配（block matching + 金字塔细化）估算前向光流：
 *  - 纯 JS、确定性、可复现；
 *  - 对像素画这种小尺寸、大色块的输入足够稳；
 *  - 采样时按进度 t 做双向 warp：A 前移 t·flow，B 后移 (1-t)·flow，再交叉溶解，
 *    以减少遮挡区域的空洞。
 */

import { PixelBuffer } from './buffer.js';

/** 单通道亮度。 */
function luma(data, i) {
  return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
}

/**
 * 在 (x,y) 周围搜索 (dx,dy) ∈ [-r,r]²，使 A 块最接近 B 块。
 * @returns {{dx:number,dy:number,cost:number}}
 */
function matchBlock(A, B, w, h, x, y, bw, bh, r, prior = null) {
  const x0 = x - bw, x1 = x + bw, y0 = y - bh, y1 = y + bh;
  // 该块在 A 中是否有足够对比度（平坦区域不参与匹配，避免噪声位移）
  let lo = Infinity, hi = -Infinity;
  for (let sy = y0; sy <= y1; sy += 2) {
    for (let sx = x0; sx <= x1; sx += 2) {
      if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
      const l = luma(A, (sy * w + sx) * 4);
      if (l < lo) lo = l;
      if (l > hi) hi = l;
    }
  }
  if (hi - lo < 8) {
    // 平坦块：有先验就沿用先验，否则标记为未知
    if (prior) {
      const pk = (y * w + x) * 2;
      return { dx: prior[pk], dy: prior[pk + 1], cost: 0 };
    }
    return { dx: 0, dy: 0, cost: 0, flat: true };
  }
  // 有先验时以先验为中心搜索；否则全范围搜索
  let cx = 0, cy = 0;
  if (prior) {
    const pk = (y * w + x) * 2;
    cx = Math.round(prior[pk]);
    cy = Math.round(prior[pk + 1]);
  }
  let best = { dx: 0, dy: 0, cost: Infinity };
  for (let dy = cy - r; dy <= cy + r; dy++) {
    for (let dx = cx - r; dx <= cx + r; dx++) {
      let cost = 0, n = 0;
      for (let sy = y0; sy <= y1; sy += 2) {
        for (let sx = x0; sx <= x1; sx += 2) {
          const ax = sx, ay = sy;              // A 中固定块
          const bx = sx + dx, by = sy + dy;    // B 中候选块
          const inA = ax >= 0 && ay >= 0 && ax < w && ay < h;
          const inB = bx >= 0 && by >= 0 && bx < w && by < h;
          if (!inA || !inB) continue;
          const ia = (ay * w + ax) * 4, ib = (by * w + bx) * 4;
          cost += Math.abs(luma(A, ia) - luma(B, ib));
          n++;
        }
      }
      if (!n) continue;
      const c = cost / n;
      // 轻微惩罚偏离先验（正则化，抑制歧义匹配）；无先验时惩罚偏离零位移，
      // 这样静止画面/平坦块会稳定收敛到 0 而不是随机偏移。
      const rx = cx, ry = cy;
      const pen = 0.02 * (Math.abs(dx - rx) + Math.abs(dy - ry));
      const score = c + pen;
      if (score < best.cost - 1e-9) best = { dx, dy, cost: score };
    }
  }
  if (prior) {
    const pk = (y * w + x) * 2;
    const shift = Math.abs(best.dx - prior[pk]) + Math.abs(best.dy - prior[pk + 1]);
    if (shift < 1) return { dx: prior[pk], dy: prior[pk + 1], cost: best.cost };
  }
  return best;
}

/**
 * 估算 A→B 的稠密光流场（前向：A 中每个块移动到 B 的偏移）。
 * 采用**由粗到细金字塔**：先在 1/4、1/2 分辨率上估大位移，再在原分辨率上精修，
 * 这样即使物体移动超过半个画布也能捕捉到。
 * @param {Uint8ClampedArray} A @param {Uint8ClampedArray} B
 * @param {number} w @param {number} h
 * @param {{block?:number, radius?:number, levels?:number}} [opts]
 * @returns {Float32Array} 长度 w*h*2，依次 [dx,dy]
 */
export function estimateFlow(A, B, w, h, opts = {}) {
  const levels = Math.max(1, Math.min(3, Math.round(opts.levels ?? 3)));
  const baseBlock = Math.max(1, Math.round(opts.block || Math.max(2, Math.round(Math.min(w, h) / 16))));
  const fullRadius = Math.max(2, Math.round(opts.radius || Math.max(4, Math.round(Math.max(w, h) / 2))));
  let prior = null;

  for (let lv = levels - 1; lv >= 0; lv--) {
    const s = 1 << lv; // 4, 2, 1
    const cw = Math.max(1, Math.round(w / s));
    const ch = Math.max(1, Math.round(h / s));
    const cA = s === 1 ? A : downsample(A, w, h, s);
    const cB = s === 1 ? B : downsample(B, w, h, s);
    // 最细层用全范围搜索（对像素画最稳）；粗层用小半径但覆盖大半画布
    const radius = s === 1 ? fullRadius : Math.max(2, Math.round(Math.max(cw, ch) / 2));
    const { f } = flowAtLevel(cA, cB, cw, ch, baseBlock, radius, s === 1 ? null : prior);
    prior = s === 1 ? f : flowLevel(f, cw, ch, w, h);
    if (s === 1) { fillUnknown(f, new Uint8Array(w * h).fill(1), w, h, Math.max(w, h)); return f; }
  }
  return prior || new Float32Array(w * h * 2);
}

/** 逐层光流估计（含上一个尺度的上采样先验）。 */
function flowAtLevel(A, B, w, h, block, radius, prior) {
  const flow = new Float32Array(w * h * 2);
  const known = new Uint8Array(w * h);
  const step = Math.max(1, block);
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const m = matchBlock(A, B, w, h, x, y, block, block, radius, prior);
      if (m.flat && !prior) continue;
      for (let by = 0; by < step && y + by < h; by++) {
        for (let bx = 0; bx < step && x + bx < w; bx++) {
          const p = (y + by) * w + (x + bx);
          flow[p * 2] = m.dx;
          flow[p * 2 + 1] = m.dy;
          known[p] = 1;
        }
      }
    }
  }
  fillUnknown(flow, known, w, h, Math.max(w, h));
  smoothFlow(flow, w, h, 1, known);
  return { f: flow, known };
}

/** 把 flow 从 (w,h) 重采样到 (cw,ch)（最近邻）。 */
function flowLevel(flow, w, h, cw, ch) {
  if (cw === w && ch === h) return flow;
  const out = new Float32Array(cw * ch * 2);
  for (let y = 0; y < ch; y++) {
    const sy = Math.min(h - 1, Math.round((y / Math.max(1, ch - 1)) * (h - 1)));
    for (let x = 0; x < cw; x++) {
      const sx = Math.min(w - 1, Math.round((x / Math.max(1, cw - 1)) * (w - 1)));
      const si = (sy * w + sx) * 2, di = (y * cw + x) * 2;
      // 低分辨率上位移同比缩小
      out[di] = (flow[si] * cw) / w;
      out[di + 1] = (flow[si + 1] * ch) / h;
    }
  }
  return out;
}

/** 盒式降采样（先降采样亮度再估流，更快更稳）。 */
function downsample(data, w, h, s) {
  const cw = Math.max(1, Math.round(w / s)), ch = Math.max(1, Math.round(h / s));
  const out = new Uint8ClampedArray(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let dy = 0; dy < s; dy++) {
        for (let dx = 0; dx < s; dx++) {
          const sx = x * s + dx, sy = y * s + dy;
          if (sx >= w || sy >= h) continue;
          const i = (sy * w + sx) * 4;
          r += data[i]; g += data[i + 1]; b += data[i + 2]; a += data[i + 3]; n++;
        }
      }
      const o = (y * cw + x) * 4;
      out[o] = n ? r / n : 0; out[o + 1] = n ? g / n : 0;
      out[o + 2] = n ? b / n : 0; out[o + 3] = n ? a / n : 0;
    }
  }
  return out;
}

/**
 * 用最近邻扩散把已知位移填充到未知像素（多轮向外扩张）。
 * @param {Float32Array} flow @param {Uint8Array} known
 */
export function fillUnknown(flow, known, w, h, maxRadius = 8) {
  const dist = new Int32Array(w * h).fill(-1);
  let frontier = [];
  for (let i = 0; i < known.length; i++) {
    if (known[i]) { dist[i] = 0; frontier.push(i); }
  }
  if (!frontier.length) return flow;
  let d = 0;
  while (frontier.length && d < maxRadius) {
    const next = [];
    for (const i of frontier) {
      const x = i % w, y = (i / w) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (dist[j] !== -1) continue;
        // 取已定邻居的平均位移
        let sx = 0, sy = 0, n = 0;
        for (const [ex, ey] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const px = nx + ex, py = ny + ey;
          if (px < 0 || py < 0 || px >= w || py >= h) continue;
          const pj = py * w + px;
          if (dist[pj] === -1) continue;
          sx += flow[pj * 2]; sy += flow[pj * 2 + 1]; n++;
        }
        if (!n) continue;
        flow[j * 2] = sx / n;
        flow[j * 2 + 1] = sy / n;
        dist[j] = d + 1;
        next.push(j);
      }
    }
    frontier = next;
    d++;
  }
  return flow;
}

/** 对光流做盒式平滑，减少块状伪影。已知区域不参与平均（避免被空白拉偏）。 */
export function smoothFlow(flow, w, h, passes = 1, known = null) {
  let src = flow;
  for (let p = 0; p < passes; p++) {
    const out = new Float32Array(src.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sx = 0, sy = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            if (known && !known[ny * w + nx]) continue;
            const k = (ny * w + nx) * 2;
            sx += src[k]; sy += src[k + 1]; n++;
          }
        }
        const k = (y * w + x) * 2;
        if (n) { out[k] = sx / n; out[k + 1] = sy / n; }
        else { out[k] = src[k]; out[k + 1] = src[k + 1]; }
      }
    }
    src = out;
  }
  return src;
}

/** 双线性采样 RGBA（越界返回透明）。 */
function sampleBilinear(data, w, h, x, y, out) {
  if (x < -0.5 || y < -0.5 || x > w - 0.5 || y > h - 0.5) {
    out[0] = out[1] = out[2] = out[3] = 0;
    return out;
  }
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  let r = 0, g = 0, b = 0, a = 0;
  for (let dy = 0; dy <= 1; dy++) {
    for (let dx = 0; dx <= 1; dx++) {
      const sx = x0 + dx, sy = y0 + dy;
      const wgt = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
      if (wgt <= 0) continue;
      if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
      const i = (sy * w + sx) * 4;
      r += data[i] * wgt; g += data[i + 1] * wgt; b += data[i + 2] * wgt; a += data[i + 3] * wgt;
    }
  }
  out[0] = r; out[1] = g; out[2] = b; out[3] = a;
  return out;
}

/**
 * 按进度 t 生成 A→B 的光流形变中间帧。
 * @param {Uint8ClampedArray} A @param {Uint8ClampedArray} B
 * @param {number} w @param {number} h @param {number} t
 * @param {Float32Array} [flow] 预计算光流（缺省内部估算）
 * @returns {Uint8ClampedArray}
 */
export function morphBetween(A, B, w, h, t, flow) {
  const F = flow || estimateFlow(A, B, w, h);
  const out = new Uint8ClampedArray(w * h * 4);
  const px = [0, 0, 0, 0];
  const qx = [0, 0, 0, 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = (y * w + x) * 2;
      const dx = F[k], dy = F[k + 1];
      // A 前移 t·flow；B 后移 (1-t)·flow
      const ax = x + dx * t, ay = y + dy * t;
      const bx = x - dx * (1 - t), by = y - dy * (1 - t);
      sampleBilinear(A, w, h, ax, ay, px);
      sampleBilinear(B, w, h, bx, by, qx);
      const aw = px[3] / 255, bw = qx[3] / 255;
      const oa = aw * (1 - t) + bw * t;
      const i = (y * w + x) * 4;
      if (oa <= 0) continue;
      out[i + 3] = Math.round(oa * 255);
      out[i] = Math.round((px[0] * aw * (1 - t) + qx[0] * bw * t) / oa);
      out[i + 1] = Math.round((px[1] * aw * (1 - t) + qx[1] * bw * t) / oa);
      out[i + 2] = Math.round((px[2] * aw * (1 - t) + qx[2] * bw * t) / oa);
    }
  }
  return out;
}

/** PixelBuffer 版本。 */
export function morphBuffers(a, b, t, flow) {
  const out = new PixelBuffer(a.width, a.height);
  out.data.set(morphBetween(a.data, b.data, a.width, a.height, t, flow));
  return out;
}

/** 前向 warp（用于验证：t=1 应近似 B，t=0 应近似 A）。 */
export function warp(data, w, h, flow, t) {
  const F = flow;
  const out = new Uint8ClampedArray(w * h * 4);
  const px = [0, 0, 0, 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = (y * w + x) * 2;
      sampleBilinear(data, w, h, x + F[k] * t, y + F[k + 1] * t, px);
      const i = (y * w + x) * 4;
      out[i] = px[0]; out[i + 1] = px[1]; out[i + 2] = px[2]; out[i + 3] = px[3];
    }
  }
  return out;
}
