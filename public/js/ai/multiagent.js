/**
 * 多智能体协作（v2.0）
 * ---------------------------------------------------------------
 * 把一次作画拆成三个分工明确的角色，各自只关注一件事：
 *
 *   构图师 composer  —— 定主体、构图、剪影与明暗骨架（整幅 replace）
 *   上色师 colorist  —— 在骨架上铺色、加光照材质与高光（增量 append）
 *   审查师 reviewer  —— 看图自评，指出问题并给修正脚本，满意则 DONE
 *
 * 与单 Agent 闭环相比，职责分离降低了单轮认知负担，复杂画面更稳。
 * 事件协议与 Agent 保持一致（phase/iteration/error/done…），
 * 因此 ChatPanel 可无差别渲染。
 */

import { runScript, extractScript, isDone } from '../lang/compiler.js';
import { buildSystemPrompt, buildUserBrief, buildCritique, buildRepair, computeTiles } from './prompts.js';
import { normalizeStyle } from '../core/effects.js';
import { Agent } from './agent.js';

/** 角色元数据。 */
export const ROLES = Object.freeze({
  composer: { id: 'composer', name: '构图师', icon: '✦' },
  colorist: { id: 'colorist', name: '上色师', icon: '◐' },
  reviewer: { id: 'reviewer', name: '审查师', icon: '🔍' },
});

function roleLine(role) {
  switch (role) {
    case 'composer':
      return `\n\n# 本轮你的角色：构图师
你只负责**构图与明暗骨架**：确定主体位置/占比/剪影，用 3–5 个大色块建立明暗关系。
不要纠结细节纹理与高光——那是上色师的工作。输出一个 \`\`\`pixelscript 代码块，整幅绘制。`;
    case 'colorist':
      return `\n\n# 本轮你的角色：上色师
构图师已经打好骨架（见回灌图）。请在其基础上**增量**着色：调整配色、加光照/材质/高光、
细化形体与轮廓。只写需要新增或覆盖的指令，不要重画全部内容。输出一个 \`\`\`pixelscript 代码块。`;
    case 'reviewer':
      return `\n\n# 本轮你的角色：审查师
像美术总监一样审视这张图。若有明确问题，输出**增量**修正脚本；若已足够好，只回复 DONE。
不要为了改动而改动。`;
    default:
      return '';
  }
}

/** 评审回灌用的用户提示。 */
function reviewPrompt(role, brief, info) {
  const base = buildCritique(info);
  if (role === 'colorist') {
    return `用户需求：${brief}\n\n${base}`;
  }
  return base;
}

function isVisionError(err) {
  const status = Number(err?.status || 0);
  if (![400, 404, 413, 415, 422].includes(status)) return false;
  const msg = String(err?.message || '').toLowerCase();
  return /image|vision|multimodal|image_url|图片|图像|content.?type|unsupported|invalid.*content/.test(msg);
}

function stripImages(messages) {
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      const texts = m.content.filter((p) => p?.type === 'text').map((p) => p.text).join('\n');
      m.content = texts || '请仅根据上面的执行报告与文字信息给出修正脚本。';
    }
  }
}

