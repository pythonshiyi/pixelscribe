#!/usr/bin/env node
/**
 * 像素画笔 PixelScribe · 服务端
 * ---------------------------------------------------------------
 * 零 npm 依赖，仅使用 Node 20+ 内置能力。
 *
 *   GET  /               静态托管 public/
 *   GET  /api/config     前端能力探测（不含任何密钥）
 *   POST /api/chat       反向代理到 OpenAI 兼容端点，SSE 透传
 *
 * 网关适配（与鲸语 WhaleTalk 同款）：
 *   · 端点归一化：粘贴完整 `/chat/completions` 端点也能用；
 *   · OpenCode Go / Zen：自动注入 `x-opencode-session` 会话头 + 自定义 UA；
 *   · DeepSeek V4.1 Flash 等原生多模态模型：thinking 开关可控（默认关）。
 *
 * 安全：API Key 只存在于服务端环境变量，永不下发浏览器。
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const VERSION = '2.5.0';

/* ───────────────────────── .env 加载 ───────────────────────── */

/**
 * 加载 .env。Node ≥20.12 有内置 `process.loadEnvFile`；更早的 20.x 没有，
 * 这里给一个最小解析器兜底，避免「明明写了 .env 却进演示模式」的静默失败。
 */
function loadDotEnv(file) {
  try {
    if (typeof process.loadEnvFile === 'function') {
      process.loadEnvFile(file);
      return;
    }
    const text = fs.readFileSync(file, 'utf8');
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (!(m[1] in process.env)) process.env[m[1]] = v;
    }
  } catch {
    /* 无 .env 时使用默认值 / 环境变量 */
  }
}

loadDotEnv(path.join(__dirname, '.env'));

/* ───────────────────────── 网关适配 ───────────────────────── */

/** 去掉末尾 `/chat/completions` 与多余斜杠；保留版本段（如 /v1）。 */
function normalizeBaseUrl(baseUrl) {
  const b = String(baseUrl || '').trim();
  if (!b) return b;
  return b.replace(/\/chat\/completions\/?$/i, '').replace(/\/+$/, '');
}

/** 是否 OpenCode Go / Zen 网关（需 x-opencode-session 会话头）。 */
function isOpencodeEndpoint(baseUrl) {
  return normalizeBaseUrl(baseUrl).toLowerCase().includes('opencode.ai');
}

/** 是否 DeepSeek 官方端点（官方专属 thinking 参数仅此处默认下发）。 */
function isOfficialEndpoint(baseUrl) {
  let b = normalizeBaseUrl(baseUrl).toLowerCase();
  if (b.endsWith('/beta')) b = b.slice(0, -5);
  return b === 'https://api.deepseek.com' || b === 'http://api.deepseek.com'
    || b === 'https://api.deepseek.com/v1' || b === 'http://api.deepseek.com/v1';
}

/**
 * 是否 DeepSeek Vision 系列（deepseek-flash / 旧 deepseek-v4-flash-vision-exp）。
 * 原生多模态，但接收 `thinking` 字段会返回 400。
 */
function isDeepseekFlashModel(model) {
  return /deepseek.*(flash|vision)/i.test(String(model || ''));
}

/** 视觉消息只能出现在 user 角色（DeepSeek 规定）——防御性清洗。 */
function sanitizeMessages(messages) {
  return (messages || []).map((m) => {
    if (!Array.isArray(m?.content) || m.role === 'user') return m;
    const text = m.content.filter((p) => p?.type === 'text').map((p) => p.text).join('\n');
    return { ...m, content: text };
  });
}

/**
 * 复用鲸语 WhaleTalk 的网关配置（可选）。
 * WhaleTalk 的 `config.json` 里 `base_url` / `model` 是明文，可复用；
 * `api_key` 经 Windows DPAPI 加密，Node 端无法解密——只在看起来是明文
 * `sk-...` 时才采用，否则仍需在 `.env` 里填 `PX_API_KEY`。
 */
function readGatewayConfig() {
  const p = process.env.PX_GATEWAY_CONFIG;
  if (!p) return {};
  try {
    const j = JSON.parse(fs.readFileSync(path.resolve(p), 'utf8'));
    const key = typeof j.api_key === 'string' && /^sk-[A-Za-z0-9_-]{8,}$/.test(j.api_key)
      ? j.api_key : '';
    return { baseUrl: j.base_url || j.baseUrl || '', model: j.model || '', apiKey: key };
  } catch {
    return {};
  }
}

