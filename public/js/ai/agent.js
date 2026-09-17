/**
 * 视觉闭环 Agent
 * ---------------------------------------------------------------
 * PLAN → EXECUTE → RENDER → CRITIQUE → (REPAIR | PATCH | DONE)
 *
 * 每一轮：
 *   1. 模型输出 PixelScript
 *   2. 引擎执行（replace / append）
 *   3. 渲染 PNG 回灌 + 执行报告 + 网格预览
 *   4. 模型自评，继续或结束
 *
 * 网关/模型适配（深度兼容 DeepSeek V4.1 Flash 等）：
 *   · reasoning_content 单独作为思考流回传 UI（不污染脚本抽取）；
 *   · 视觉不可用时自动降级为「纯文本审查」并继续闭环，不中断作画；
 *   · 每轮一个历史事务，任意轮可回退。
 */

import { runScript, extractScript, isDone } from '../lang/compiler.js';
import { buildSystemPrompt, buildUserBrief, buildCritique, buildRepair } from './prompts.js';

/**
 * @typedef {Object} AgentEvent
 * @property {'phase'|'delta'|'reasoning'|'iteration'|'error'|'done'|'start'|'usage'} type
 */

/** 视觉输入相关的失败（网关/模型不支持图片）——用于自动降级。 */
function isVisionError(err) {
  const status = Number(err?.status || 0);
  if (![400, 404, 413, 415, 422].includes(status)) return false;
  const msg = String(err?.message || '').toLowerCase();
  return /image|vision|multimodal|image_url|图片|图像|content.?type|unsupported|invalid.*content/.test(msg);
}

/** 去掉消息里的所有图片块，仅保留文本（视觉降级）。 */
function stripImages(messages) {
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      const texts = m.content.filter((p) => p?.type === 'text').map((p) => p.text).join('\n');
      m.content = texts || '请仅根据上面的执行报告与文字信息给出修正脚本。';
    }
  }
}

export class Agent {
  /**
   * @param {{provider:any, renderer:any, doc:any, history:any,
   *          onEvent?:(e:AgentEvent)=>void,
   *          maxIterations?:number, visionLongEdge?:number,
   *          incremental?:boolean, convergence?:number,
   *          vision?:'auto'|'on'|'off', maxTokens?:number}} opts
   */
  constructor(opts) {
    this.provider = opts.provider;
    this.renderer = opts.renderer;
    this.doc = opts.doc;
    this.history = opts.history;
    this.onEvent = opts.onEvent || (() => {});
    this.maxIterations = opts.maxIterations ?? 6;
    this.visionLongEdge = opts.visionLongEdge ?? 384;
    this.incremental = opts.incremental !== false;
    this.convergence = opts.convergence ?? 6;
    this.maxTokens = opts.maxTokens ?? 2048;
    this.vision = opts.vision ?? 'auto';
    this.visionEnabled = this.vision !== 'off';
    this.controller = null;
    this.iterations = [];
    this.running = false;
  }

  emit(e) { try { this.onEvent(e); } catch { /* UI 错误不影响闭环 */ } }

  abort() { this.controller?.abort(); }

  docInfo() {
    return {
      width: this.doc.width,
      height: this.doc.height,
      paletteName: this.doc.palette.label,
      paletteSize: this.doc.palette.colors.length,
      paletteLegend: this.doc.palette.legend(32),
      title: this.doc.title,
    };
  }

