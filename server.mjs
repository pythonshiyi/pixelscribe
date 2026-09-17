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
const VERSION = '1.2.0';

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
  baseUrl: normalizeBaseUrl(process.env.PX_BASE_URL || GW.baseUrl || 'https://opencode.ai/zen/go/v1'),
  apiKey: process.env.PX_API_KEY || GW.apiKey || '',
  model: process.env.PX_MODEL || GW.model || 'deepseek-v4.1-flash',
  temperature: Number(process.env.PX_TEMPERATURE || 0.6),
  maxIterations: Number(process.env.PX_MAX_ITERATIONS || 6),
  visionLongEdge: Number(process.env.PX_VISION_LONG_EDGE || 384),
  timeoutMs: Number(process.env.PX_TIMEOUT_MS || 180000),
  maxTokens: Number(process.env.PX_MAX_TOKENS || 2048),
  // auto：已知网关（opencode / 官方）→ 关闭思考（快、省、确定性好）；其它网关不下发；
  // disabled / enabled：强制。
  thinking: String(process.env.PX_THINKING || 'auto').toLowerCase(),
  vision: String(process.env.PX_VISION || 'auto').toLowerCase(),
};

// 不透明、按进程稳定：同一会话路由到同一后端，提升缓存命中（官方文档要求）。
const OPENCODE_SESSION = crypto.randomUUID();
const USER_AGENT = 'PixelScribe/1.1 (+https://github.com/pythonshiyi/pixelscribe)';

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
function thinkingBody(baseUrl, mode) {
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

const MAX_BODY = 8 * 1024 * 1024;

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
  let name = safeGalleryName(payload.name) || `pixelscribe_${stamp}`;
  if (!name.toLowerCase().endsWith(`.${kind}`)) name += `.${kind}`;
  const full = path.join(GALLERY_DIR, name);
  try {
    if (kind === 'png') {
      const m = /^data:image\/png;base64,(.+)$/s.exec(String(payload.dataURL || ''));
      if (!m) return sendJSON(res, 400, { error: 'BAD_DATAURL', message: '需要 data:image/png;base64,... 的 PNG dataURL' });
      const buf = Buffer.from(m[1], 'base64');
      if (buf.length > GALLERY_MAX_BYTES) return sendJSON(res, 413, { error: 'TOO_LARGE' });
      await fsp.writeFile(full, buf);
    } else {
      const text = String(payload.text ?? '');
      if (Buffer.byteLength(text, 'utf8') > GALLERY_MAX_BYTES) return sendJSON(res, 413, { error: 'TOO_LARGE' });
      await fsp.writeFile(full, text, 'utf8');
    }
  } catch (e) {
    return sendJSON(res, 500, { error: 'WRITE_FAILED', message: e.message });
  }
  return sendJSON(res, 200, { ok: true, name, url: `/api/gallery/file/${encodeURIComponent(name)}` });
}

