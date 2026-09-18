/**
 * 视觉闭环 Agent
 * ---------------------------------------------------------------
 * PLAN(可选) → SCRIPT → EXECUTE → RENDER → BACKEND → CRITIQUE →
 *   (REPAIR | PATCH | DONE)
 *
 * 每一轮：
 *   1. 模型输出 PixelScript
 *   2. 引擎执行（replace / append）
 *   3. 渲染 PNG 回灌 + 执行报告 + 区域(tile)改动热区
 *   4. 按风格走渲染后端（程序化先验 / 神经残差）
 *   5. 模型自评，继续或结束
 *
 * 与 v1.1 的差异：
 *   · 双智能体可选（plan=true 时先导演后画师）；
 *   · 风格一等公民：非 pixel 风格时把程序化/神经结果写入神经残差层；
 *   · 区域化审查：把 3×3 改动热区交给模型，支持定向局部修改；
 *   · DeepSeek Vision：图片只在 user 消息，reasoning 单独回传，视觉不可用自动降级。
 */

import { runScript, extractScript, isDone } from '../lang/compiler.js';
import {
  buildSystemPrompt, buildUserBrief, buildCritique, buildRepair,
  buildPlanPrompt, buildDetailPrompt, computeTiles,
} from './prompts.js';
import { applyProceduralPipeline, normalizeStyle } from '../core/effects.js';
import {
  resolveBackendId, requestNeural, controlMaps as buildControlMaps, bufferDataURL,
  cropBuffer, pasteBuffer, maskMapDataURL, clampRect, cropDataURL,
} from '../core/backends.js';
import { PixelBuffer } from '../core/buffer.js';
import { PixelDocument, Layer } from '../core/document.js';
import { blendFrames, blendBuffers } from '../core/tween.js';
import { morphBuffers, estimateFlow } from '../core/flow.js';
import { ease } from '../core/easing.js';

/** AI 补间的系统提示词。 */
const TWEEN_SYSTEM = `你是像素动画的补间画师（in-betweener）。
你会收到同一段动作的三个画面：起始帧 A、结束帧 B、以及两帧的机械交叉溶解参考图。
请在 A 的基础上，画出运动进度约 t 的中间帧：让角色的姿态/形变介于 A 与 B 之间，
保持外形、配色、描边风格与 A 完全一致，只改变与运动相关的部分。
只输出一个 \`\`\`pixelscript 代码块（增量指令，引擎会在 A 之上执行），不要解释。`;

/**
 * @typedef {Object} AgentEvent
 * @property {'phase'|'delta'|'reasoning'|'iteration'|'error'|'done'|'start'|'usage'|'neural'} type
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

/** 把 PNG dataURL 解码为 PixelBuffer（仅浏览器环境可用）。 */
async function dataURLToBuffer(dataURL, width, height) {
  if (typeof document === 'undefined' || typeof Image === 'undefined') return null;
  try {
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('图像解码失败'));
      im.src = dataURL;
    });
    const c = document.createElement('canvas');
    c.width = width; c.height = height;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.drawImage(img, 0, 0, width, height);
    const data = g.getImageData(0, 0, width, height).data;
    const buf = new PixelBuffer(width, height);
    buf.data.set(data);
    return buf;
  } catch {
    return null;
  }
}

