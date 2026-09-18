/**
 * 用量与成本统计（v2.4）
 * ---------------------------------------------------------------
 * provider 每轮返回 usage（prompt_tokens / completion_tokens），
 * 这里按「每百万 token 单价」估算花费，并维护会话累计。
 * 纯数据 + 纯函数，Node 可测。
 */

/** 常见模型单价（USD / 1M tokens）。价格会变，仅作估算，可被设置覆盖。 */
export const MODEL_PRICING = Object.freeze({
  'deepseek-flash': { input: 0.14, output: 0.28 },
  'deepseek-v4.1-flash': { input: 0.14, output: 0.28 },
  'deepseek-chat': { input: 0.27, output: 1.10 },
  'gpt-4o': { input: 2.50, output: 10.0 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'qwen-vl-max': { input: 0.40, output: 1.20 },
  'glm-4v': { input: 0.10, output: 0.10 },
  'gemini-2.0-flash': { input: 0.10, output: 0.40 },
  demo: { input: 0, output: 0 },
});

/** 未知模型的兜底单价。 */
export const DEFAULT_PRICING = { input: 0.5, output: 1.5 };

/** @returns {{input:number, output:number}} 单价（USD/1M） */
export function pricingFor(model, overrides = {}) {
  if (overrides && overrides[model]) return overrides[model];
  return MODEL_PRICING[model] || DEFAULT_PRICING;
}

/**
 * 估算一次调用的花费（USD）。
 * @param {{prompt_tokens?:number, completion_tokens?:number, total_tokens?:number}} usage
 */
export function costOf(usage, model, overrides = {}) {
  if (!usage) return 0;
  const p = pricingFor(model, overrides);
  const pin = Number(usage.prompt_tokens || 0);
  const pout = Number(usage.completion_tokens || 0);
  return (pin * p.input + pout * p.output) / 1_000_000;
}

/** 会话用量与花费累计器。 */
export class CostTracker {
  constructor(opts = {}) {
    this.model = opts.model || '';
    this.overrides = opts.overrides || {};
    this.reset();
  }

  reset() {
    this.calls = 0;
    this.promptTokens = 0;
    this.completionTokens = 0;
    this.cost = 0;
    this.frames = 0;
    this.startedAt = Date.now();
  }

  get totalTokens() { return this.promptTokens + this.completionTokens; }

  /** 记录一次调用。@returns {number} 本次花费 */
  add(usage, model = this.model) {
    if (!usage) return 0;
    const c = costOf(usage, model, this.overrides);
    this.calls++;
    this.promptTokens += Number(usage.prompt_tokens || 0);
    this.completionTokens += Number(usage.completion_tokens || 0);
    this.cost += c;
    return c;
  }

  /** 一行摘要（UI 用）。 */
  summary() {
    const fmt = (n) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
    const usd = this.cost < 0.01 ? `$${this.cost.toFixed(4)}` : `$${this.cost.toFixed(3)}`;
    return `${this.calls} 次 · ${fmt(this.promptTokens + this.completionTokens)} tok · ${usd}`;
  }

  /** 带动画的小时估算：剩余帧数 × 平均每帧花费。 */
  estimateFrames(n, avgCostPerFrame) {
    const per = avgCostPerFrame ?? (this.frames ? this.cost / this.frames : 0);
    return per * Math.max(0, n);
  }

  toJSON() {
    return {
      calls: this.calls,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      cost: this.cost,
      model: this.model,
    };
  }
}