/** 在系统文件管理器中打开作品库目录。 */
function revealWorkspace(res) {
  try {
    if (process.platform === 'win32') spawn('explorer', [GALLERY_DIR], { detached: true, stdio: 'ignore' }).unref();
    else if (process.platform === 'darwin') spawn('open', [GALLERY_DIR], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [GALLERY_DIR], { detached: true, stdio: 'ignore' }).unref();
    return sendJSON(res, 200, { ok: true, dir: GALLERY_DIR });
  } catch (e) {
    return sendJSON(res, 500, { error: 'REVEAL_FAILED', message: e.message, dir: GALLERY_DIR });
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
  let rel = decodeURIComponent(urlPath.split('?')[0]);
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

function providerHeaders(baseUrl, hasKey) {
  const h = { 'Content-Type': 'application/json', ...gatewayHeaders(baseUrl) };
  if (hasKey) h.Authorization = `Bearer ${CFG.apiKey}`;
  return h;
}

function buildUpstreamBody(payload, baseUrl, { withThinking }) {
  const body = {
    model: payload.model || CFG.model,
    messages: payload.messages || [],
    temperature: payload.temperature ?? CFG.temperature,
    stream: payload.stream !== false,
  };
  let maxTokens = payload.max_tokens ?? CFG.maxTokens;
  let thinking = null;
  if (withThinking) thinking = thinkingBody(baseUrl, CFG.thinking);
  if (thinking) body.thinking = thinking;
  // 开思考时 reasoning 也占 completion 预算，下限抬到 8192，避免 content 被挤空
  if (thinking?.type === 'enabled' && maxTokens && maxTokens < 8192) maxTokens = 8192;
  if (maxTokens) body.max_tokens = maxTokens;
  if (payload.top_p != null) body.top_p = payload.top_p;
  if (payload.response_format) body.response_format = payload.response_format;
  return body;
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
      error: err.message === 'PAYLOAD_TOO_LARGE' ? '请求体过大（上限 8MB）' : '请求体不是合法 JSON',
    });
  }

  const key = payload.apiKey || CFG.apiKey;
  const baseUrl = normalizeBaseUrl(payload.baseUrl || CFG.baseUrl);
  if (!key) {
    return sendJSON(res, 400, {
      error: 'NO_API_KEY',
      message: '未配置 API Key。请在 .env 设置 PX_API_KEY，或在界面中启用「前端直连」并填入 Key。',
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CFG.timeoutMs);
  req.on('close', () => controller.abort());

  let upstream;
  try {
    upstream = await callUpstream(baseUrl, key, buildUpstreamBody(payload, baseUrl, { withThinking: true }), controller.signal);
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      if (isThinkingRejection(upstream.status, text)) {
        // 网关不认 thinking：去掉重试一次（深度兼容未知 OpenAI 兼容端点）
        upstream = await callUpstream(baseUrl, key, buildUpstreamBody(payload, baseUrl, { withThinking: false }), controller.signal);
      } else {
        clearTimeout(timer);
        return sendJSON(res, upstream.status, { error: 'UPSTREAM_ERROR', status: upstream.status, message: text.slice(0, 4000) });
      }
    }
  } catch (err) {
    clearTimeout(timer);
    return sendJSON(res, 502, {
      error: 'UPSTREAM_UNREACHABLE',
      message: `无法连接 ${baseUrl}/chat/completions：${err.message}`,
    });
  }

  if (!upstream.ok) {
    clearTimeout(timer);
    const text = await upstream.text().catch(() => '');
    return sendJSON(res, upstream.status, { error: 'UPSTREAM_ERROR', status: upstream.status, message: text.slice(0, 4000) });
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/api/config') {
    if (req.method !== 'GET') return sendJSON(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    return sendJSON(res, 200, {
      keyConfigured: Boolean(CFG.apiKey),
      baseUrl: CFG.baseUrl,
      model: CFG.model,
      temperature: CFG.temperature,
      maxIterations: CFG.maxIterations,
      visionLongEdge: CFG.visionLongEdge,
      maxTokens: CFG.maxTokens,
      thinking: CFG.thinking,
      vision: CFG.vision,
      provider: isOpencodeEndpoint(CFG.baseUrl) ? 'opencode' : (isOfficialEndpoint(CFG.baseUrl) ? 'deepseek' : 'openai-compatible'),
      gateway: { opencode: isOpencodeEndpoint(CFG.baseUrl), official: isOfficialEndpoint(CFG.baseUrl) },
      workspace: WORKSPACE_DIR,
      galleryDir: GALLERY_DIR,
      demoMode: !CFG.apiKey,
      version: VERSION,
    });
  }

  if (url.pathname === '/api/chat') {
    if (req.method !== 'POST') return sendJSON(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    return handleChat(req, res);
  }

  /* ── 作品库（文件空间） ── */
  if (url.pathname === '/api/gallery') {
    if (req.method !== 'GET') return sendJSON(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    const items = await listGallery();
    return sendJSON(res, 200, { workspace: WORKSPACE_DIR, dir: GALLERY_DIR, items });
  }

  if (url.pathname.startsWith('/api/gallery/file/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJSON(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    const raw = decodeURIComponent(url.pathname.slice('/api/gallery/file/'.length));
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
});

server.listen(CFG.port, () => {
  const mode = CFG.apiKey ? '在线模式' : '演示模式（未配置 PX_API_KEY）';
  const A = '\x1b[38;5;213m';
  const C = '\x1b[36m';
  const B = '\x1b[1m';
  const R = '\x1b[0m';
  const lines = [
    '',
    `  ${A}+==========================================+${R}`,
    `  ${A}|  P I X E L S C R I B E                   |${R}`,
    `  ${A}|  像素画笔 · LLM 驱动 的像素美术引擎       |${R}`,
    `  ${A}+==========================================+${R}`,
    '',
    `  ${C}>${R} 本地地址:  ${B}http://localhost:${CFG.port}/${R}`,
    `  ${C}>${R} 运行模式:  ${mode}`,
    `  ${C}>${R} 模型:      ${CFG.model}`,
    `  ${C}>${R} 端点:      ${CFG.baseUrl}`,
    `  ${C}>${R} 思考模式:  ${CFG.thinking}`,
    '',
    `  按 ${B}Ctrl+C${R} 停止服务`,
    '',
  ];
  console.log(lines.join('\n'));
});
