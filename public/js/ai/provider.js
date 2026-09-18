/**
 * LLM 客户端（OpenAI 兼容 + 视觉输入 + SSE 流式）
 * ---------------------------------------------------------------
 * 两种工作模式：
 *   代理模式（默认）：走本服务 /api/chat，API Key 只存在于服务端
 *   直连模式        ：浏览器直接请求 {baseUrl}/chat/completions（Key 存 sessionStorage）
 *
 * 网关适配（与鲸语 WhaleTalk 同款）：
 *   · 端点归一化：粘贴完整 `/chat/completions` 也能用；
 *   · OpenCode Go / Zen：注入 `x-opencode-session` 会话头 + 自定义 UA；
 *   · DeepSeek V4.1 Flash 等原生多模态：thinking 可控，reasoning_content 单独回传。
 */

export class ProviderError extends Error {
  /** @param {string} message @param {number} [status] @param {string} [code] */
  constructor(message, status, code) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.code = code;
  }
}

/** 去掉末尾 `/chat/completions` 与多余斜杠；保留版本段（如 /v1）。 */
export function normalizeBaseUrl(baseUrl) {
  const b = String(baseUrl || '').trim();
  if (!b) return b;
  return b.replace(/\/chat\/completions\/?$/i, '').replace(/\/+$/, '');
}

/** 是否 OpenCode Go / Zen 网关（需 x-opencode-session 会话头）。 */
export function isOpencodeEndpoint(baseUrl) {
  return normalizeBaseUrl(baseUrl).toLowerCase().includes('opencode.ai');
}

/** 是否 DeepSeek 官方端点（官方专属 thinking 参数仅此处默认下发）。 */
export function isOfficialEndpoint(baseUrl) {
  let b = normalizeBaseUrl(baseUrl).toLowerCase();
  if (b.endsWith('/beta')) b = b.slice(0, -5);
  return b === 'https://api.deepseek.com' || b === 'http://api.deepseek.com'
    || b === 'https://api.deepseek.com/v1' || b === 'http://api.deepseek.com/v1';
}

/**
 * 是否 DeepSeek Vision 系列（deepseek-flash / 旧 deepseek-v4-flash-vision-exp）。
 * 该系列原生多模态，不接收 `thinking` 字段（发了会被 400 拒绝）。
 */
export function isDeepseekFlashModel(model) {
  return /deepseek.*(flash|vision)/i.test(String(model || ''));
}

/**
 * 视觉消息只能出现在 user 角色（DeepSeek 规定，system/assistant 带图返回 400）。
 * 这里做一层防御性清洗：把非 user 消息里的图片块降级为纯文本。
 * @param {any[]} messages
 */
export function sanitizeMessages(messages) {
  return (messages || []).map((m) => {
    if (!Array.isArray(m?.content)) return m;
    if (m.role === 'user') return m;
    const text = m.content.filter((p) => p?.type === 'text').map((p) => p.text).join('\n');
    return { ...m, content: text };
  });
}

const USER_AGENT = 'PixelScribe/2.5 (+https://github.com/pythonshiyi/pixelscribe)';