const GW = readGatewayConfig();

const CFG = {
  port: Number(process.env.PX_PORT || 5173),
  // 默认只监听本机回环，避免局域网/公网直接耗尽 API Key 或读写作品库。
  host: String(process.env.PX_HOST || '127.0.0.1').trim(),
  // 可选访问令牌：设置后，非回环来源的 API 请求需携带 x-px-token / Bearer。
  authToken: String(process.env.PX_AUTH_TOKEN || '').trim(),
  // 每个来源 IP 每分钟允许的 LLM/渲染请求数（0 表示不限流）。
  rateLimit: Math.max(0, Number(process.env.PX_RATE_LIMIT || 60)),
  // 是否请求上游在流式响应中返回 usage（成本统计用；某些网关不认该字段会自动去掉）。
  streamUsage: String(process.env.PX_STREAM_USAGE || 'on').toLowerCase() !== 'off',
  baseUrl: normalizeBaseUrl(process.env.PX_BASE_URL || GW.baseUrl || 'https://api.deepseek.com'),
  apiKey: process.env.PX_API_KEY || GW.apiKey || '',
  model: process.env.PX_MODEL || GW.model || 'deepseek-flash',
  temperature: Number(process.env.PX_TEMPERATURE || 0.6),
  maxIterations: Number(process.env.PX_MAX_ITERATIONS || 6),
  visionLongEdge: Number(process.env.PX_VISION_LONG_EDGE || 384),
  timeoutMs: Number(process.env.PX_TIMEOUT_MS || 180000),
  maxTokens: Number(process.env.PX_MAX_TOKENS || 2048),
  // auto：已知网关（opencode / 官方）→ 关闭思考（快、省、确定性好）；其它网关不下发；
  // disabled / enabled：强制。
  thinking: String(process.env.PX_THINKING || 'auto').toLowerCase(),
  vision: String(process.env.PX_VISION || 'auto').toLowerCase(),
  // DeepSeek Vision 细节级别：low / high / original / auto
  visionDetail: String(process.env.PX_VISION_DETAIL || 'high').toLowerCase(),
  // 可选神经渲染后端（img2img / ControlNet）。留空则只用程序化先验。
  renderUrl: String(process.env.PX_RENDER_URL || '').trim(),
  renderKey: String(process.env.PX_RENDER_KEY || '').trim(),
  // 多后端路由：缺省回退到 renderUrl
  inpaintUrl: String(process.env.PX_INPAINT_URL || '').trim(),
  upscaleUrl: String(process.env.PX_UPSCALE_URL || '').trim(),
};

/** 按任务选择神经后端 URL（缺省回退到通用 renderUrl）。 */
function renderUrlForTask(task) {
  if (task === 'inpaint') return CFG.inpaintUrl || CFG.renderUrl;
  if (task === 'upscale') return CFG.upscaleUrl || CFG.renderUrl;
  return CFG.renderUrl;
}

/* ───────────────────────── 请求防护 ───────────────────────── */

/** 容错解码：非法百分号转义返回 null 而不是抛 URIError 终止进程。 */
function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return null; }
}

/** 客户端 IP（优先反代头）。 */
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

/** 是否本机回环来源（本机使用免令牌）。 */
function isLoopback(req) {
  const ip = clientIp(req);
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === 'localhost';
}

/** 令牌校验（未配置令牌则恒通过）。 */
function hasAuth(req) {
  if (!CFG.authToken) return true;
  const raw = req.headers['x-px-token'] || req.headers['authorization'] || '';
  const token = typeof raw === 'string' ? raw.replace(/^Bearer\s+/i, '').trim() : '';
  return token === CFG.authToken;
}

const rlBuckets = new Map();
/** 简单固定窗口限流；超限返回 true。 */
function rateLimited(req, cost = 1) {
  if (CFG.rateLimit <= 0) return false;
  const ip = clientIp(req);
  const now = Date.now();
  let e = rlBuckets.get(ip);
  if (!e || now > e.reset) { e = { n: 0, reset: now + 60000 }; rlBuckets.set(ip, e); }
  e.n += cost;
  if (rlBuckets.size > 4096) rlBuckets.clear(); // 防内存膨胀
  return e.n > CFG.rateLimit;
}

