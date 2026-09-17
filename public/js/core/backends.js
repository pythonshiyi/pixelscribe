/**
 * 渲染后端（S2/S3）
 * ---------------------------------------------------------------
 * 把「一只确定性的手」扩展为「三种渲染后端」：
 *
 *   raster      —— 现引擎原样输出（像素风/图标/UI，完全可复现）
 *   procedural  —— CPU 程序化先验（法线光照/高光/泛光/色调，无依赖）
 *   neural      —— 远程扩散/img2img 后端（可选，经服务端 /api/render 代理）
 *
 * 关键机制：DSL 渲染出的缓冲可以导出为 **控制图**（边缘/深度/法线），
 * 喂给神经后端做 ControlNet 式条件——模型只写几百 token，却精确锚定构图。
 * 神经后端不可用时优雅降级到 procedural，闭环不中断。
 *
 * 运行时零依赖（Node 20+ / 现代浏览器均可用）。
 */

import { encodePNG, encodePNGScaled, toBase64 } from '../io/png.js';
import { surfaceNormals, normalizeStyle } from './effects.js';
import { PixelBuffer } from './buffer.js';

/** @typedef {import('./buffer.js').PixelBuffer} PixelBuffer */

export const BACKEND_IDS = Object.freeze(['raster', 'procedural', 'neural']);

/** 风格 → 默认后端（可被显式 render / 设置覆盖）。 */
const STYLE_BACKEND = {
  pixel: 'raster',
  painting: 'procedural',
  ink: 'procedural',
  anime: 'procedural',
  '3d': 'procedural',
  photo: 'neural',
};

/**
 * 选择渲染后端。
 * @param {string} style
 * @param {{neuralAvailable?:boolean, explicit?:string}} [opts]
 * @returns {'raster'|'procedural'|'neural'}
 */
export function resolveBackendId(style, opts = {}) {
  const styleDefault = STYLE_BACKEND[normalizeStyle(style)] || 'raster';
  const wanted = opts.explicit && BACKEND_IDS.includes(opts.explicit) ? opts.explicit : styleDefault;
  if (wanted === 'neural' && !opts.neuralAvailable) {
    // 神经不可用：回退到该风格的确定性后端（pixel→raster，其它→procedural）
    return styleDefault === 'neural' ? 'procedural' : styleDefault;
  }
  return wanted;
}

/* ───────────────────────── 控制图 ───────────────────────── */

function luminanceAlpha(buffer) {
  const n = buffer.width * buffer.height;
  const { data } = buffer;
  const L = new Float32Array(n);
  const A = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const a = data[i * 4 + 3];
    A[i] = a;
    L[i] = a === 0 ? 0 : (0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2]) / 255;
  }
  return { L, A };
}

/** Sobel 边缘强度 0..1 */
function edgeField(buffer) {
  const { width: w, height: h } = buffer;
  const { L, A } = luminanceAlpha(buffer);
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : L[y * w + x]);
  const E = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gx = -at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1)
        + at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1);
      const gy = -at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1)
        + at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1);
      E[y * w + x] = Math.min(1, Math.hypot(gx, gy) * 0.5);
    }
  }
  return { E, A };
}

/**
 * 生成控制图原始 RGBA（供神经后端 / 预览）。
 * @param {PixelBuffer} buffer
 * @param {'edges'|'depth'|'normal'|'alpha'} kind
 * @returns {Uint8ClampedArray}
 */
export function controlMapRaw(buffer, kind = 'edges') {
  const { width: w, height: h } = buffer;
  const out = new Uint8ClampedArray(w * h * 4);
  if (kind === 'normal') {
    const N = surfaceNormals(buffer, 2);
    for (let i = 0; i < w * h; i++) {
      out[i * 4] = Math.round((N[i * 3] * 0.5 + 0.5) * 255);
      out[i * 4 + 1] = Math.round((N[i * 3 + 1] * 0.5 + 0.5) * 255);
      out[i * 4 + 2] = Math.round((N[i * 3 + 2] * 0.5 + 0.5) * 255);
      out[i * 4 + 3] = 255;
    }
    return out;
  }
  if (kind === 'alpha') {
    const { A } = luminanceAlpha(buffer);
    for (let i = 0; i < w * h; i++) { out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = A[i]; out[i * 4 + 3] = 255; }
    return out;
  }
  if (kind === 'depth') {
    const { L, A } = luminanceAlpha(buffer);
    for (let i = 0; i < w * h; i++) {
      const v = A[i] === 0 ? 0 : Math.round(L[i] * 255);
      out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v;
      out[i * 4 + 3] = 255;
    }
    return out;
  }
  // edges
  const { E, A } = edgeField(buffer);
  for (let i = 0; i < w * h; i++) {
    const v = A[i] === 0 ? 0 : Math.round(E[i] * 255);
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v;
    out[i * 4 + 3] = 255;
  }
  return out;
}

/**
 * 控制图 dataURL（可缓冲复用），长边放大到 ≥ longEdge 便于模型/后端识别。
 * @param {PixelBuffer} buffer @param {'edges'|'depth'|'normal'|'alpha'} kind
 */
export function controlMapDataURL(buffer, kind = 'edges', longEdge = 512) {
  const s = Math.max(1, Math.round(longEdge / Math.max(buffer.width, buffer.height)));
  const png = encodePNGScaled(controlMapRaw(buffer, kind), buffer.width, buffer.height, buffer.width * s, buffer.height * s);
  return `data:image/png;base64,${toBase64(png)}`;
}

/** 一次导出全部控制图（供神经后端）。 */
export function controlMaps(buffer, longEdge = 512) {
  return {
    edges: controlMapDataURL(buffer, 'edges', longEdge),
    depth: controlMapDataURL(buffer, 'depth', longEdge),
    normal: controlMapDataURL(buffer, 'normal', longEdge),
    alpha: controlMapDataURL(buffer, 'alpha', longEdge),
  };
}