export class Agent {
  /**
   * @param {{provider:any, renderer:any, doc:any, history:any,
   *          onEvent?:(e:AgentEvent)=>void,
   *          maxIterations?:number, visionLongEdge?:number,
   *          incremental?:boolean, convergence?:number,
   *          vision?:'auto'|'on'|'off', maxTokens?:number,
   *          plan?:boolean, neuralAvailable?:boolean, neuralEndpoint?:string,
   *          neuralPrompt?:string, neuralStrength?:number}} opts
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
    this.plan = opts.plan === true;
    this.neuralAvailable = opts.neuralAvailable === true;
    this.neuralEndpoint = opts.neuralEndpoint || '/api/render';
    this.neuralPrompt = opts.neuralPrompt || '';
    this.neuralStrength = opts.neuralStrength ?? 0.6;
    // DeepSeek 视觉细节级别：low / high / original / auto
    this.visionDetail = opts.visionDetail || 'high';
    // v1.6：多帧动画生成（1..64）
    this.frameCount = Math.max(1, Math.min(64, Number(opts.frameCount) || 1));
    this.animation = opts.animation || null;
    // v1.7：大画布分块回灌（超过阈值时附原分辨率裁剪图）
    this.detailCrops = opts.detailCrops !== false;
    this.cropThreshold = Number(opts.cropThreshold) || 160;
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
      style: normalizeStyle(this.doc.style),
      neuralRender: this.neuralAvailable,
    };
  }

  /** 全幅渲染：神经残差优先，失败/不可用则程序化先验（写入 neural 层，不污染程序层）。 */
  async renderFull(effectiveStyle) {
    const backend = resolveBackendId(effectiveStyle, { neuralAvailable: this.neuralAvailable });

    if (backend === 'neural') {
      const base = this.doc.compositeBase();
      const controls = { ...buildControlMaps(base, Math.max(384, this.visionLongEdge)), reference: this.referenceDataURL() };
      this.emit({ type: 'phase', phase: 'neural' });
      const out = await requestNeural({
        endpoint: this.neuralEndpoint,
        task: 'img2img',
        image: bufferDataURL(base, 0),
        controls,
        reference: this.referenceDataURL(),
        prompt: this.neuralPrompt || this.doc.title || '',
        style: effectiveStyle,
        strength: this.neuralStrength,
        seed: this.doc.seed,
        width: this.doc.width,
        height: this.doc.height,
        signal: this.controller?.signal,
      });
      if (out?.image) {
        const buf = await dataURLToBuffer(out.image, this.doc.width, this.doc.height);
        if (buf) {
          const l = this.doc.ensureNeuralLayer();
          l.buffer.data.set(buf.data);
          l.meta = { backend: 'neural', style: effectiveStyle, prompt: this.neuralPrompt, strength: this.neuralStrength };
          this.doc.invalidate();
          return { backend: 'neural', task: 'img2img', image: out.image };
        }
      }
      // 降级到程序化
      this.emit({ type: 'error', message: '神经渲染后端不可用，已降级为程序化渲染', fatal: false });
    }

    if (backend === 'raster') {
      const nl = this.doc.neuralLayer;
      if (nl) {
        const i = this.doc.layers.indexOf(nl);
        if (i >= 0) this.doc.removeLayer(i);
      }
      return { backend: 'raster' };
    }

    const base = this.doc.compositeBase().clone();
    applyProceduralPipeline(base, effectiveStyle, { lights: this.doc.lights, seed: this.doc.seed });
    const l = this.doc.ensureNeuralLayer();
    l.buffer.data.set(base.data);
    l.meta = { backend: 'procedural', style: effectiveStyle };
    this.doc.invalidate();
    return { backend: 'procedural' };
  }

  /**
   * 局部重绘：只细化 rect 区域，其余保持不变。
   * 神经后端可用时走 inpaint（带蒙版），否则用程序化先验局部细化。
   */
  async inpaintRegion(request) {
    const rect = clampRect(request, this.doc.width, this.doc.height);
    if (!rect) return null;
    const style = normalizeStyle(this.doc.style || 'pixel');
    const effStyle = style === 'pixel' ? 'painting' : style;
    const prompt = request.prompt || this.neuralPrompt || this.doc.title || '';

    if (this.neuralAvailable) {
      const base = this.doc.compositeBase();
      this.emit({ type: 'phase', phase: 'neural' });
      const out = await requestNeural({
        endpoint: this.neuralEndpoint,
        task: 'inpaint',
        image: bufferDataURL(base, 0),
        mask: maskMapDataURL(base, rect),
        reference: this.referenceDataURL(),
        prompt,
        style: effStyle,
        strength: request.strength ?? this.neuralStrength,
        seed: this.doc.seed,
        width: this.doc.width,
        height: this.doc.height,
        signal: this.controller?.signal,
      });
      if (out?.image) {
        const buf = await dataURLToBuffer(out.image, this.doc.width, this.doc.height);
        if (buf) {
          const l = this.doc.ensureNeuralLayer();
          pasteBuffer(l.buffer, buf, 0, 0, rect);
          l.meta = { backend: 'neural', task: 'inpaint', style: effStyle, prompt };
          this.doc.invalidate();
          return { backend: 'neural', task: 'inpaint', rect };
        }
      }
      this.emit({ type: 'error', message: '局部重绘：神经后端不可用，降级为程序化细部', fatal: false });
    }

    const base = this.doc.compositeBase();
    const crop = cropBuffer(base, rect);
    applyProceduralPipeline(crop, effStyle, { lights: this.doc.lights, seed: this.doc.seed });
    const l = this.doc.ensureNeuralLayer();
    pasteBuffer(l.buffer, crop, rect.x, rect.y, rect);
    l.meta = { backend: 'procedural', task: 'inpaint', style: effStyle };
    this.doc.invalidate();
    return { backend: 'procedural', task: 'inpaint', rect };
  }

