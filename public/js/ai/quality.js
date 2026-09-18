/**
 * 作品质量启发式评分（v2.5）
 * ---------------------------------------------------------------
 * 为「画得好不好」建立**确定性、可回归**的自动指标，用于：
 *   · 提示词 / DSL 迭代后的质量回归（golden set）；
 *   · 多候选生成时的排序依据（可选）；
 * 注意：这是启发式打分，不替代人眼，但能稳定捕获「空白 / 太乱 / 超色 / 构图失衡」等退步。
 * 纯函数，Node 可测。
 */

import { pack } from '../util/color.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const rangeScore = (v, lo, hi, edge = 0.5) => {
  if (v <= 0) return 0;
  if (v >= lo && v <= hi) return 1;
  if (v < lo) return clamp01(v / lo) * edge + (1 - edge); // 低于下限缓慢扣分
  return clamp01(1 - (v - hi));
};

/**
 * @param {import('../core/buffer.js').PixelBuffer} buffer
 * @param {{palette?: {colors:Array<{r,g,b,a}>}, style?: string}} [opts]
 * @returns {{score:number, metrics:object}}
 */
export function scoreArt(buffer, opts = {}) {
  const w = buffer.width, h = buffer.height, n = w * h;
  const data = buffer.data;
  const counts = new Map();
  let opaque = 0;
  let contour = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const a = data[i * 4 + 3];
      if (a === 0) continue;
      opaque++;
      const key = buffer.u32[i];
      counts.set(key, (counts.get(key) || 0) + 1);
      // 轮廓密度：alpha 与四邻不同的像素
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1
        || data[(i - 1) * 4 + 3] !== a || data[(i + 1) * 4 + 3] !== a
        || data[(i - w) * 4 + 3] !== a || data[(i + w) * 4 + 3] !== a) {
        contour++;
      }
    }
  }
  const coverage = opaque / n;
  const colorCount = counts.size;
  const contourRatio = opaque ? contour / opaque : 0;

  let paletteAdherence = 1;
  if (opts.palette?.colors?.length) {
    const set = new Set(opts.palette.colors.map((c) => pack(c)));
    let matched = 0;
    for (const [key, count] of counts) if (set.has(key)) matched += count;
    paletteAdherence = opaque ? matched / opaque : 0;
  }

  const bounds = buffer.bounds();
  const bboxFraction = bounds
    ? ((bounds.x1 - bounds.x0 + 1) * (bounds.y1 - bounds.y0 + 1)) / n
    : 0;

  if (opaque === 0) {
    return { score: 0, metrics: { coverage: 0, colorCount: 0, paletteAdherence: 0, bboxFraction: 0, contourRatio: 0, opaque: 0 } };
  }

  // 各分项 0..1
  const sCoverage = rangeScore(coverage, 0.2, 0.9, 0.4);
  const sColor = colorCount <= 2 ? 0.5 : colorCount <= 16 ? 1 : clamp01(1 - (colorCount - 16) / 48);
  const sComposition = rangeScore(bboxFraction, 0.35, 0.98, 0.3);
  const sPalette = paletteAdherence;
  const sContour = rangeScore(contourRatio, 0.15, 0.6, 0.4);

  const score = Math.round(100 * (
    sCoverage * 0.32
    + sColor * 0.20
    + sComposition * 0.20
    + sPalette * 0.18
    + sContour * 0.10
  ));

  return {
    score,
    metrics: {
      coverage: Number(coverage.toFixed(3)),
      colorCount,
      paletteAdherence: Number(paletteAdherence.toFixed(3)),
      bboxFraction: Number(bboxFraction.toFixed(3)),
      contourRatio: Number(contourRatio.toFixed(3)),
      opaque,
    },
  };
}

/**
 * 对一组评分求平均并给出分布，用于基准报告。
 * @param {number[]} scores
 */
export function summarizeScores(scores) {
  const list = (scores || []).filter((s) => Number.isFinite(s));
  if (!list.length) return { count: 0, mean: 0, min: 0, max: 0 };
  const mean = list.reduce((a, b) => a + b, 0) / list.length;
  return {
    count: list.length,
    mean: Number(mean.toFixed(2)),
    min: Math.min(...list),
    max: Math.max(...list),
  };
}