/** 同源校验（缓解 CSRF）：带 Origin 的跨站请求拒绝。 */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // 同源 fetch 可能不带 Origin
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

// 不透明、按进程稳定：同一会话路由到同一后端，提升缓存命中（官方文档要求）。
const OPENCODE_SESSION = crypto.randomUUID();
const USER_AGENT = 'PixelScribe/2.5 (+https://github.com/pythonshiyi/pixelscribe)';

/** 按端点返回需注入的默认请求头（仅 opencode.ai 需要会话头）。 */
function gatewayHeaders(baseUrl) {
  const h = { 'User-Agent': USER_AGENT };
  if (isOpencodeEndpoint(baseUrl)) {
    h['x-opencode-session'] = OPENCODE_SESSION;
    h['x-opencode-client'] = 'pixelscribe';
  }
  return h;
}

/** 解析 thinking 策略 → 要下发的 extra body 字段（无则 null）。 */
function thinkingBody(baseUrl, mode, model) {
  // DeepSeek Vision 系列不接受 thinking 字段
  if (isDeepseekFlashModel(model)) {
    return mode === 'enabled' ? { type: 'enabled' } : null;
  }
  const known = isOfficialEndpoint(baseUrl) || isOpencodeEndpoint(baseUrl);
  if (mode === 'enabled') return { type: 'enabled' };
  if (mode === 'disabled') return { type: 'disabled' };
  return known ? { type: 'disabled' } : null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.pxs': 'text/plain; charset=utf-8',
};

// 神经渲染请求可能同时携带底图 + 4 张控制图 + 蒙版 + 参考图，故上限放宽
const MAX_BODY = 32 * 1024 * 1024;

/* ───────────────────────── 作品库（专门的文件空间） ───────────────────────── */
// 生成物自动落盘到 <repo>/workspace/gallery，便于集中查看/管理；路径可用 PX_WORKSPACE 覆盖。
const WORKSPACE_DIR = path.resolve(process.env.PX_WORKSPACE || path.join(__dirname, 'workspace'));
const GALLERY_DIR = path.join(WORKSPACE_DIR, 'gallery');
const GALLERY_MIME = { '.png': 'image/png', '.pxs': 'text/plain; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const GALLERY_MAX_BYTES = 32 * 1024 * 1024;

try { fs.mkdirSync(GALLERY_DIR, { recursive: true }); } catch { /* 只读环境 */ }

/** 只保留安全文件名（防路径穿越）。 */
function safeGalleryName(name) {
  const base = path.basename(String(name || '')).replace(/[^\w.\-]+/g, '_').slice(0, 80);
  return base && base !== '.' && base !== '..' ? base : '';
}

async function listGallery() {
  const items = [];
  const entries = await fsp.readdir(GALLERY_DIR, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!e.isFile()) continue;
    const ext = path.extname(e.name).toLowerCase();
    if (!(ext in GALLERY_MIME)) continue;
    const st = await fsp.stat(path.join(GALLERY_DIR, e.name)).catch(() => null);
    if (!st) continue;
    items.push({
      name: e.name, size: st.size, mtime: st.mtimeMs,
      kind: ext === '.pxs' ? 'script' : 'image',
      url: `/api/gallery/file/${encodeURIComponent(e.name)}`,
    });
  }
  items.sort((a, b) => b.mtime - a.mtime);
  return items;
}