  /* ── v1.8：AI 补间 ─────────────────────────────────────────── */

  /** 把动画里的某一帧还原为一个临时文档（用于在其上执行补间脚本）。 */
  frameToDoc(frame) {
    const doc = new PixelDocument(frame.width, frame.height);
    doc.layers = frame.layers.map((fl) => {
      const l = new Layer(frame.width, frame.height, fl.name);
      l.id = fl.id;
      l.kind = fl.kind || 'raster';
      l.meta = fl.meta ? { ...fl.meta } : null;
      l.visible = fl.visible !== false;
      l.opacity = fl.opacity == null ? 1 : fl.opacity;
      l.locked = Boolean(fl.locked);
      l.buffer.data.set(fl.data);
      return l;
    });
    doc.invalidate();
    return doc;
  }

  /** 让模型补出 A→B 之间进度 t 的中间帧；失败返回 null（由调用方回退交叉溶解）。 */
  async _aiIntermediateFrame(frameA, frameB, t, brief) {
    if (!this.provider?.chat) return null;
    const ca = this.frameToDoc(frameA).composite();
    const cb = this.frameToDoc(frameB).composite();
    const mix = blendBuffers(ca, cb, t);

    const urlA = bufferDataURL(ca, 256);
    const urlB = bufferDataURL(cb, 256);
    const urlMix = bufferDataURL(mix, 256);
    const messages = [
      { role: 'system', content: TWEEN_SYSTEM },
      {
        role: 'user',
        content: [
          { type: 'text', text: `进度 t ≈ ${t.toFixed(2)}（0=A，1=B）。需求：${brief || '平滑运动中间帧'}。` },
          { type: 'image_url', image_url: { url: urlA, detail: this.visionDetail } },
          { type: 'image_url', image_url: { url: urlB, detail: this.visionDetail } },
          { type: 'image_url', image_url: { url: urlMix, detail: this.visionDetail } },
        ],
      },
    ];
    let reply;
    try {
      reply = await this.provider.chat(messages, {
        stream: false,
        signal: this.controller?.signal,
        maxTokens: this.maxTokens,
      });
    } catch (err) {
      if (err?.name === 'AbortError' || err?.code === 'ABORTED') throw err;
      if (this.visionEnabled && isVisionError(err)) {
        // 视觉不可用：仅用文字描述，交给程序化交叉溶解兜底
        return null;
      }
      return null;
    }
    const script = extractScript(reply?.text || '');
    if (!script) return null;
    const scratch = this.frameToDoc(frameA);
    const report = runScript(script, scratch, { mode: 'append', deferRender: true });
    if (report.errors.length && report.changed === 0) return null;
    if (scratch.width !== frameA.width || scratch.height !== frameA.height) return null;
    return {
      width: scratch.width,
      height: scratch.height,
      duration: frameA.duration,
      easing: frameA.easing || 'linear',
      tween: true,
      t,
      layers: scratch.layers.map((l) => ({
        id: l.id,
        name: l.name,
        kind: l.kind || 'raster',
        meta: l.meta ? { ...l.meta } : null,
        visible: l.visible,
        opacity: l.opacity,
        locked: l.locked,
        data: new Uint8ClampedArray(l.buffer.data),
      })),
    };
  }