function randomId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch { /* 旧环境 */ }
  return `ps-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 判断错误是否与 thinking 参数相关（未知网关可能 400 拒绝该字段）。 */
export function isThinkingRejection(status, text) {
  if (status !== 400 && status !== 422) return false;
  const t = String(text || '').toLowerCase();
  return t.includes('thinking') || t.includes('reasoning') || t.includes('unknown field')
    || t.includes('unrecognized') || t.includes('extra');
}

/** 构造 AbortError（跨环境一致，避免依赖 DOMException）。 */
function abortError(message = 'Aborted') {
  const e = new Error(message);
  e.name = 'AbortError';
  return e;
}

/** 可被 AbortSignal 打断的 sleep。 */
function sleepAbort(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const cleanup = () => { clearTimeout(t); signal?.removeEventListener?.('abort', onAbort); };
    const onAbort = () => { cleanup(); reject(abortError()); };
    const t = setTimeout(() => { cleanup(); resolve(); }, ms);
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

export class Provider {
  /**
   * @param {{baseUrl?:string, apiKey?:string, model?:string, temperature?:number,
   *          proxy?:boolean, timeoutMs?:number, thinking?:string, maxTokens?:number}} config
   */
  constructor(config = {}) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl || 'https://api.openai.com/v1');
    this.apiKey = config.apiKey || '';
    this.model = config.model || 'gpt-4o-mini';
    this.temperature = config.temperature ?? 0.6;
    this.proxy = config.proxy !== false;
    this.timeoutMs = config.timeoutMs ?? 180000;
    this.thinking = String(config.thinking || 'auto').toLowerCase();
    this.maxTokens = config.maxTokens ?? 2048;
    // DeepSeek Vision 细节级别：low（512×512，快且省）/ high / original / auto
    this.visionDetail = config.visionDetail || 'high';
    this.sessionId = randomId();
  }

  get direct() { return !this.proxy && Boolean(this.apiKey); }

  /** 直连模式下的默认请求头（含 opencode 会话头）。 */
  gatewayHeaders() {
    const h = { 'User-Agent': USER_AGENT };
    if (isOpencodeEndpoint(this.baseUrl)) {
      h['x-opencode-session'] = this.sessionId;
      h['x-opencode-client'] = 'pixelscribe';
    }
    return h;
  }

  /** 当前模型是否 DeepSeek Vision 系列。 */
  get isFlashModel() { return isDeepseekFlashModel(this.model); }

  /** 要下发的 thinking 字段（无则 null）。 */
  thinkingBody() {
    // deepseek-flash 是视觉模型，不属于推理系列：auto/disabled 一律不下发，
    // 否则真实端点会因未知字段返回 400。
    if (this.isFlashModel) {
      return this.thinking === 'enabled' ? { type: 'enabled' } : null;
    }
    if (this.thinking === 'enabled') return { type: 'enabled' };
    if (this.thinking === 'disabled') return { type: 'disabled' };
    const known = isOfficialEndpoint(this.baseUrl) || isOpencodeEndpoint(this.baseUrl);
    return known ? { type: 'disabled' } : null;
  }

  buildPayload(messages, opts, withThinking) {
    const clean = sanitizeMessages(messages);
    if (this.proxy) {
      return {
        messages: clean,
        model: this.model,
        temperature: this.temperature,
        stream: opts.stream !== false,
        max_tokens: opts.maxTokens ?? this.maxTokens,
        ...(this.apiKey ? { apiKey: this.apiKey, baseUrl: this.baseUrl } : {}),
        ...(opts.responseFormat ? { response_format: opts.responseFormat } : {}),
      };
    }
    const body = {
      model: this.model,
      messages: clean,
      temperature: this.temperature,
      stream: opts.stream !== false,
    };
    let mt = opts.maxTokens ?? this.maxTokens;
    if (withThinking) {
      const t = this.thinkingBody();
      if (t) body.thinking = t;
      // 开思考时 reasoning 也占 completion 预算，下限抬到 8192
      if (t?.type === 'enabled' && mt && mt < 8192) mt = 8192;
    }
    if (mt) body.max_tokens = mt;
    if (opts.responseFormat) body.response_format = opts.responseFormat;
    // 直连模式：要求上游在流式响应末尾带回 usage，供成本面板统计。
    if (body.stream) body.stream_options = { include_usage: true };
    return body;
  }

  /**
   * @param {any[]} messages
   * @param {{stream?:boolean, onDelta?:(s:string)=>void, onReasoning?:(s:string)=>void,
   *          signal?:AbortSignal, maxTokens?:number, responseFormat?:any}} [opts]
   * @returns {Promise<{text:string, reasoning:string, usage?:any, raw?:any}>}
   */
  async chat(messages, opts = {}) {
    const stream = opts.stream !== false;
    const url = this.proxy ? '/api/chat' : `${this.baseUrl}/chat/completions`;
    const headers = this.proxy
      ? { 'Content-Type': 'application/json' }
      : { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}`, ...this.gatewayHeaders() };

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    const onOuterAbort = () => controller.abort();
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener('abort', onOuterAbort, { once: true });
    }
    // 超时与用户取消必须区分：前者是致命错误，后者是正常中止。
    const asAbort = () => (timedOut
      ? new ProviderError(`请求超时（${Math.round(this.timeoutMs / 1000)}s）`, 0, 'TIMEOUT')
      : new ProviderError('请求已取消', 0, 'ABORTED'));

    try {
      let res;
      try {
        res = await this._postRetry(url, this.buildPayload(messages, opts, true), headers, controller.signal);
        if (!res.ok && !this.proxy) {
          // 直连模式下，网关若不认 thinking，去掉重试一次（深度兼容未知端点）
          const text = await res.clone().text().catch(() => '');
          if (isThinkingRejection(res.status, text)) {
            res = await this._postRetry(url, this.buildPayload(messages, opts, false), headers, controller.signal);
          }
        }
      } catch (err) {
        if (err.name === 'AbortError') throw asAbort();
        throw new ProviderError(`网络请求失败：${err.message}`, 0, 'NETWORK');
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let msg = text;
        try {
          const j = JSON.parse(text);
          msg = j.message || j.error?.message || j.error || text;
          if (typeof msg !== 'string') msg = JSON.stringify(msg);
        } catch { /* 非 JSON 错误体 */ }
        throw new ProviderError(`模型接口返回 ${res.status}：${String(msg).slice(0, 600)}`, res.status, 'UPSTREAM');
      }

      const asJson = (json) => {
        const m = json.choices?.[0]?.message ?? {};
        const text = typeof m.content === 'string' ? m.content : '';
        const reasoning = typeof m.reasoning_content === 'string' ? m.reasoning_content : '';
        if (opts.onReasoning && reasoning) opts.onReasoning(reasoning);
        if (opts.onDelta && text) opts.onDelta(text);
        return { text, reasoning, usage: json.usage, raw: json };
      };

      if (!stream) return asJson(await res.json());

      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('text/event-stream')) return asJson(await res.json());
      if (!res.body) throw new ProviderError('响应没有可读正文', 0, 'STREAM');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let text = '';
      let reasoning = '';
      let usage = null;
      let dataLines = [];

      const handleData = (data) => {
        const payload = data.trim();
        if (!payload || payload === '[DONE]') return;
        let json;
        try { json = JSON.parse(payload); } catch { return; }
        if (json.error) {
          const em = typeof json.error === 'string' ? json.error : (json.error.message || JSON.stringify(json.error));
          throw new ProviderError(`模型接口错误：${String(em).slice(0, 600)}`, 0, 'UPSTREAM');
        }
        if (json.usage) usage = json.usage;
        const delta = json.choices?.[0]?.delta ?? json.choices?.[0]?.message;
        if (!delta) return;
        const rc = delta.reasoning_content;
        if (typeof rc === 'string' && rc) {
          reasoning += rc;
          if (opts.onReasoning) opts.onReasoning(rc);
        }
        const piece = typeof delta.content === 'string'
          ? delta.content
          : Array.isArray(delta.content)
            ? delta.content.map((p) => p?.text ?? '').join('')
            : '';
        if (piece) {
          text += piece;
          if (opts.onDelta) opts.onDelta(piece);
        }
      };
      // SSE 规范：多条 `data:` 行属于同一事件，用空行分隔并拼成多行数据。
      const flushEvent = () => {
        if (!dataLines.length) return;
        const joined = dataLines.join('\n');
        dataLines = [];
        handleData(joined);
      };

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).replace(/\r$/, '');
            buffer = buffer.slice(nl + 1);
            if (line === '') { flushEvent(); continue; }
            if (line.startsWith(':')) continue;
            if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
          }
        }
        buffer += decoder.decode(); // 冲掉解码器中残留的多字节字符
        if (buffer) {
          for (const line of buffer.split('\n')) {
            const l = line.replace(/\r$/, '');
            if (l.startsWith('data:')) dataLines.push(l.slice(5).replace(/^ /, ''));
          }
        }
        flushEvent();
      } catch (err) {
        if (err instanceof ProviderError) throw err;
        if (err.name === 'AbortError') throw asAbort();
        throw new ProviderError(`读取流失败：${err.message}`, 0, 'STREAM');
      }

      return { text, reasoning, usage };
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener?.('abort', onOuterAbort);
    }
  }

  /** 单次 POST，带 429/5xx/网络错误的指数退避重试。 */
  async _postRetry(url, payload, headers, signal) {
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (signal?.aborted) throw abortError();
      try {
        const res = await this._post(url, payload, headers, signal);
        if (res.status === 429 || res.status >= 500) {
          if (attempt < 2) { await sleepAbort(this._retryDelay(res, attempt), signal); continue; }
        }
        return res;
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        lastErr = err;
        if (attempt < 2) { await sleepAbort(Math.min(8000, 500 * 2 ** attempt), signal); continue; }
        throw err;
      }
    }
    throw lastErr || new Error('请求重试耗尽');
  }

  _retryDelay(res, attempt) {
    const ra = Number(res.headers.get('retry-after'));
    if (Number.isFinite(ra) && ra > 0) return Math.min(30000, ra * 1000);
    return Math.min(8000, 500 * 2 ** attempt);
  }

  async _post(url, payload, headers, signal) {
    return fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal,
    });
  }
}
