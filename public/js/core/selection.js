/**
 * 选区区域运算（v2.1）
 * ---------------------------------------------------------------
 * 纯函数、无 UI 依赖，Node 可直接测试。
 * 提供：裁剪 / 清空 / 粘贴 / 翻转 / 旋转 / 缩放 / 平移。
 */

import { PixelBuffer, flipBuffer } from './buffer.js';

/** 把矩形裁到缓冲边界内，返回 {x,y,w,h}（可能为 0 尺寸）。 */
export function clampRegion(rect, width, height) {
  if (!rect) return { x: 0, y: 0, w: 0, h: 0 };
  let x0 = Math.floor(Math.min(rect.x, rect.x + rect.w));
  let y0 = Math.floor(Math.min(rect.y, rect.y + rect.h));
  let x1 = Math.ceil(Math.max(rect.x, rect.x + rect.w));
  let y1 = Math.ceil(Math.max(rect.y, rect.y + rect.h));
  x0 = Math.max(0, Math.min(width, x0));
  y0 = Math.max(0, Math.min(height, y0));
  x1 = Math.max(0, Math.min(width, x1));
  y1 = Math.max(0, Math.min(height, y1));
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/** 从缓冲裁剪出区域为新的 PixelBuffer（越界为透明）。 */
export function extractRegion(buffer, rect) {
  const r = clampRegion(rect, buffer.width, buffer.height);
  const out = new PixelBuffer(r.w, r.h);
  for (let y = 0; y < r.h; y++) {
    for (let x = 0; x < r.w; x++) {
      out.setPacked(x, y, buffer.getPacked(r.x + x, r.y + y));
    }
  }
  return out;
}

/** 把区域内像素清为透明。 */
export function clearRegion(buffer, rect) {
  const r = clampRegion(rect, buffer.width, buffer.height);
  buffer.fillRect(r.x, r.y, r.w, r.h, { r: 0, g: 0, b: 0, a: 0 }, false);
  return r;
}

/**
 * 把 src 覆盖粘贴到 dst 的 (x,y)。
 * @param {boolean} [blend] true 则做 Alpha 混合，false 直接覆盖（含透明）。
 */
export function pasteRegion(dst, src, x, y, blend = false) {
  for (let sy = 0; sy < src.height; sy++) {
    for (let sx = 0; sx < src.width; sx++) {
      const dx = x + sx, dy = y + sy;
      if (!dst.inBounds(dx, dy)) continue;
      if (blend) dst.plot(dx, dy, src.get(sx, sy), true);
      else dst.setPacked(dx, dy, src.getPacked(sx, sy));
    }
  }
}

/** 区域内水平/垂直翻转（原位）。 */
export function flipRegion(buffer, rect, axis = 'x') {
  const r = clampRegion(rect, buffer.width, buffer.height);
  if (r.w === 0 || r.h === 0) return r;
  const tmp = flipBuffer(extractRegion(buffer, r), axis);
  pasteRegion(buffer, tmp, r.x, r.y);
  return r;
}

/** 区域内顺时针旋转 deg（90/180/270）；90/270 会交换宽高并以 r.x,r.y 为锚点。 */
export function rotateRegion(buffer, rect, deg = 90) {
  const r = clampRegion(rect, buffer.width, buffer.height);
  if (r.w === 0 || r.h === 0) return r;
  const src = extractRegion(buffer, r);
  const d = ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
  let out;
  if (d === 90 || d === 270) {
    out = new PixelBuffer(src.height, src.width);
    for (let y = 0; y < out.height; y++) {
      for (let x = 0; x < out.width; x++) {
        const [sx, sy] = d === 90
          ? [y, src.height - 1 - x]
          : [src.width - 1 - y, x];
        out.setPacked(x, y, src.getPacked(sx, sy));
      }
    }
  } else if (d === 180) {
    out = new PixelBuffer(src.width, src.height);
    for (let y = 0; y < out.height; y++) {
      for (let x = 0; x < out.width; x++) out.setPacked(x, y, src.getPacked(src.width - 1 - x, src.height - 1 - y));
    }
  } else {
    out = src;
  }
  clearRegion(buffer, r);
  pasteRegion(buffer, out, r.x, r.y);
  return { x: r.x, y: r.y, w: out.width, h: out.height };
}

/** 区域最近邻整数缩放（原位，锚点 r.x,r.y）。 */
export function scaleRegion(buffer, rect, factorX = 2, factorY = factorX) {
  const r = clampRegion(rect, buffer.width, buffer.height);
  if (r.w === 0 || r.h === 0) return r;
  const src = extractRegion(buffer, r);
  const ow = Math.max(1, Math.round(src.width * factorX));
  const oh = Math.max(1, Math.round(src.height * factorY));
  const out = new PixelBuffer(ow, oh);
  for (let y = 0; y < oh; y++) {
    const sy = Math.min(src.height - 1, Math.floor(y / factorY));
    for (let x = 0; x < ow; x++) {
      const sx = Math.min(src.width - 1, Math.floor(x / factorX));
      out.setPacked(x, y, src.getPacked(sx, sy));
    }
  }
  clearRegion(buffer, r);
  pasteRegion(buffer, out, r.x, r.y);
  return { x: r.x, y: r.y, w: ow, h: oh };
}

/** 平移区域：原地剪切后粘贴到 (dx,dy)。 */
export function offsetRegion(buffer, rect, dx = 0, dy = 0) {
  const r = clampRegion(rect, buffer.width, buffer.height);
  if (r.w === 0 || r.h === 0 || (dx === 0 && dy === 0)) return r;
  const src = extractRegion(buffer, r);
  clearRegion(buffer, r);
  pasteRegion(buffer, src, r.x + dx, r.y + dy);
  return { x: r.x + dx, y: r.y + dy, w: r.w, h: r.h };
}