  /**
   * AI 补间：在动画的 from 帧与 to 帧之间插入 steps 张中间帧。
   * 有可用模型时逐帧请求更合理的运动姿态，失败自动回退到程序化补间。
   * @param {{from?:number,to?:number,steps?:number,easing?:string,brief?:string,useAI?:boolean,
   *          method?:'blend'|'morph'}} [opts]
   * @returns {Promise<{inserted:number, at:number, easing:string, method:string}>}
   */
  async tween(opts = {}) {
    if (!this.animation) throw new Error('缺少动画模型，无法补间');
    const ownRun = !this.running;
    if (ownRun) {
      this.running = true;
      this.controller = new AbortController();
    }
    try {
      this.animation.capture(this.doc, false);
      const len = this.animation.length;
      const from = Math.max(0, Math.min(len - 1, opts.from ?? this.animation.current));
      let to = Math.max(0, Math.min(len - 1, opts.to ?? from + 1));
      if (to === from) to = Math.min(len - 1, from + 1);
      const steps = Math.max(1, Math.min(64, opts.steps ?? 2));
      const easing = opts.easing || 'easeInOutQuad';
      const method = opts.method === 'morph' ? 'morph' : 'blend';
      const useAI = opts.useAI !== false && Boolean(this.provider?.chat);
      const frameA = this.animation.frames[from];
      const frameB = this.animation.frames[to];
      if (!frameA || !frameB) return { inserted: 0, at: from + 1, easing, method };

      // 形变补间：预计算一次光流，供所有中间帧共用
      let flow = null;
      let ca = null, cb = null;
      if (method === 'morph' && !useAI) {
        ca = this.frameToDoc(frameA).composite();
        cb = this.frameToDoc(frameB).composite();
        this.emit({ type: 'phase', phase: 'flow', index: from });
        flow = estimateFlow(ca.data, cb.data, ca.width, ca.height);
      }

      this.emit({ type: 'phase', phase: 'tween', index: from, method });
      const generated = [];
      for (let i = 1; i <= steps; i++) {
        if (this.controller.signal.aborted) break;
        const t = ease(easing, i / (steps + 1));
        let frame = null;
        if (useAI) frame = await this._aiIntermediateFrame(frameA, frameB, t, opts.brief).catch(() => null);
        if (!frame) {
          if (method === 'morph' && flow) frame = this._morphFrame(frameA, frameB, ca, cb, flow, t);
          else frame = blendFrames(frameA, frameB, t);
        }
        frame.easing = easing;
        generated.push(frame);
        this.emit({ type: 'tween', step: i, steps, t, eased: t, method });
      }
      if (generated.length) {
        this.animation.frames.splice(from + 1, 0, ...generated);
        this.animation.current = from + 1;
      }
      const result = { inserted: generated.length, at: from + 1, easing, method };
      this.emit({ type: 'tween', done: true, ...result });
      return result;
    } finally {
      if (ownRun) this.running = false;
    }
  }

  /** 用光流形变生成一帧（保持 frameA 的图层结构）。 */
  _morphFrame(frameA, frameB, ca, cb, flow, t) {
    const morphed = morphBuffers(ca, cb, t, flow);
    return {
      width: frameA.width,
      height: frameA.height,
      duration: frameA.duration,
      easing: frameA.easing || 'linear',
      tween: true,
      method: 'morph',
      t,
      layers: frameA.layers.map((l, i) => ({
        id: l.id,
        name: l.name,
        kind: l.kind || 'raster',
        meta: l.meta ? { ...l.meta } : null,
        visible: l.visible,
        opacity: l.opacity,
        locked: l.locked,
        // 形变写在首个栅格层上，其余层保持 A 的内容
        data: new Uint8ClampedArray(i === 0 ? morphed.data : (frameB.layers[i] ? frameB.layers[i].data : l.data)),
      })),
    };
  }

  /** 编排：先处理局部重绘请求，再按风格做整幅渲染。 */
  async applyRenderPipeline() {
    const requests = Array.isArray(this.doc.inpaintRequests) ? this.doc.inpaintRequests.splice(0) : [];
    const style = normalizeStyle(this.doc.style || 'pixel');
    const req = this.doc.renderRequested;
    const hasReq = Boolean(req);
    const effectiveStyle = hasReq ? normalizeStyle(req) : style;
    const wantsFull = hasReq || style !== 'pixel';
    this.doc.renderRequested = null;
    if (!wantsFull && requests.length === 0) {
      // 纯像素风格：清除可能残留的渲染残差层，避免旧结果叠加
      const stale = this.doc.neuralLayer;
      if (stale) {
        const i = this.doc.layers.indexOf(stale);
        if (i >= 0) this.doc.removeLayer(i);
        this.doc.invalidate();
      }
      return null;
    }

    let result = null;
    for (const rq of requests.slice(0, 3)) {
      const r = await this.inpaintRegion(rq).catch(() => null);
      if (r) result = r;
    }
    if (wantsFull) {
      const full = await this.renderFull(effectiveStyle).catch(() => null);
      if (full) result = full;
    }
    return result;
  }

