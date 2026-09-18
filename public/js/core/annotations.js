/**
 * 画布标注（Point & Talk，v2.5）
 * ---------------------------------------------------------------
 * 用户在画布上框选若干区域并编号，生成时：
 *   · 标注会以高对比描边 + 编号**烘焙进回灌图**，让模型"看见"指哪；
 *   · 同时以文字描述区域坐标，供模型精确对应。
 * 纯逻辑 + 纯绘制，Node 可测（不依赖 Canvas）。
 */

import { glyph, GLYPH_W, GLYPH_H } from '../lang/font5x7.js';

/** 标注主色（屏幕与烘焙图统一，尽量不与常见像素色冲突）。 */
export const ANNOTATION_COLOR = { r: 255, g: 45, b: 149, a: 255 };
export const ANNOTATION_CSS = '#ff2d95';

/** 规范化一个标注矩形到画布范围内。 */
export function clampMark(mark, w, h) {
  const x = Math.max(0, Math.min(w - 1, Math.round(mark.x)));
  const y = Math.max(0, Math.min(h - 1, Math.round(mark.y)));
  const x1 = Math.max(x + 1, Math.min(w, Math.round(mark.x + mark.w)));
  const y1 = Math.max(y + 1, Math.min(h, Math.round(mark.y + mark.h)));
  return { x, y, w: x1 - x, h: y1 - y, label: String(mark.label || '') };
}

/** 归一化标注列表，丢弃越界/空标注。 */
export function normalizeMarks(marks, w, h) {
  return (marks || [])
    .filter((m) => m && m.w > 0 && m.h > 0)
    .map((m) => clampMark(m, w, h));
}

/** 把标注列表转成给模型的紧凑文字描述。 */
export function describeAnnotations(marks) {
  if (!marks?.length) return '';
  return marks.map((m, i) => {
    const label = m.label ? `，说明：${m.label}` : '';
    return `标注#${i + 1}：区域 x=${m.x} y=${m.y} w=${m.w} h=${m.h}${label}`;
  }).join('\n');
}

/** 直接在缓冲上画一个像素（越界忽略）。 */
function px(buf, x, y, c) {
  if (buf.inBounds(x, y)) buf.set(x, y, c);
}

/** 5×7 位图数字（白字，用于编号徽标）。 */
function drawDigits(buf, x, y, text, color) {
  let cursor = x;
  for (const ch of String(text)) {
    const rows = glyph(ch);
    for (let ry = 0; ry < GLYPH_H; ry++) {
      const row = rows[ry];
      for (let rx = 0; rx < GLYPH_W; rx++) {
        if (row[rx] === '1') px(buf, cursor + rx, y + ry, color);
      }
    }
    cursor += GLYPH_W + 1;
  }
}

/**
 * 把标注烘焙进一个 PixelBuffer（通常是 composite 的副本）。
 * 描 2px 边框，并在左上角画同色徽标 + 白色编号。
 * @param {import('./buffer.js').PixelBuffer} buf
 * @param {Array<{x:number,y:number,w:number,h:number,label?:string}>} marks
 */
export function bakeAnnotations(buf, marks) {
  const list = marks || [];
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    const x0 = m.x, y0 = m.y, x1 = m.x + m.w - 1, y1 = m.y + m.h - 1;
    for (let x = x0; x <= x1; x++) {
      px(buf, x, y0, ANNOTATION_COLOR);
      px(buf, x, y0 + 1, ANNOTATION_COLOR);
      px(buf, x, y1, ANNOTATION_COLOR);
      px(buf, x, y1 - 1, ANNOTATION_COLOR);
    }
    for (let y = y0; y <= y1; y++) {
      px(buf, x0, y, ANNOTATION_COLOR);
      px(buf, x0 + 1, y, ANNOTATION_COLOR);
      px(buf, x1, y, ANNOTATION_COLOR);
      px(buf, x1 - 1, y, ANNOTATION_COLOR);
    }
    // 编号徽标（贴在左上角内侧，避免超出画布）
    const label = String(i + 1);
    const bw = label.length * (GLYPH_W + 1) - 1 + 2;
    const bx = Math.min(Math.max(0, x0), Math.max(0, buf.width - bw));
    const by = Math.min(Math.max(0, y0), Math.max(0, buf.height - (GLYPH_H + 2)));
    for (let yy = 0; yy < GLYPH_H + 2; yy++) {
      for (let xx = 0; xx < bw; xx++) px(buf, bx + xx, by + yy, ANNOTATION_COLOR);
    }
    drawDigits(buf, bx + 1, by + 1, label, { r: 255, g: 255, b: 255, a: 255 });
  }
  return buf;
}

/**
 * 在 2D 画布上绘制标注（屏幕叠加层）。用 fillRect 逐像素画数字，避免依赖 fillText。
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<{x:number,y:number,w:number,h:number}>} marks
 * @param {{ox:number,oy:number,scale:number}} view
 */
export function drawAnnotations(ctx, marks, view) {
  const list = marks || [];
  if (!list.length) return;
  const { ox, oy, scale } = view;
  ctx.save();
  ctx.setLineDash([5, 3]);
  ctx.strokeStyle = ANNOTATION_CSS;
  ctx.lineWidth = 2;
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    const rx = ox + m.x * scale, ry = oy + m.y * scale;
    const rw = m.w * scale, rh = m.h * scale;
    ctx.strokeRect(rx + 0.5, ry + 0.5, rw, rh);
    ctx.setLineDash([]);
    ctx.fillStyle = ANNOTATION_CSS;
    const bw = 8 * Math.max(1, Math.round(scale / 8)), bh = 7 * Math.max(1, Math.round(scale / 8));
    ctx.fillRect(rx + 1, ry + 1, bw, bh);
    // 用屏幕像素画编号（1 位，够用）
    ctx.fillStyle = '#ffffff';
    const digit = (i + 1) % 10;
    const g = glyph(String(digit));
    const cell = Math.max(1, Math.floor(bh / GLYPH_H));
    for (let ry2 = 0; ry2 < GLYPH_H; ry2++) {
      for (let rx2 = 0; rx2 < GLYPH_W; rx2++) {
        if (g[ry2][rx2] === '1') ctx.fillRect(rx + 2 + rx2 * cell, ry + 2 + ry2 * cell, cell, cell);
      }
    }
    ctx.setLineDash([5, 3]);
  }
  ctx.restore();
}