async function handleGallerySave(req, res) {
  let payload;
  try { payload = JSON.parse(await readBody(req)); }
  catch { return sendJSON(res, 400, { error: 'BAD_JSON' }); }
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const kind = payload.kind === 'pxs' ? 'pxs' : 'png';
  const base = safeGalleryName(payload.name) || `pixelscribe_${stamp}`;
  const name = base.toLowerCase().endsWith(`.${kind}`) ? base : `${base}.${kind}`;

  let data;
  if (kind === 'png') {
    const m = /^data:image\/png;base64,(.+)$/s.exec(String(payload.dataURL || ''));
    if (!m) return sendJSON(res, 400, { error: 'BAD_DATAURL', message: '需要 data:image/png;base64,... 的 PNG dataURL' });
    data = Buffer.from(m[1], 'base64');
    if (data.length > GALLERY_MAX_BYTES) return sendJSON(res, 413, { error: 'TOO_LARGE' });
  } else {
    data = String(payload.text ?? '');
    if (Buffer.byteLength(data, 'utf8') > GALLERY_MAX_BYTES) return sendJSON(res, 413, { error: 'TOO_LARGE' });
  }

  // 用 wx 独占创建，绝不静默覆盖同名作品；冲突则追加 _1/_2…
  for (let i = 0; i < 1000; i++) {
    const finalName = i === 0 ? name : name.replace(/(\.[^.]+)$/, `_${i}$1`);
    const opts = kind === 'png' ? { flag: 'wx' } : { flag: 'wx', encoding: 'utf8' };
    try {
      await fsp.writeFile(path.join(GALLERY_DIR, finalName), data, opts);
      return sendJSON(res, 200, { ok: true, name: finalName, url: `/api/gallery/file/${encodeURIComponent(finalName)}` });
    } catch (e) {
      if (e.code === 'EEXIST') continue;
      return sendJSON(res, 500, { error: 'WRITE_FAILED', message: e.message });
    }
  }
  return sendJSON(res, 409, { error: 'NAME_CONFLICT', message: '同名文件过多，请更换名称' });
}

/** 对外展示的作品库路径（仅在仓库内时给相对路径，否则给通用描述，绝不泄露绝对路径）。 */
function galleryDisplayDir() {
  const rel = path.relative(__dirname, GALLERY_DIR);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return '外部工作目录';
  return rel;
}

/** 在系统文件管理器中打开作品库目录。 */
function revealWorkspace(res) {
  try {
    if (process.platform === 'win32') spawn('explorer', [GALLERY_DIR], { detached: true, stdio: 'ignore' }).unref();
    else if (process.platform === 'darwin') spawn('open', [GALLERY_DIR], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [GALLERY_DIR], { detached: true, stdio: 'ignore' }).unref();
    return sendJSON(res, 200, { ok: true, dir: galleryDisplayDir() });
  } catch (e) {
    return sendJSON(res, 500, { error: 'REVEAL_FAILED', message: e.message });
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function sendJSON(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('PAYLOAD_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 静态文件：解析后必须仍位于 PUBLIC_DIR 内，防路径穿越 */
async function serveStatic(req, res, urlPath) {
  let rel = safeDecode(urlPath.split('?')[0]);
  if (rel === null) return send(res, 400, 'Bad Request');
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel.includes('\0')) return send(res, 400, 'Bad Request');

  const target = path.resolve(PUBLIC_DIR, '.' + rel);
  const rootWithSep = PUBLIC_DIR.endsWith(path.sep) ? PUBLIC_DIR : PUBLIC_DIR + path.sep;
  if (target !== PUBLIC_DIR && !target.startsWith(rootWithSep)) {
    return send(res, 403, 'Forbidden');
  }

  try {
    const stat = await fsp.stat(target);
    if (stat.isDirectory()) return serveStatic(req, res, rel.replace(/\/?$/, '/') + 'index.html');
    const ext = path.extname(target).toLowerCase();
    const data = await fsp.readFile(target);
    send(res, 200, data, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': ext === '.html' ? 'no-store' : 'no-cache',
    });
  } catch {
    send(res, 404, 'Not Found');
  }
}

function buildUpstreamBody(payload, baseUrl, { withThinking, withStreamUsage = CFG.streamUsage }) {
  const model = payload.model || CFG.model;
  const body = {
    model,
    messages: sanitizeMessages(payload.messages || []),
    temperature: payload.temperature ?? CFG.temperature,
    stream: payload.stream !== false,
  };
  let maxTokens = payload.max_tokens ?? CFG.maxTokens;
  let thinking = null;
  if (withThinking) thinking = thinkingBody(baseUrl, CFG.thinking, model);
  if (thinking) body.thinking = thinking;
  // 开思考时 reasoning 也占 completion 预算，下限抬到 8192，避免 content 被挤空
  if (thinking?.type === 'enabled' && maxTokens && maxTokens < 8192) maxTokens = 8192;
  if (maxTokens) body.max_tokens = maxTokens;
  if (payload.top_p != null) body.top_p = payload.top_p;
  if (payload.response_format) body.response_format = payload.response_format;
  // 让上游在流式响应的最后一个 chunk 带 usage（否则成本面板永远统计不到）。
  if (body.stream && withStreamUsage) body.stream_options = { include_usage: true };
  return body;
}

/**
 * 调用上游并做字段级降级重试：部分网关不认 thinking / stream_options，
 * 命中相关 400 时自动去掉对应字段重试（最多 3 次）。
 */
async function callUpstreamResilient(baseUrl, key, payload, signal) {
  let withThinking = true;
  let withStreamUsage = CFG.streamUsage;
  let last = { res: null, errorText: '' };
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await callUpstream(baseUrl, key, buildUpstreamBody(payload, baseUrl, { withThinking, withStreamUsage }), signal);
    if (res.ok) return { res, errorText: '' };
    const text = await res.text().catch(() => '');
    last = { res, errorText: text };
    const lower = text.toLowerCase();
    let changed = false;
    if (withThinking && isThinkingRejection(res.status, text)) { withThinking = false; changed = true; }
    if (withStreamUsage && (lower.includes('stream_options') || lower.includes('include_usage'))) { withStreamUsage = false; changed = true; }
    if (!changed) break;
  }
  return last;
}

/** 调用上游一次，返回 fetch Response（非流式/流式都走这里）。 */
async function callUpstream(baseUrl, apiKey, body, signal) {
  const headers = { 'Content-Type': 'application/json', ...gatewayHeaders(baseUrl) };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });
}