  /* ── v2.4：选区限定生成 ───────────────────────────────────── */

  /** 把选区域外的像素恢复为 bufBefore（保证「只改选区内」）。 */
  maskOutsideRegion(bufBefore, report) {
    const r = this.region;
    if (!r) return;
    const buf = this.doc.activeLayer.buffer;
    let changed = 0;
    for (let y = 0; y < buf.height; y++) {
      for (let x = 0; x < buf.width; x++) {
        if (x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h) continue;
        const cur = buf.getPacked(x, y);
        const old = bufBefore.getPacked(x, y);
        if (cur !== old) { buf.setPacked(x, y, old); changed++; }
      }
    }
    if (report) {
      report.changed = Math.max(0, (report.changed || 0) - changed);
      report.warnings = report.warnings || [];
    }
    this.doc.invalidate();
  }

  /** 选区放大回灌图（只回灌目标区域，聚焦模型注意力）。 */
  regionDataURL() {
    const r = this.region;
    if (!r) return this.renderer.visionDataURL(this.visionLongEdge);
    try {
      const url = cropDataURL(this.doc.composite(), r, this.visionLongEdge);
      return url || this.renderer.visionDataURL(this.visionLongEdge);
    } catch { return this.renderer.visionDataURL(this.visionLongEdge); }
  }

  /** 选区预览缩略图。 */
  regionThumbnail() {
    const r = this.region;
    if (!r) return this.renderer.export(112, true).dataURL;
    try {
      return cropDataURL(this.doc.composite(), r, 112) || this.renderer.export(112, true).dataURL;
    } catch { return this.renderer.export(112, true).dataURL; }
  }

  /** 参考图（kind='reference' 图层）的 dataURL，供神经后端作为引导。 */
  referenceDataURL() {    const ref = this.doc.layers.find((l) => l.kind === 'reference');
    if (!ref) return null;
    try { return bufferDataURL(ref.buffer); } catch { return null; }
  }

