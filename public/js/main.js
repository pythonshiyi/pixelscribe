/**
 * 像素画笔 PixelScribe · 启动
 */

import { App } from './ui/app.js';

async function loadConfig() {
  try {
    const res = await fetch('/api/config', { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    return await res.json();
  } catch {
    // 直接以 file:// 打开或服务不可用 —— 退化为纯前端演示模式
    return {
      demoMode: true,
      keyConfigured: false,
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      temperature: 0.6,
      maxIterations: 6,
      visionLongEdge: 384,
      offline: true,
    };
  }
}

async function boot() {
  const config = await loadConfig();
  // 尽早应用主题，避免首帧闪白/闪黑
  try {
    const s = JSON.parse(localStorage.getItem('pixelscribe.settings.v1') || '{}');
    if (s.theme === 'light') document.documentElement.dataset.theme = 'light';
  } catch { /* 忽略 */ }
  const app = new App(config);
  try {
    await app.init();
  } catch (err) {
    document.body.innerHTML = `<pre style="padding:32px;color:#ff8b96;font-family:monospace;white-space:pre-wrap">
启动失败：${err?.message || err}

${err?.stack || ''}
</pre>`;
    throw err;
  }
  // 调试入口
  window.pixelscribe = app;
  if (config.offline) {
    console.warn('[像素画笔] 未检测到后端服务，已进入离线演示模式。运行 `npm start` 可获得完整能力。');
  }
}

boot();
