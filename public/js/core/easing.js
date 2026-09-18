/**
 * 缓动曲线（v1.8）
 * ---------------------------------------------------------------
 * 纯函数，无依赖。供时间轴补间（tween）与逐帧播放使用。
 * 输入归一化进度 t∈[0,1]，输出缓动后的进度（通常也在 [0,1]，回弹类会略超）。
 */

const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
const c1 = 1.70158;
const c2 = c1 * 1.525;
const c3 = c1 + 1;
const c4 = (2 * Math.PI) / 3;

/** @type {Record<string, (t:number)=>number>} */
export const EASING_FUNCS = {
  linear: (t) => t,
  step: () => 0, // 保持前一帧，直到下一关键帧（用于逐帧定格）
  easeInQuad: (t) => t * t,
  easeOutQuad: (t) => 1 - (1 - t) * (1 - t),
  easeInOutQuad: (t) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2),
  easeInCubic: (t) => t ** 3,
  easeOutCubic: (t) => 1 - (1 - t) ** 3,
  easeInOutCubic: (t) => (t < 0.5 ? 4 * t ** 3 : 1 - ((-2 * t + 2) ** 3) / 2),
  easeInSine: (t) => 1 - Math.cos((t * Math.PI) / 2),
  easeOutSine: (t) => Math.sin((t * Math.PI) / 2),
  easeInOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  easeInBack: (t) => c3 * t ** 3 - c1 * t ** 2,
  easeOutBack: (t) => 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2,
  easeInOutBack: (t) => (t < 0.5
    ? ((2 * t) ** 2 * ((c2 + 1) * 2 * t - c2)) / 2
    : ((2 * t - 2) ** 2 * ((c2 + 1) * (t * 2 - 2) + c2) + 2) / 2),
  easeOutBounce: (t) => {
    const n1 = 7.5625, d1 = 2.75;
    if (t < 1 / d1) return n1 * t * t;
    if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
    if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
    return n1 * (t -= 2.625 / d1) * t + 0.984375;
  },
  easeOutElastic: (t) => (t === 0 ? 0 : t === 1 ? 1 : 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1),
};

/** UI 下拉用的顺序列表。 */
export const EASINGS = Object.freeze([
  { id: 'linear', label: '线性' },
  { id: 'step', label: '定格（保持前一帧）' },
  { id: 'easeInQuad', label: '缓入 · 二次' },
  { id: 'easeOutQuad', label: '缓出 · 二次' },
  { id: 'easeInOutQuad', label: '缓入缓出 · 二次' },
  { id: 'easeInCubic', label: '缓入 · 三次' },
  { id: 'easeOutCubic', label: '缓出 · 三次' },
  { id: 'easeInOutCubic', label: '缓入缓出 · 三次' },
  { id: 'easeInSine', label: '缓入 · 正弦' },
  { id: 'easeOutSine', label: '缓出 · 正弦' },
  { id: 'easeInOutSine', label: '缓入缓出 · 正弦' },
  { id: 'easeInBack', label: '蓄力回拉' },
  { id: 'easeOutBack', label: '过冲回弹' },
  { id: 'easeInOutBack', label: '回拉 + 过冲' },
  { id: 'easeOutBounce', label: '弹跳' },
  { id: 'easeOutElastic', label: '弹性' },
]);

/** @returns {boolean} 是否为已知缓动名 */
export function hasEasing(name) { return typeof EASING_FUNCS[name] === 'function'; }

/** @returns {(t:number)=>number} 缓动函数（未知名回退线性） */
export function easingFn(name) {
  return EASING_FUNCS[name] || EASING_FUNCS.linear;
}

/** 对归一化进度应用缓动。@returns {number} */
export function ease(name, t) {
  return easingFn(name)(clamp01(t));
}

/** 缓动名 → 中文短标签（UI 用）。 */
export function easingLabel(name) {
  return EASINGS.find((e) => e.id === name)?.label || name || '线性';
}
