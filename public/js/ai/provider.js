/**
 * LLM 客户端（OpenAI 兼容 + 视觉输入 + SSE 流式）
 * ---------------------------------------------------------------
 * 两种工作模式：
 *   代理模式（默认）：走本服务 /api/chat，API Key 只存在于服务端
 *   直连模式        ：浏览器直接请求 {baseUrl}/chat/completions（Key 存 sessionStorage）
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

export class Provider {
  /**
   * @param {{baseUrl?:string, apiKey?:string, model?:string, temperature?:number,
   *          proxy?:boolean, timeoutMs?:number}} config
   */
  constructor(config = {}) {
    this.baseUrl = (config.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.apiKey = config.apiKey || '';
    this.model = config.model || 'gpt-4o-mini';
    this.temperature = config.temperature ?? 0.6;
    this.proxy = config.proxy !== false;
    this.timeoutMs = config.timeoutMs ?? 180000;
  }

  get direct() { return !this.proxy && Boolean(this.apiKey); }

  /**
   * @param {any[]} messages
   * @param {{stream?:boolean, onDelta?:(s:string)=>void, signal?:AbortSignal, maxTokens?:number}} [opts]
   * @returns {Promise<{text:string, usage?:any, raw?:any}>}
   */
  async chat(messages, opts = {}) {
    const stream = opts.stream !== false;
    const url = this.proxy ? '/api/chat' : `${this.baseUrl}/chat/completions`;
    const payload = this.proxy
      ? {
          messages,
          model: this.model,
          temperature: this.temperature,
          stream,
          ...(this.apiKey ? { apiKey: this.apiKey, baseUrl: this.baseUrl } : {}),
          ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
        }
      : {
          model: this.model,
          messages,
          temperature: this.temperature,
          stream,
          ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
        };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: this.proxy
          ? { 'Content-Type': 'application/json' }
          : { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') throw new ProviderError('请求已取消', 0, 'ABORTED');
      throw new ProviderError(`网络请求失败：${err.message}`, 0, 'NETWORK');
    }

    if (!res.ok) {
      clearTimeout(timer);
      const text = await res.text().catch(() => '');
      let msg = text;
      try {
        const j = JSON.parse(text);
        msg = j.message || j.error?.message || j.error || text;
        if (typeof msg !== 'string') msg = JSON.stringify(msg);
      } catch { /* 非 JSON 错误体 */ }
      throw new ProviderError(`模型接口返回 ${res.status}：${String(msg).slice(0, 600)}`, res.status, 'UPSTREAM');
    }

    if (!stream) {
      const json = await res.json();
      clearTimeout(timer);
      const text = json.choices?.[0]?.message?.content ?? '';
      return { text, usage: json.usage, raw: json };
    }

    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('text/event-stream')) {
      const json = await res.json();
      clearTimeout(timer);
      const text = json.choices?.[0]?.message?.content ?? '';
      if (opts.onDelta && text) opts.onDelta(text);
      return { text, usage: json.usage, raw: json };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let usage = null;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const raw = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!raw || raw.startsWith(':')) continue;
          if (!raw.startsWith('data:')) continue;
          const data = raw.slice(5).trim();
          if (data === '[DONE]') continue;
          let json;
          try { json = JSON.parse(data); } catch { continue; }
          if (json.usage) usage = json.usage;
          const delta = json.choices?.[0]?.delta ?? json.choices?.[0]?.message;
          const piece = typeof delta?.content === 'string'
            ? delta.content
            : Array.isArray(delta?.content)
              ? delta.content.map((p) => p?.text ?? '').join('')
              : '';
          if (piece) {
            text += piece;
            if (opts.onDelta) opts.onDelta(piece);
          }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') throw new ProviderError(`读取流失败：${err.message}`, 0, 'STREAM');
    } finally {
      clearTimeout(timer);
    }

    return { text, usage };
  }
}