  /** 多帧生成时给每帧追加的动画上下文。 */
  _frameBrief(brief, f, total) {
    if (total <= 1) return brief;
    return `${brief}\n\n这是一个 ${total} 帧的循环动画。当前绘制第 ${f + 1}/${total} 帧。`
      + '请基于上一帧，只修改与运动相关的部分，保持角色外形、构图、配色、光照与描边风格完全一致。';
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
    // v2.4：选区限定生成——只把选区内回灌/只允许改选区内像素
    this.region = opts.region ? clampRect(opts.region, this.doc.width, this.doc.height) : null;
    const total = Math.max(1, Math.min(64, this.frameCount | 0));

    this.emit({ type: 'start', brief, maxIterations: this.maxIterations, frames: total, region: this.region });

    try {
      for (let f = 0; f < total; f++) {
        if (this.controller.signal.aborted) break;

        /* 多帧：复制上一帧为当前帧，并把上一帧渲染图作为视觉引导 */
        let prevImage = null;
        if (f > 0) {
          if (!this.animation) break;
          this.animation.capture(this.doc);
          this.animation.duplicate(this.doc);
          if (this.visionEnabled) prevImage = this.renderer.visionDataURL(this.visionLongEdge);
        }
        this.emit({ type: 'frame', frame: f, frameTotal: total });

        const docInfo = this.docInfo();
        const frameBrief = this._frameBrief(brief, f, total);
        /** @type {any[]} */
        const messages = [{ role: 'system', content: buildSystemPrompt(docInfo) }];
        if (f > 0 && prevImage) {
          messages.push({
            role: 'user',
            content: [
              { type: 'text', text: frameBrief },
              { type: 'image_url', image_url: { url: prevImage, detail: this.visionDetail } },
            ],
          });
        } else {
          messages.push({ role: 'user', content: buildUserBrief(frameBrief, docInfo) });
        }

        /* ── 0. 可选：导演阶段（计划 → 画师，仅首帧） ── */
        if (this.plan && f === 0) {
          this.emit({ type: 'phase', phase: 'direct', index: 0, frame: f });
          try {
            const planReply = await this.provider.chat(
              [{ role: 'system', content: '你是图像美术导演，只做规划，不写代码。' },
                { role: 'user', content: buildPlanPrompt(brief, docInfo) }],
              { stream: false, signal: this.controller.signal, maxTokens: 512 },
            );
            const plan = String(planReply.text || '').trim();
            if (plan) messages.push({ role: 'assistant', content: `导演计划：\n${plan}` });
            messages.push({ role: 'user', content: buildDetailPrompt(plan) });
          } catch (err) {
            if (err?.name === 'AbortError' || err?.code === 'ABORTED') throw err;
            this.emit({ type: 'error', message: `导演阶段跳过：${err.message}`, fatal: false });
          }
        }

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
        const bufBefore = this.doc.activeLayer.buffer.clone();
        this.history.begin(`AI 第 ${i + 1} 轮`);
        const report = runScript(script, this.doc, { mode, seed: opts.seed, deferRender: true });
        // 选区限定：把区域外的像素恢复为执行前内容
        if (this.region) this.maskOutsideRegion(bufBefore, report);

        /* ── 3. 渲染后端（风格管线） ── */
        let renderInfo = null;
        if (!report.errors.length) {
          renderInfo = await this.applyRenderPipeline().catch(() => null);
        }
        this.history.commit();

        /* ── 4. 渲染回灌 ── */
        this.emit({ type: 'phase', phase: 'render', index: i });
        const thumbnail = this.region
          ? this.regionThumbnail()
          : this.renderer.export(112, true).dataURL;
        const vision = this.region
          ? this.regionDataURL()
          : this.renderer.visionDataURL(this.visionLongEdge);
        const ascii = report.changed > 0
          ? this.doc.activeLayer.buffer.toAscii(this.doc.palette, 32)
          : '';
        const tiles = computeTiles(bufBefore, this.doc.activeLayer.buffer, 3);

        const record = {
          index: i,
          frame: f,
          frameTotal: total,
          mode,
          script,
          report,
          thumbnail,
          text,
          reasoning: reply.reasoning || '',
          usage: reply.usage,
          before,
          tiles,
          render: renderInfo,
        };
        this.iterations.push(record);
        this.emit({ type: 'iteration', iteration: record, total: i + 1 });

        /* ── 5. 回灌 / 修复 ── */
        if (report.errors.length) {
          messages.push({ role: 'assistant', content: text });
          messages.push({ role: 'user', content: buildRepair(report) });
          i++;
          continue;
        }

        if (report.changed === 0 && i > 0 && !renderInfo) {
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
          tiles,
          style: normalizeStyle(this.doc.style),
          hasImage: this.visionEnabled,
        });
        messages.push({ role: 'assistant', content: text });
        let critiqueContent = critiqueText;
        if (this.visionEnabled) {
          const parts = [
            { type: 'text', text: critiqueText },
            { type: 'image_url', image_url: { url: vision, detail: this.visionDetail } },
          ];
          // 大画布：整图回灌会丢失细节，额外附上改动最大区域的原始分辨率裁剪图
          if (this.detailCrops && Math.max(this.doc.width, this.doc.height) > this.cropThreshold) {
            const hot = tiles.filter((t) => t.changed > 0).sort((a, b) => b.changed - a.changed).slice(0, 2);
            for (const t of hot) {
              const url = cropDataURL(this.doc.composite(), t, 192);
              if (!url) continue;
              parts.push({ type: 'text', text: `局部原分辨率放大：${t.label}（改动 ${t.changed} px）` });
              parts.push({ type: 'image_url', image_url: { url, detail: 'high' } });
            }
          }
          critiqueContent = parts;
        }
        messages.push({ role: 'user', content: critiqueContent });
        i++;
        }
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
        frames: total,
        changed: last?.report?.changed ?? 0,
        aborted: this.controller.signal.aborted,
        visionEnabled: this.visionEnabled,
      });
    }

    return this.iterations;
  }
}
