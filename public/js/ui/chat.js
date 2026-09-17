/**
 * AI 面板：闭环对话与轮次时间线
 */

import { $, el, toast } from './dom.js';
import { Provider } from '../ai/provider.js';
import { DemoProvider } from '../ai/demo.js';
import { Agent } from '../ai/agent.js';

export class ChatPanel {
  /** @param {any} app */
  constructor(app) {
    this.app = app;
    this.log = $('#aiLog');
    this.statusEl = $('#aiStatus');
    this.brief = $('#aiBrief');
    this.btnGenerate = $('#btnGenerate');
    this.btnAbort = $('#btnAbort');
    this.agent = null;
    this.thinkingEl = null;
    this.rounds = [];
  }

  init() {
    this.btnGenerate.addEventListener('click', () => this.generate());
    this.btnAbort.addEventListener('click', () => this.agent?.abort());
    this.brief.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') this.generate();
    });
    for (const chip of document.querySelectorAll('#aiExamples .chip')) {
      chip.addEventListener('click', () => {
        this.brief.value = chip.textContent.trim();
        this.brief.focus();
      });
    }
  }

  setStatus(text, kind = '') {
    this.statusEl.textContent = text;
    this.statusEl.className = `ai-status ${kind}`;
  }

  disabled(state) {
    this.btnGenerate.disabled = state;
    this.btnAbort.disabled = !state;
    this.brief.disabled = state;
  }

  /** 清空日志（首次生成前调用） */
  resetLog() {
    this.log.replaceChildren();
    this.rounds = [];
  }

  makeProvider() {
    const cfg = this.app.config;
    if (cfg.demoMode) return new DemoProvider({ width: this.app.doc.width, height: this.app.doc.height });
    const direct = this.app.settings.directMode && this.app.settings.apiKey;
    return new Provider({
      baseUrl: direct ? this.app.settings.baseUrl : cfg.baseUrl,
      apiKey: direct ? this.app.settings.apiKey : '',
      model: this.app.settings.model || cfg.model,
      temperature: this.app.settings.temperature ?? cfg.temperature,
      thinking: this.app.settings.thinking ?? cfg.thinking ?? 'auto',
      maxTokens: this.app.settings.maxTokens ?? cfg.maxTokens ?? 2048,
      proxy: !direct,
      timeoutMs: 180000,
    });
  }

  async generate() {
    const brief = this.brief.value.trim();
    if (!brief) { toast('请先描述你想要的画面', 'warn'); this.brief.focus(); return; }

    /* 应用目标尺寸 */
    const size = Number($('#aiSize').value);
    if (Number.isFinite(size) && size !== this.app.doc.width) {
      this.app.history.begin('调整画布');
      this.app.doc.resize(size, size);
      this.app.history.commit();
      this.app.afterEdit(true);
    }

    this.resetLog();
    this.disabled(true);
    this.setStatus('正在生成…', 'busy');

    const provider = this.makeProvider();
    const isDemo = provider instanceof DemoProvider;

    this.agent = new Agent({
      provider,
      renderer: this.app.renderer,
      doc: this.app.doc,
      history: this.app.history,
      maxIterations: Number($('#aiMaxIter').value) || 6,
      visionLongEdge: this.app.config.visionLongEdge || 384,
      incremental: $('#aiIncremental').checked,
      vision: this.app.settings.vision ?? this.app.config.vision ?? 'auto',
      maxTokens: this.app.settings.maxTokens ?? this.app.config.maxTokens ?? 2048,
      onEvent: (e) => this.onEvent(e, isDemo),
    });

    this.thinkingEl = el('div', { class: 'thinking collapsed' });
    this.reasonBody = el('div', { class: 'reason-body' });
    this.reasonEl = el('div', { class: 'reason hidden' }, [
      el('div', { class: 'reason-head', text: '💭 模型思考中…' }),
      this.reasonBody,
    ]);
    this._reasonStarted = false;
    const card = el('div', { class: 'round' }, [
      el('div', { class: 'round-head' }, [
        el('span', { class: 'round-no', text: '···' }),
        el('span', { text: '模型生成中' }),
      ]),
      el('div', { class: 'round-body' }, [this.reasonEl, this.thinkingEl]),
    ]);
    this.log.prepend(card);
    this._liveCard = card;

    try {
      await this.agent.run(brief);
    } finally {
      this.disabled(false);
      this.app.refreshLayers();
      this.app.requestRender();
    }
  }

  onEvent(e, isDemo) {
    switch (e.type) {
      case 'delta':
        if (this.thinkingEl) {
          this.thinkingEl.textContent += e.text;
          this.thinkingEl.scrollTop = this.thinkingEl.scrollHeight;
        }
        break;

      case 'reasoning':
        if (this.reasonEl && this.reasonBody) {
          if (!this._reasonStarted) { this._reasonStarted = true; this.reasonEl.classList.remove('hidden'); }
          this.reasonBody.textContent += e.text;
          this.reasonBody.scrollTop = this.reasonBody.scrollHeight;
        }
        break;

      case 'usage':
        this._lastUsage = e.usage;
        break;

      case 'phase':
        this.setStatus({
          plan: `第 ${e.index + 1} 轮 · 模型规划中…`,
          execute: `第 ${e.index + 1} 轮 · 执行脚本…`,
          render: `第 ${e.index + 1} 轮 · 渲染回灌…`,
          critique: `第 ${e.index + 1} 轮 · 视觉审查中…`,
          converged: '已收敛，停止迭代',
          aborted: '已中止',
          done: '完成',
        }[e.phase] || e.phase, e.phase === 'converged' || e.phase === 'done' ? 'ok' : 'busy');
        break;

      case 'iteration':
        this.renderRound(e.iteration, e.total, isDemo);
        break;

      case 'error':
        toast(e.message, e.fatal ? 'err' : 'warn', 4200);
        if (e.fatal) this.setStatus(e.message, 'err');
        break;

      case 'done':
        this.setStatus(
          `${e.aborted ? '已中止' : '完成'} · ${e.rounds} 轮`
          + (e.visionEnabled === false && !isDemo ? ' · 纯文本审查' : '')
          + (isDemo ? ' · 演示模式' : ''),
          e.aborted ? '' : 'ok',
        );
        this._liveCard?.remove();
        this._liveCard = null;
        this.thinkingEl = null;
        this.reasonEl = null;
        this.reasonBody = null;
        this._reasonStarted = false;
        if (!e.aborted && e.rounds > 0) this.app.gallery?.autoSave?.('ai');
        break;
      default:
        break;
    }
  }

  renderRound(it, total, isDemo) {
    const report = it.report;
    const ok = report.errors.length === 0;

    const head = el('div', { class: 'round-head' }, [
      el('span', { class: 'round-no', text: `#${it.index + 1}` }),
      el('span', { class: 'round-mode', text: it.mode === 'replace' ? '整幅' : '增量' }),
      el('span', { text: `改动 ${report.changed} px · ${report.ops} 条指令 · ${report.elapsedMs}ms` }),
      el('span', { class: 'round-stat', html: `第 <b>${total}</b>/${this.app.settings.maxIterations || 6} 轮` }),
    ]);

    const thumb = el('img', { class: 'round-thumb', src: it.thumbnail, alt: `第 ${it.index + 1} 轮结果` });

    const info = el('div', { class: 'round-info' });
    info.append(el('div', { class: 'round-text', text: (it.text || '').replace(/```[\s\S]*?```/g, '').trim() || '（无说明文字）' }));

    if (!ok) {
      info.append(el('ul', { class: 'err-list' }, report.errors.map((m) => el('li', { text: m }))));
    }
    if (report.warnings?.length) {
      info.append(el('ul', { class: 'err-list warn-list' }, report.warnings.map((m) => el('li', { text: `⚠ ${m}` }))));
    }

    const actions = el('div', { class: 'round-actions' }, [
      el('button', {
        class: 'btn small ghost',
        text: '载入脚本',
        onclick: () => this.app.loadScript(it.script),
      }),
      el('button', {
        class: 'btn small ghost',
        text: '复制',
        onclick: async () => {
          try { await navigator.clipboard?.writeText(it.script); } catch { /* 无剪贴板权限 */ }
          toast('脚本已复制', 'ok', 1500);
        },
      }),
      el('button', {
        class: 'btn small ghost',
        text: '回退到此轮',
        title: '把画布恢复到这一轮开始之前的状态',
        onclick: () => {
          const current = this.app.history.capture();
          this.app.history.pushExternal(`回退到第 ${it.index + 1} 轮之前`, current);
          this.app.history.restoreTo(it.before);
          this.app.afterEdit(true);
          toast(`已回退到第 ${it.index + 1} 轮之前`, 'ok');
        },
      }),
    ]);
    info.append(actions);

    const card = el('div', { class: 'round' }, [
      head,
      el('div', { class: 'round-body' }, [thumb, info]),
    ]);

    this._liveCard?.replaceWith(card);
    this._liveCard = null;
    this.thinkingEl = null;
    this.rounds.push(it);
    if (isDemo && this.rounds.length === 1) {
      const note = el('div', { class: 'hint', text: '当前为演示模式：未配置 API Key，使用内置模板生成。配置 .env 后即可接入真实视觉模型。' });
      card.after(note);
    }
  }
}