export class MultiAgent {
  /**
   * @param {any} opts 与 Agent 构造参数兼容
   */
  constructor(opts = {}) {
    this.provider = opts.provider;
    this.renderer = opts.renderer;
    this.doc = opts.doc;
    this.history = opts.history;
    this.onEvent = opts.onEvent || (() => {});
    this.maxIterations = Math.max(2, opts.maxIterations ?? 6);
    this.visionLongEdge = opts.visionLongEdge ?? 384;
    this.visionDetail = opts.visionDetail || 'high';
    this.maxTokens = opts.maxTokens ?? 2048;
    this.visionEnabled = (opts.vision ?? 'auto') !== 'off';
    this.controller = null;
    this.iterations = [];
    this.running = false;
    this._index = 0;
    // 复用单 Agent 的渲染管线（构图/上色/审查共用同一套风格后端）
    this.renderHelper = new Agent({
      provider: null,
      renderer: this.renderer,
      doc: this.doc,
      history: this.history,
      neuralAvailable: opts.neuralAvailable === true,
      neuralEndpoint: opts.neuralEndpoint,
      neuralPrompt: opts.neuralPrompt || '',
      neuralStrength: opts.neuralStrength,
      visionLongEdge: this.visionLongEdge,
    });
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
      style: normalizeStyle(this.doc.style),
      neuralRender: this.renderHelper.neuralAvailable,
    };
  }

  /** 执行一段脚本并走渲染管线，返回本轮记录。 */
  async execute(script, mode, label) {
    const before = this.history.capture();
    const bufBefore = this.doc.activeLayer.buffer.clone();
    this.history.begin(label);
    const report = runScript(script, this.doc, { mode, deferRender: true });
    let renderInfo = null;
    if (!report.errors.length) {
      renderInfo = await this.renderHelper.applyRenderPipeline().catch(() => null);
    }
    this.history.commit();
    const thumbnail = this.renderer?.export ? this.renderer.export(112, true).dataURL : '';
    const tiles = computeTiles(bufBefore, this.doc.activeLayer.buffer, 3);
    return { report, renderInfo, before, thumbnail, tiles };
  }

  /** 让某个角色产出文本（带视觉降级重试）。 */
  async ask(role, system, content, index) {
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content },
    ];
    this.emit({ type: 'phase', phase: 'plan', index, role });
    try {
      return await this.provider.chat(messages, {
        stream: true,
        signal: this.controller.signal,
        maxTokens: this.maxTokens,
        onDelta: (t) => this.emit({ type: 'delta', text: t, index }),
        onReasoning: (t) => this.emit({ type: 'reasoning', text: t, index }),
      });
    } catch (err) {
      if (this.visionEnabled && isVisionError(err)) {
        this.visionEnabled = false;
        stripImages(messages);
        this.emit({
          type: 'error',
          message: '当前模型/网关不接受图片输入，多智能体已降级为纯文本审查',
          fatal: false,
        });
        return await this.provider.chat(messages, {
          stream: true,
          signal: this.controller.signal,
          maxTokens: this.maxTokens,
          onDelta: (t) => this.emit({ type: 'delta', text: t, index }),
          onReasoning: (t) => this.emit({ type: 'reasoning', text: t, index }),
        });
      }
      throw err;
    }
  }

  /** 组装带渲染图的回灌内容。 */
  critiqueContent(role, brief, info) {
    const text = reviewPrompt(role, brief, info);
    if (!this.visionEnabled || !this.renderer?.visionDataURL) return text;
    const vision = this.renderer.visionDataURL(this.visionLongEdge);
    return [
      { type: 'text', text },
      { type: 'image_url', image_url: { url: vision, detail: this.visionDetail } },
    ];
  }

  /**
   * @param {string} brief
   */
  async run(brief) {
    if (this.running) throw new Error('MultiAgent 已在运行中');
    this.running = true;
    this.controller = new AbortController();
    this.iterations = [];
    this._index = 0;

    this.emit({ type: 'start', brief, maxIterations: this.maxIterations, frames: 1, multi: true });

    const docInfo = this.docInfo();
    const baseSystem = buildSystemPrompt(docInfo);

    try {
      /* ── 第 1 轮：构图师 ── */
      if (this.controller.signal.aborted) throw abortError();
      const compReply = await this.ask(
        'composer',
        baseSystem + roleLine('composer'),
        buildUserBrief(brief, docInfo),
        this._index,
      );
      if (compReply.usage) this.emit({ type: 'usage', usage: compReply.usage, index: this._index });
      await this.consume('composer', compReply.text || '', 'replace', brief);
      this._index++;

      /* ── 后续轮：上色师 ↔ 审查师 ── */
      while (this._index < this.maxIterations && !this.controller.signal.aborted) {
        const role = (this._index % 2 === 1) ? 'colorist' : 'reviewer';
        const last = this.iterations[this.iterations.length - 1];
        const info = {
          iteration: this._index,
          max: this.maxIterations,
          mode: 'append',
          report: last?.report || { ops: 0, changed: 0 },
          ascii: this.doc.activeLayer.buffer.toAscii(this.doc.palette, 32),
          tiles: last?.tiles,
          style: normalizeStyle(this.doc.style),
          hasImage: this.visionEnabled,
        };
        const content = this.critiqueContent(role, brief, info);
        const reply = await this.ask(role, baseSystem + roleLine(role), content, this._index);
        const text = reply.text || '';
        if (reply.usage) this.emit({ type: 'usage', usage: reply.usage, index: this._index });
        if (this.controller.signal.aborted) break;

        if (role === 'reviewer' && isDone(text)) {
          this.emit({ type: 'phase', phase: 'done', index: this._index, role });
          break;
        }
        await this.consume(role, text, 'append', brief);
        this._index++;
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
        frames: 1,
        changed: last?.report?.changed ?? 0,
        aborted: this.controller.signal.aborted,
        visionEnabled: this.visionEnabled,
        multi: true,
      });
    }
    return this.iterations;
  }

  /** 从角色回复中抽取脚本并执行；含语法错误重试一次。 */
  async consume(role, text, mode, brief) {
    const idx = this._index;
    const script = extractScript(text);
    if (!script) {
      this.emit({ type: 'error', message: `${ROLES[role].name}未输出可执行脚本，已跳过`, fatal: false });
      return null;
    }
    this.emit({ type: 'phase', phase: 'execute', index: idx, role });
    const exec = await this.execute(script, idx === 0 ? 'replace' : mode, `${ROLES[role].name} 第 ${idx + 1} 轮`);
    this.emit({ type: 'phase', phase: 'render', index: idx, role });

    const record = {
      index: idx,
      frame: 0,
      frameTotal: 1,
      role,
      roleName: ROLES[role].name,
      mode: idx === 0 ? 'replace' : mode,
      script,
      report: exec.report,
      thumbnail: exec.thumbnail,
      text,
      reasoning: '',
      before: exec.before,
      tiles: exec.tiles,
      render: exec.renderInfo,
    };
    this.iterations.push(record);
    this.emit({ type: 'iteration', iteration: record, total: this.iterations.length });

    if (exec.report.errors.length) {
      this.emit({ type: 'error', message: `${ROLES[role].name}脚本有 ${exec.report.errors.length} 处错误`, fatal: false });
      this.emit({ type: 'error', message: buildRepair(exec.report), fatal: false });
    }
    return record;
  }
}

function abortError() {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}