/**
 * 判断错误是否与 thinking 参数相关（未知网关可能 400 拒绝该字段）。
 * 命中则去掉 thinking 重试一次。
 */
function isThinkingRejection(status, text) {
  if (status !== 400 && status !== 422) return false;
  const t = String(text || '').toLowerCase();
  return t.includes('thinking') || t.includes('reasoning') || t.includes('unknown field')
    || t.includes('unrecognized') || t.includes('extra');
}

/**
 * /api/chat
 * 请求体：{ messages, model?, temperature?, stream?, baseUrl?, apiKey?, max_tokens? }
 * 若请求自带 apiKey（前端直连模式），优先使用之。
 */
async function handleChat(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (err) {
    return sendJSON(res, err.message === 'PAYLOAD_TOO_LARGE' ? 413 : 400, {
      error: err.message === 'PAYLOAD_TOO_LARGE' ? '请求体过大（上限 32MB）' : '请求体不是合法 JSON',
    });
  }

  if (rateLimited(req)) {
    return sendJSON(res, 429, { error: 'RATE_LIMITED', message: '请求过于频繁，请稍后再试。' });
  }

  const key = payload.apiKey || CFG.apiKey;
  // 防 SSRF / 密钥外泄：只有在请求自带 Key（前端直连）时才允许覆盖端点；
  // 使用服务端 Key 时端点始终锁定为服务端配置，绝不把服务端 Key 发往调用方指定的主机。
  const override = payload.baseUrl ? normalizeBaseUrl(payload.baseUrl) : '';
  const baseUrl = (payload.apiKey && override) ? override : CFG.baseUrl;
  if (!key) {
    return sendJSON(res, 400, {
      error: 'NO_API_KEY',
      message: '未配置 API Key。请在 .env 设置 PX_API_KEY，或在界面中启用「前端直连」并填入 Key。',
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CFG.timeoutMs);
  req.on('close', () => controller.abort());

  let result;
  try {
    result = await callUpstreamResilient(baseUrl, key, payload, controller.signal);
  } catch (err) {
    clearTimeout(timer);
    return sendJSON(res, 502, {
      error: 'UPSTREAM_UNREACHABLE',
      message: `无法连接 ${baseUrl}/chat/completions：${err.message}`,
    });
  }

  const upstream = result?.res;
  if (!upstream || !upstream.ok) {
    clearTimeout(timer);
    const status = upstream?.status || 502;
    return sendJSON(res, status, { error: 'UPSTREAM_ERROR', status, message: String(result?.errorText || '').slice(0, 4000) });
  }

  const stream = payload.stream !== false;
  if (!stream) {
    const text = await upstream.text();
    clearTimeout(timer);
    return send(res, 200, text, { 'Content-Type': 'application/json; charset=utf-8' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } catch {
    /* 客户端断开 */
  } finally {
    clearTimeout(timer);
    res.end();
  }
}

/**
 * /api/render —— 可选神经渲染后端代理（img2img / ControlNet）。
 * 未配置 PX_RENDER_URL 时返回 501，前端自动降级为程序化渲染。
 * 请求体：{ image, controls?, prompt?, style?, strength?, seed?, width?, height? }
 */
async function handleRender(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (err) {
    return sendJSON(res, err.message === 'PAYLOAD_TOO_LARGE' ? 413 : 400, { error: 'BAD_REQUEST' });
  }
  if (rateLimited(req)) {
    return sendJSON(res, 429, { error: 'RATE_LIMITED', message: '请求过于频繁，请稍后再试。' });
  }
  const task = ['img2img', 'inpaint', 'upscale'].includes(payload.task) ? payload.task : 'img2img';
  const url = renderUrlForTask(task);
  if (!url) {
    return sendJSON(res, 501, {
      error: 'NO_RENDER_BACKEND',
      message: `未配置 ${task === 'inpaint' ? 'PX_INPAINT_URL / ' : task === 'upscale' ? 'PX_UPSCALE_URL / ' : ''}PX_RENDER_URL，神经渲染不可用；已使用程序化渲染管线。`,
    });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CFG.timeoutMs);
  req.on('close', () => controller.abort());
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (CFG.renderKey) headers.Authorization = `Bearer ${CFG.renderKey}`;
    const upstream = await fetch(url, {
      method: 'POST', headers, body: JSON.stringify(payload), signal: controller.signal,
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    const ct = upstream.headers.get('content-type') || 'application/json; charset=utf-8';
    send(res, upstream.status, buf, { 'Content-Type': ct });
  } catch (err) {
    sendJSON(res, 502, {
      error: 'RENDER_UNREACHABLE',
      message: `无法连接渲染后端 ${url}：${err.message}`,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function handleRequest(req, res) {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return send(res, 400, 'Bad Request');
  }

  const isApi = url.pathname.startsWith('/api/');
  // 跨站写请求拒绝（缓解 CSRF）：带 Origin 且非同源时直接 403。
  if (isApi && req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) {
    return sendJSON(res, 403, { error: 'BAD_ORIGIN', message: '跨站请求被拒绝。' });
  }
  // 非回环来源访问 API 需要令牌（本机使用不受影响）。
  if (isApi && url.pathname !== '/api/config' && !isLoopback(req) && !hasAuth(req)) {
    return sendJSON(res, 401, { error: 'UNAUTHORIZED', message: '需要有效的 x-px-token 访问令牌。' });
  }

  if (url.pathname === '/api/config') {
    if (req.method !== 'GET') return sendJSON(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    return sendJSON(res, 200, {
      keyConfigured: Boolean(CFG.apiKey),
      baseUrl: CFG.baseUrl,
      model: CFG.model,
      temperature: CFG.temperature,
      maxIterations: CFG.maxIterations,
      visionLongEdge: CFG.visionLongEdge,
      visionDetail: CFG.visionDetail,
      maxTokens: CFG.maxTokens,
      thinking: CFG.thinking,
      vision: CFG.vision,
      neuralRender: Boolean(CFG.renderUrl || CFG.inpaintUrl || CFG.upscaleUrl),
      renderUrlConfigured: Boolean(CFG.renderUrl),
      renderTasks: {
        img2img: Boolean(CFG.renderUrl),
        inpaint: Boolean(CFG.inpaintUrl || CFG.renderUrl),
        upscale: Boolean(CFG.upscaleUrl || CFG.renderUrl),
      },
      provider: isOpencodeEndpoint(CFG.baseUrl) ? 'opencode' : (isOfficialEndpoint(CFG.baseUrl) ? 'deepseek' : 'openai-compatible'),
      gateway: { opencode: isOpencodeEndpoint(CFG.baseUrl), official: isOfficialEndpoint(CFG.baseUrl) },
      // 不返回服务端绝对路径（信息泄露）；仅返回相对展示路径。
      galleryDir: galleryDisplayDir(),
      authRequired: Boolean(CFG.authToken),
      demoMode: !CFG.apiKey,
      version: VERSION,
    });
  }

  if (url.pathname === '/api/chat') {
    if (req.method !== 'POST') return sendJSON(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    return handleChat(req, res);
  }

  if (url.pathname === '/api/render') {
    if (req.method !== 'POST') return sendJSON(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    return handleRender(req, res);
  }

  /* ── 作品库（文件空间） ── */
  if (url.pathname === '/api/gallery') {
    if (req.method !== 'GET') return sendJSON(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    const items = await listGallery();
    return sendJSON(res, 200, { dir: galleryDisplayDir(), items });
  }

  if (url.pathname.startsWith('/api/gallery/file/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJSON(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    const raw = safeDecode(url.pathname.slice('/api/gallery/file/'.length));
    if (raw === null) return send(res, 400, 'Bad Request');
    const name = safeGalleryName(raw);
    const ext = path.extname(name).toLowerCase();
    if (!name || !(ext in GALLERY_MIME)) return send(res, 404, 'Not Found');
    try {
      const data = await fsp.readFile(path.join(GALLERY_DIR, name));
      return send(res, 200, data, {
        'Content-Type': GALLERY_MIME[ext], 'Content-Length': data.length, 'Cache-Control': 'no-cache',
      });
    } catch {
      return send(res, 404, 'Not Found');
    }
  }

  if (url.pathname === '/api/gallery/save') {
    if (req.method !== 'POST') return sendJSON(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    return handleGallerySave(req, res);
  }

  if (url.pathname === '/api/gallery/reveal') {
    if (req.method !== 'POST') return sendJSON(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    return revealWorkspace(res);
  }

  if (url.pathname === '/api/gallery/delete') {
    if (req.method !== 'POST') return sendJSON(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    let payload;
    try { payload = JSON.parse(await readBody(req)); } catch { return sendJSON(res, 400, { error: 'BAD_JSON' }); }
    const name = safeGalleryName(payload.name);
    if (!name) return sendJSON(res, 400, { error: 'BAD_NAME' });
    try { await fsp.unlink(path.join(GALLERY_DIR, name)); }
    catch (e) { return sendJSON(res, 404, { error: 'NOT_FOUND', message: e.message }); }
    return sendJSON(res, 200, { ok: true });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'Method Not Allowed');
  }

  return serveStatic(req, res, url.pathname);
}

const server = http.createServer((req, res) => {
  Promise.resolve(handleRequest(req, res)).catch((err) => {
    try { sendJSON(res, 500, { error: 'INTERNAL', message: err?.message || String(err) }); }
    catch { try { res.end(); } catch { /* ignore */ } }
  });
});

server.on('clientError', (err, socket) => {
  try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch { /* ignore */ }
});

server.listen(CFG.port, CFG.host, () => {
  const mode = CFG.apiKey ? '在线模式' : '演示模式（未配置 PX_API_KEY）';
  const loopback = CFG.host === '127.0.0.1' || CFG.host === 'localhost' || CFG.host === '::1';
  const A = '\x1b[38;5;213m';
  const C = '\x1b[36m';
  const B = '\x1b[1m';
  const R = '\x1b[0m';
  const Y = '\x1b[33m';
  const lines = [
    '',
    `  ${A}+==========================================+${R}`,
    `  ${A}|  P I X E L S C R I B E                   |${R}`,
    `  ${A}|  像素画笔 · LLM 驱动 的像素美术引擎       |${R}`,
    `  ${A}+==========================================+${R}`,
    '',
    `  ${C}>${R} 本地地址:  ${B}http://localhost:${CFG.port}/${R}`,
    `  ${C}>${R} 监听主机:  ${CFG.host}${loopback ? '' : ` ${Y}（非回环，局域网可访问）${R}`}`,
    `  ${C}>${R} 运行模式:  ${mode}`,
    `  ${C}>${R} 模型:      ${CFG.model}`,
    `  ${C}>${R} 端点:      ${CFG.baseUrl}`,
    `  ${C}>${R} 思考模式:  ${CFG.thinking}`,
    `  ${C}>${R} 访问令牌:  ${CFG.authToken ? '已启用' : '未启用（仅限本机）'}`,
    '',
    loopback || CFG.authToken
      ? `  按 ${B}Ctrl+C${R} 停止服务`
      : `  ${Y}警告：监听非回环且未设置 PX_AUTH_TOKEN，公网/局域网可直接消耗你的 API Key。${R}`,
    '',
  ];
  console.log(lines.join('\n'));
});
