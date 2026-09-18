/**
 * 纯 JS SVG 写出器（v2.0）
 * ---------------------------------------------------------------
 * 把像素图元矢量化为 `<path>`（横向游程合并），零依赖、可复现。
 * 适合把 logo / 图标 / 像素精灵导入矢量工作流（Figma / Illustrator / Web）。
 *
 * 说明：像素画的「一个像素 = 一个方形」，这里把同一行连续同色像素
 * 合并成一条 `M x y h w v1 h-w z` 路径，显著减小文件体积。
 */

import { unpack } from '../util/color.js';

const hex2 = (n) => n.toString(16).padStart(2, '0');
const colorHex = (c) => `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;

/**
 * @param {Uint8ClampedArray} data RGBA 数据
 * @param {number} width
 * @param {number} height
 * @returns {number[]} 每行的 packed 颜色（用于比较）
 */
function packRow(data, width, y) {
  const row = new Array(width);
  for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    row[x] = (
      ((data[i + 3] & 0xff) << 24)
      | ((data[i + 2] & 0xff) << 16)
      | ((data[i + 1] & 0xff) << 8)
      | (data[i] & 0xff)
    ) >>> 0;
  }
  return row;
}

/**
 * 像素缓冲 → SVG 字符串。
 * @param {Uint8ClampedArray} data
 * @param {number} width
 * @param {number} height
 * @param {{scale?:number, background?:{r:number,g:number,b:number,a:number}|null, title?:string, crisp?:boolean}} [opts]
 * @returns {string}
 */
export function encodeSVG(data, width, height, opts = {}) {
  const scale = Math.max(1, Math.round(opts.scale || 1));
  const ow = width * scale;
  const oh = height * scale;
  const crisp = opts.crisp !== false;
  /** colorKey -> path segments */
  const groups = new Map();

  for (let y = 0; y < height; y++) {
    const row = packRow(data, width, y);
    let x = 0;
    while (x < width) {
      const u = row[x];
      const a = u >>> 24;
      if (a === 0) { x++; continue; }
      let end = x + 1;
      while (end < width && row[end] === u) end++;
      const c = unpack(u);
      const key = `${colorHex(c)}/${c.a}`;
      let d = groups.get(key);
      if (!d) { d = []; groups.set(key, d); }
      const rx = x * scale, ry = y * scale, rw = (end - x) * scale, rh = scale;
      d.push(`M${rx} ${ry}h${rw}v${rh}h-${rw}z`);
      x = end;
    }
  }

  const paths = [...groups.entries()].map(([key, segs]) => {
    const [hex, alphaStr] = key.split('/');
    const alpha = Number(alphaStr);
    const op = alpha >= 255 ? '' : ` fill-opacity="${(alpha / 255).toFixed(3)}"`;
    return `  <path d="${segs.join('')}" fill="${hex}"${op}/>`;
  });

  const bg = opts.background && opts.background.a > 0
    ? `  <rect width="${ow}" height="${oh}" fill="${colorHex(opts.background)}"${opts.background.a >= 255 ? '' : ` fill-opacity="${(opts.background.a / 255).toFixed(3)}"`}/>\n`
    : '';

  const title = opts.title ? `  <title>${escapeXml(opts.title)}</title>\n` : '';
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<svg xmlns="http://www.w3.org/2000/svg" width="${ow}" height="${oh}" viewBox="0 0 ${ow} ${oh}"`
    + (crisp ? ' shape-rendering="crispEdges"' : '')
    + `>\n${title}${bg}${paths.join('\n')}\n</svg>\n`
  );
}

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, (c) => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]
  ));
}

/** SVG → dataURL（下载 / <img> 预览用）。 */
export function svgDataURL(svg) {
  const b64 = typeof btoa === 'function'
    ? btoa(unescape(encodeURIComponent(svg)))
    : Buffer.from(svg, 'utf8').toString('base64');
  return `data:image/svg+xml;base64,${b64}`;
}