  /**
   * @param {string} brief 用户需求
   * @param {{seed?:number}} [opts]
   */
  async run(brief, opts = {}) {
    if (this.running) throw new Error('Agent 已在运行中');
    this.running = true;
    this.controller = new AbortController();
    this.iterations = [];

    const docInfo = this.docInfo();
    /** @type {any[]} */
    const messages = [
      { role: 'system', content: buildSystemPrompt(docInfo) },
      { role: 'user', content: buildUserBrief(brief, docInfo) },
    ];

    this.emit({ type: 'start', brief, maxIterations: this.maxIterations });

    try {
      let i = 0;
      while (i < this.maxIterations) {
        if (this.controller.signal.aborted) break;

        /* ── 1. 让模型写脚本 ── */
        this.emit({ type: 'phase', phase: i === 0 ? 'plan' : 'critique', index: i });
        let reply;
        try {
          reply = await this.provider.chat(messages, {
            stream: true,
            signal: this.controller.signal,
            maxTokens: this.maxTokens,
            onDelta: (t) => this.emit({ type: 'delta', text: t, index: i }),
            onReasoning: (t) => this.emit({ type: 'reasoning', text: t, index: i }),
          });
        } catch (err) {
          /* 视觉降级：网关/模型不吃图片 → 去掉图片重试同一轮，闭环继续 */
          if (this.visionEnabled && isVisionError(err)) {
            this.visionEnabled = false;
            stripImages(messages);
            this.emit({
              type: 'error',
              message: '当前模型/网关不接受图片输入，已降级为纯文本审查（仍可继续作画）',
              fatal: false,
            });
            continue;
          }
          throw err;
        }
        const text = reply.text || '';
        if (this.controller.signal.aborted) break;
        if (reply.usage) this.emit({ type: 'usage', usage: reply.usage, index: i });

        if (isDone(text) && i > 0) {
          this.emit({ type: 'phase', phase: 'done', index: i });
          break;
        }

        const script = extractScript(text);
        if (!script) {
          messages.push({ role: 'assistant', content: text });
          messages.push({
            role: 'user',
            content: '你的回复里没有可执行的 ```pixelscript 代码块。请只输出一个代码块。',
          });
          this.emit({ type: 'error', message: '模型未输出可执行脚本，已请求重试', fatal: false });
          i++;
          continue;
        }

        /* ── 2. 执行 ── */
        this.emit({ type: 'phase', phase: 'execute', index: i });
        const mode = i === 0 || !this.incremental ? 'replace' : 'append';
        const before = this.history.capture();
        this.history.begin(`AI 第 ${i + 1} 轮`);
        const report = runScript(script, this.doc, { mode, seed: opts.seed });
        this.history.commit();

        /* ── 3. 渲染 ── */
        this.emit({ type: 'phase', phase: 'render', index: i });
        const thumbnail = this.renderer.export(112, true).dataURL;
        const vision = this.renderer.visionDataURL(this.visionLongEdge);
        const ascii = report.changed > 0
          ? this.doc.activeLayer.buffer.toAscii(this.doc.palette, 32)
          : '';

        const record = {
          index: i,
          mode,
          script,
          report,
          thumbnail,
          text,
          reasoning: reply.reasoning || '',
          usage: reply.usage,
          before,
        };
        this.iterations.push(record);
        this.emit({ type: 'iteration', iteration: record, total: i + 1 });

        /* ── 4. 回灌 / 修复 ── */
        if (report.errors.length) {
          messages.push({ role: 'assistant', content: text });
          messages.push({ role: 'user', content: buildRepair(report) });
          i++;
          continue;
        }

        if (report.changed === 0 && i > 0) {
          this.emit({ type: 'phase', phase: 'converged', index: i });
          break;
        }

        if (i === this.maxIterations - 1) break;

        const critiqueText = buildCritique({
          iteration: i + 1,
          max: this.maxIterations,
          mode: this.incremental ? 'append' : 'replace',
          report,
          ascii,
          hasImage: this.visionEnabled,
        });
        messages.push({ role: 'assistant', content: text });
        messages.push({
          role: 'user',
          content: this.visionEnabled
            ? [
                { type: 'text', text: critiqueText },
                { type: 'image_url', image_url: { url: vision, detail: 'high' } },
              ]
            : critiqueText,
        });
        i++;
      }
    } catch (err) {
      if (err?.name === 'AbortError' || err?.code === 'ABORTED') {
        this.emit({ type: 'phase', phase: 'aborted' });
      } else {
        this.emit({ type: 'error', message: err?.message || String(err), fatal: true });
      }
    } finally {
      this.running = false;
      const last = this.iterations[this.iterations.length - 1];
      this.emit({
        type: 'done',
        rounds: this.iterations.length,
        changed: last?.report?.changed ?? 0,
        aborted: this.controller.signal.aborted,
        visionEnabled: this.visionEnabled,
      });
    }

    return this.iterations;
  }
}
