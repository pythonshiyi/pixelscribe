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
 * 安全：API Key 只存在于服务端环境变量，永不下发浏览器。
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch {
  /* 无 .env 时使用默认值 / 环境变量 */
}

const CFG = {
  port: Number(process.env.PX_PORT || 5173),
  baseUrl: (process.env.PX_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
  apiKey: process.env.PX_API_KEY || '',
  model: process.env.PX_MODEL || 'gpt-4o-mini',
  temperature: Number(process.env.PX_TEMPERATURE || 0.6),
  maxIterations: Number(process.env.PX_MAX_ITERATIONS || 6),
  visionLongEdge: Number(process.env.PX_VISION_LONG_EDGE || 384),
  timeoutMs: Number(process.env.PX_TIMEOUT_MS || 120000),
};

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

function providerHeaders(extra = {}) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${CFG.apiKey}`,
    ...extra,
  };
}

/**
 * /api/chat
 * 请求体：{ messages, model?, temperature?, stream?, baseUrl?, apiKey? }
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
  const baseUrl = (payload.baseUrl || CFG.baseUrl).replace(/\/+$/, '');
  const model = payload.model || CFG.model;
  const stream = payload.stream !== false;

  if (!key) {
    return sendJSON(res, 400, {
      error: 'NO_API_KEY',
      message: '未配置 API Key。请在 .env 设置 PX_API_KEY，或在界面中启用「前端直连」并填入 Key。',
    });
  }

  const body = {
    model,
    messages: payload.messages || [],
    temperature: payload.temperature ?? CFG.temperature,
    stream,
  };
  if (payload.max_tokens) body.max_tokens = payload.max_tokens;
  if (payload.response_format) body.response_format = payload.response_format;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CFG.timeoutMs);
  req.on('close', () => controller.abort());

  let upstream;
  try {
    upstream = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: providerHeaders(),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
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
    return sendJSON(res, upstream.status, {
      error: 'UPSTREAM_ERROR',
      status: upstream.status,
      message: text.slice(0, 4000),
    });
  }

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
      demoMode: !CFG.apiKey,
      version: '1.0.0',
    });
  }

  if (url.pathname === '/api/chat') {
    if (req.method !== 'POST') return sendJSON(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    return handleChat(req, res);
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
    '',
    `  按 ${B}Ctrl+C${R} 停止服务`,
    '',
  ];
  console.log(lines.join('\n'));
});
