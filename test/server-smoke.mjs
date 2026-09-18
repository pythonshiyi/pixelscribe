/**
 * 服务端冒烟测试（真实进程 + 真实 HTTP）
 * ---------------------------------------------------------------
 * 覆盖：/api/config 信息泄露、非法百分号编码不崩进程、SSRF/baseUrl 防护、
 *       作品库不覆盖同名文件、方法守卫。运行：node test/server-smoke.mjs
 */

import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { encodePNG, toBase64 } from '../public/js/io/png.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let passed = 0;
const failures = [];
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { failures.push({ name, extra }); console.log(`  \x1b[31m✗ ${name}${extra ? `\n      ${extra}` : ''}\x1b[0m`); }
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

/** 记录请求的 mock 上游/诱饵服务。 */
function makeRecorder(handler) {
  const hits = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      hits.push({ url: req.url, method: req.method, body });
      handler(req, res, body);
    });
  });
  return { server, hits };
}

async function main() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pxs-test-'));

  // 诱饵上游（不该被访问）与真正的 mock 上游
  const evil = makeRecorder((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); });
  const evilPort = await listen(evil.server);
  const upstream = makeRecorder((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
  const upPort = await listen(upstream.server);

  const pxPort = 5200 + Math.floor(Math.random() * 300);
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PX_PORT: String(pxPort),
      PX_HOST: '127.0.0.1',
      PX_API_KEY: 'test-key',
      PX_BASE_URL: `http://127.0.0.1:${upPort}`,
      PX_WORKSPACE: workspace,
      PX_AUTH_TOKEN: '',
      PX_STREAM_USAGE: 'on',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childErr = '';
  child.stderr.on('data', (d) => { childErr += d; });

  const base = `http://127.0.0.1:${pxPort}`;
  const cleanup = () => {
    try { child.kill(); } catch { /* ignore */ }
    try { evil.server.close(); } catch { /* ignore */ }
    try { upstream.server.close(); } catch { /* ignore */ }
  };

  try {
    // 等待服务就绪
    let cfg = null;
    for (let i = 0; i < 50; i++) {
      try {
        const r = await fetch(`${base}/api/config`);
        if (r.ok) { cfg = await r.json(); break; }
      } catch { /* 尚未启动 */ }
      await wait(100);
    }
    if (!cfg) throw new Error(`服务未启动：${childErr || '无输出'}`);

    ok('/api/config 返回能力信息', cfg.provider === 'openai-compatible' && cfg.model);

    // 信息泄露：不应包含绝对路径
    const cfgStr = JSON.stringify(cfg);
    ok('config 不泄露绝对路径', !cfgStr.includes(workspace) && !/[A-Za-z]:\\\\/.test(cfgStr),
      `config=${cfgStr}`);
    ok('config galleryDir 为相对路径', !path.isAbsolute(cfg.galleryDir || ''), `dir=${cfg.galleryDir}`);

    // 非法百分号编码：应返回 4xx 而不是崩溃
    const badRes = await fetch(`${base}/%`);
    ok('非法 URI 编码返回 4xx', badRes.status >= 400 && badRes.status < 500, `status=${badRes.status}`);
    const alive = await (await fetch(`${base}/api/config`)).json();
    ok('非法请求后进程仍存活', Boolean(alive.version));

    // SSRF / 密钥外泄：请求体 baseUrl 不应把服务端 Key 发往其它主机
    const chat = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stream: false,
        messages: [{ role: 'user', content: 'hi' }],
        baseUrl: `http://127.0.0.1:${evilPort}`,
      }),
    });
    ok('使用服务端 Key 时忽略请求体 baseUrl（返回成功）', chat.status === 200, `status=${chat.status}`);
    ok('请求被发往配置端点', upstream.hits.length >= 1, `upstream hits=${upstream.hits.length}`);
    ok('请求未发往攻击者指定主机', evil.hits.length === 0, `evil hits=${evil.hits.length}`);

    // 作品库不覆盖同名文件
    const buf = new Uint8ClampedArray(1 * 1 * 4);
    buf[0] = 255; buf[3] = 255;
    const pngURL = `data:image/png;base64,${toBase64(encodePNG(buf, 1, 1))}`;
    const save = () => fetch(`${base}/api/gallery/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'png', name: 'dup', dataURL: pngURL }),
    }).then((r) => r.json());
    const s1 = await save();
    const s2 = await save();
    ok('同名作品不覆盖（自动改名）', s1.ok && s2.ok && s1.name !== s2.name, `${s1.name} vs ${s2.name}`);

    // 方法守卫
    const wrong = await fetch(`${base}/api/chat`);
    ok('GET /api/chat 返回 405', wrong.status === 405, `status=${wrong.status}`);
  } finally {
    cleanup();
    await wait(100);
    try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log('\n' + '─'.repeat(58));
  if (failures.length) {
    console.log(`\x1b[31m失败 ${failures.length} 项 / 通过 ${passed} 项\x1b[0m`);
    process.exitCode = 1;
  } else {
    console.log(`\x1b[38;5;84m全部通过 ${passed} 项\x1b[0m`);
  }
}

main().catch((err) => {
  console.error(`\x1b[31m服务端冒烟测试异常：${err.stack || err}\x1b[0m`);
  process.exitCode = 1;
});