/* ───────────────────────── 区域裁剪 / 蒙版（局部重绘） ───────────────────────── */

/** 把矩形裁到缓冲范围内并取整 @returns {{x:number,y:number,w:number,h:number}}|null */
export function clampRect(rect, width, height) {
  let { x, y, w, h } = rect || {};
  x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
  if (w < 0) { x += w; w = -w; }
  if (h < 0) { y += h; h = -h; }
  const x0 = Math.max(0, x), y0 = Math.max(0, y);
  const x1 = Math.min(width, x + w), y1 = Math.min(height, y + h);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** 裁剪出子缓冲（越界部分透明） */
export function cropBuffer(buffer, rect) {
  const r = clampRect(rect, buffer.width, buffer.height);
  const out = new PixelBuffer(Math.max(1, r ? r.w : 0), Math.max(1, r ? r.h : 0));
  if (!r) return out;
  for (let yy = 0; yy < r.h; yy++) {
    for (let xx = 0; xx < r.w; xx++) {
      out.set(xx, yy, buffer.get(r.x + xx, r.y + yy));
    }
  }
  return out;
}

/**
 * 把子缓冲贴回目标（仅复制不透明像素；可选 mask 矩形做硬边限定）。
 * @param {PixelBuffer} dst @param {PixelBuffer} src
 * @param {number} dx @param {number} dy
 * @param {{x:number,y:number,w:number,h:number}|null} [mask] dst 坐标系下的限定矩形
 */
export function pasteBuffer(dst, src, dx, dy, mask = null) {
  const m = mask ? clampRect(mask, dst.width, dst.height) : null;
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const tx = dx + x, ty = dy + y;
      if (m && (tx < m.x || ty < m.y || tx >= m.x + m.w || ty >= m.y + m.h)) continue;
      const c = src.get(x, y);
      if (c.a === 0) continue;
      dst.set(tx, ty, c);
    }
  }
}

/**
 * 生成全画布蒙版 PNG：白=重绘区，黑=保留区（神经 inpainting 的标准输入）。
 * @param {PixelBuffer} buffer @param {{x:number,y:number,w:number,h:number}} rect
 */
export function maskMapDataURL(buffer, rect) {
  const { width: w, height: h } = buffer;
  const out = new Uint8ClampedArray(w * h * 4);
  const r = clampRect(rect, w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inside = r && x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
      const i = (y * w + x) * 4;
      const v = inside ? 255 : 0;
      out[i] = out[i + 1] = out[i + 2] = v;
      out[i + 3] = 255;
    }
  }
  return `data:image/png;base64,${toBase64(encodePNG(out, w, h))}`;
}

/* ───────────────────────── 神经后端 ───────────────────────── */

/** 把上游各种返回形态归一化为 PNG dataURL。 */
export function normalizeNeuralResponse(json) {
  if (!json) return null;
  if (typeof json === 'string') {
    if (json.startsWith('data:image/')) return json;
    return null;
  }
  if (typeof json.image === 'string') return json.image;
  if (typeof json.image_url === 'string') return json.image_url;
  if (Array.isArray(json.images) && typeof json.images[0] === 'string') return json.images[0];
  const d0 = Array.isArray(json.data) ? json.data[0] : null;
  if (d0) {
    if (typeof d0.b64_json === 'string') return `data:image/png;base64,${d0.b64_json}`;
    if (typeof d0.url === 'string') return d0.url;
    if (typeof d0.image === 'string') return d0.image;
  }
  return null;
}

/**
 * 请求远程神经渲染（img2img / inpaint / upscale）。失败返回 null，由调用方降级。
 * @param {{endpoint?:string, task?:'img2img'|'inpaint'|'upscale', image:string, mask?:string,
 *          controls?:object, prompt?:string, style?:string, strength?:number, seed?:number,
 *          width?:number, height?:number, signal?:AbortSignal}} opts
 * @returns {Promise<{image:string, backend:string, task:string, raw?:any}|null>}
 */
export async function requestNeural(opts) {
  const endpoint = opts.endpoint || '/api/render';
  const task = opts.task || 'img2img';
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task,
        image: opts.image,
        mask: opts.mask || null,
        controls: opts.controls || null,
        reference: opts.reference || null,
        prompt: opts.prompt || '',
        style: opts.style || 'photo',
        strength: opts.strength ?? 0.6,
        seed: opts.seed ?? null,
        width: opts.width,
        height: opts.height,
      }),
      signal: opts.signal,
    });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    let image = null;
    if (ct.includes('application/json')) {
      image = normalizeNeuralResponse(await res.json());
    } else if (ct.startsWith('image/')) {
      const buf = await res.arrayBuffer();
      image = `data:${ct.split(';')[0]};base64,${arrayBufferToBase64(buf)}`;
    } else {
      const text = await res.text();
      image = normalizeNeuralResponse(text);
    }
    return image ? { image, backend: 'neural', task } : null;
  } catch {
    return null;
  }
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return typeof btoa === 'function' ? btoa(bin) : Buffer.from(bin, 'binary').toString('base64');
}

/** 便捷：导出当前缓冲的 PNG dataURL（给神经后端作底图）。 */
export function bufferDataURL(buffer, longEdge = 0) {
  if (longEdge > 0) {
    const s = Math.max(1, Math.round(longEdge / Math.max(buffer.width, buffer.height)));
    return `data:image/png;base64,${toBase64(encodePNGScaled(buffer.data, buffer.width, buffer.height, buffer.width * s, buffer.height * s))}`;
  }
  return `data:image/png;base64,${toBase64(encodePNG(buffer.data, buffer.width, buffer.height))}`;
}
