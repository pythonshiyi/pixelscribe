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
 */

import { runScript, extractScript, isDone } from '../lang/compiler.js';
import { buildSystemPrompt, buildUserBrief, buildCritique, buildRepair } from './prompts.js';

/**
 * @typedef {Object} AgentEvent
 * @property {'phase'|'delta'|'iteration'|'error'|'done'|'start'} type
 */

export class Agent {
  /**
   * @param {{provider:any, renderer:any, doc:any, history:any,
   *          onEvent?:(e:AgentEvent)=>void,
   *          maxIterations?:number, visionLongEdge?:number,
   *          incremental?:boolean, convergence?:number}} opts
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
      for (let i = 0; i < this.maxIterations; i++) {
        if (this.controller.signal.aborted) break;

        /* ── 1. 让模型写脚本 ── */
        this.emit({ type: 'phase', phase: i === 0 ? 'plan' : 'critique', index: i });
        const reply = await this.provider.chat(messages, {
          stream: true,
          signal: this.controller.signal,
          onDelta: (t) => this.emit({ type: 'delta', text: t, index: i }),
        });
        const text = reply.text || '';
        if (this.controller.signal.aborted) break;

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
          usage: reply.usage,
          before,
        };
        this.iterations.push(record);
        this.emit({ type: 'iteration', iteration: record, total: i + 1 });

        /* ── 4. 回灌 / 修复 ── */
        if (report.errors.length) {
          messages.push({ role: 'assistant', content: text });
          messages.push({ role: 'user', content: buildRepair(report) });
          continue;
        }

        if (report.changed === 0 && i > 0) {
          this.emit({ type: 'phase', phase: 'converged', index: i });
          break;
        }

        if (i === this.maxIterations - 1) break;

        messages.push({ role: 'assistant', content: text });
        messages.push({
          role: 'user',
          content: [
            { type: 'text', text: buildCritique({
              iteration: i + 1,
              max: this.maxIterations,
              mode: this.incremental ? 'append' : 'replace',
              report,
              ascii,
              hasImage: true,
            }) },
            { type: 'image_url', image_url: { url: vision, detail: 'high' } },
          ],
        });
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
      });
    }

    return this.iterations;
  }
}
