/**
 * 质量基准运行器（v2.5）
 * ---------------------------------------------------------------
 *   node bench/quality-bench.mjs            # 离线 DemoProvider（默认，随时可跑）
 *   PX_API_KEY=... node bench/quality-bench.mjs --live   # 真实模型
 *   node bench/quality-bench.mjs --check    # 与 baseline.json 比较，退步则退出非零
 *
 * 产出：out/bench/report.json、out/bench/report.md
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PixelDocument } from '../public/js/core/document.js';
import { History } from '../public/js/core/history.js';
import { toDataURL } from '../public/js/io/png.js';
import { Agent } from '../public/js/ai/agent.js';
import { DemoProvider } from '../public/js/ai/demo.js';
import { Provider } from '../public/js/ai/provider.js';
import { scoreArt, summarizeScores } from '../public/js/ai/quality.js';
import { BENCH_PROMPTS, BENCH_CATEGORIES } from './prompts.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'out', 'bench');
const BASELINE = path.join(__dirname, 'baseline.json');

/** Node 环境下的极简渲染器（复用纯 JS PNG 编码器）。 */
function makeRenderer(doc) {
  return {
    selection: null,
    overlay: null,
    onion: null,
    theme: 'dark',
    export(longEdge = 512) {
      return { dataURL: toDataURL(doc.composite().data, doc.width, doc.height, longEdge), width: doc.width, height: doc.height, scale: 1 };
    },
    exportBufferDataURL(buf, longEdge = 512) {
      return { dataURL: toDataURL(buf.data, buf.width, buf.height, longEdge), width: buf.width, height: buf.height, scale: 1 };
    },
    exportSmooth(longEdge = 512) { return this.export(longEdge); },
    visionDataURL(longEdge = 384) { return this.export(longEdge).dataURL; },
    bufferDataURL() { return ''; },
    controlMaps() { return {}; },
  };
}

function sizeFromBrief(brief) {
  const m = /(\d+)\s*[×x]\s*(\d+)/.exec(brief);
  if (!m) return 32;
  return Math.max(8, Math.min(128, Number(m[1]) || 32));
}

async function runOne(prompt, live) {
  const size = sizeFromBrief(prompt.brief);
  const doc = new PixelDocument(size, size);
  const history = new History(doc, 60);
  const renderer = makeRenderer(doc);
  const provider = live
    ? new Provider({
      baseUrl: process.env.PX_BASE_URL || 'https://api.deepseek.com',
      apiKey: process.env.PX_API_KEY,
      model: process.env.PX_MODEL || 'deepseek-flash',
      proxy: false,
    })
    : new DemoProvider({ width: size, height: size });

  const agent = new Agent({
    provider,
    renderer,
    doc,
    history,
    maxIterations: 3,
    vision: 'off',
    incremental: true,
    onEvent: () => {},
  });

  const t0 = Date.now();
  await agent.run(prompt.brief, {});
  const elapsedMs = Date.now() - t0;

  const { score, metrics } = scoreArt(doc.composite(), { palette: doc.palette });
  return { id: prompt.id, category: prompt.category, brief: prompt.brief, size, score, metrics, rounds: agent.iterations.length, elapsedMs };
}

async function main() {
  const live = process.argv.includes('--live');
  const check = process.argv.includes('--check');

  console.log(`\n\x1b[38;5;213m▸ 质量基准\x1b[0m  ${live ? '真实模型' : '离线 DemoProvider'} · ${BENCH_PROMPTS.length} 个 prompt\n`);

  const results = [];
  for (const p of BENCH_PROMPTS) {
    try {
      const r = await runOne(p, live);
      results.push(r);
      console.log(`  ${scoreColor(r.score)}  ${String(r.score).padStart(3)}  ${r.id.padEnd(8)} ${r.metrics.opaque}px · ${r.metrics.colorCount}色`);
    } catch (err) {
      results.push({ id: p.id, category: p.category, brief: p.brief, error: err.message, score: 0 });
      console.log(`  \x1b[31m✗ ${p.id}: ${err.message}\x1b[0m`);
    }
  }

  const overall = summarizeScores(results.map((r) => r.score));
  const byCategory = {};
  for (const cat of BENCH_CATEGORIES) {
    byCategory[cat] = summarizeScores(results.filter((r) => r.category === cat).map((r) => r.score));
  }

  fs.mkdirSync(OUT, { recursive: true });
  const report = { generatedAt: new Date().toISOString(), live, overall, byCategory, results };
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(OUT, 'report.md'), renderMarkdown(report));

  console.log(`\n  总分：\x1b[1m${overall.mean}\x1b[0m / 100（min ${overall.min} · max ${overall.max}）`);
  console.log(`  报告：out/bench/report.json · report.md\n`);

  if (check) {
    if (!fs.existsSync(BASELINE)) {
      console.log(`  \x1b[33m未找到 baseline.json，已跳过回归检查。\x1b[0m\n`);
    } else {
      const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
      const drop = base.overall.mean - overall.mean;
      if (drop > (base.tolerance ?? 3)) {
        console.error(`  \x1b[31m质量退步：基线 ${base.overall.mean} → 当前 ${overall.mean}（-${drop.toFixed(2)}）\x1b[0m\n`);
        process.exitCode = 1;
        return;
      }
      console.log(`  \x1b[38;5;84m回归检查通过：基线 ${base.overall.mean} → 当前 ${overall.mean}\x1b[0m\n`);
    }
  }
}

function scoreColor(s) {
  if (s >= 75) return '\x1b[38;5;84m●\x1b[0m';
  if (s >= 55) return '\x1b[38;5;220m●\x1b[0m';
  return '\x1b[31m●\x1b[0m';
}

function renderMarkdown(report) {
  const lines = [
    '# PixelScribe 质量基准报告',
    '',
    `- 生成时间：${report.generatedAt}`,
    `- 模式：${report.live ? '真实模型' : '离线 DemoProvider'}`,
    `- 总分：**${report.overall.mean} / 100**（min ${report.overall.min} · max ${report.overall.max}）`,
    '',
    '## 分类均分',
    '',
    '| 分类 | 数量 | 均分 | 最低 | 最高 |',
    '|---|---|---|---|---|',
  ];
  for (const [cat, s] of Object.entries(report.byCategory)) {
    lines.push(`| ${cat} | ${s.count} | ${s.mean} | ${s.min} | ${s.max} |`);
  }
  lines.push('', '## 明细', '', '| prompt | 分类 | 分数 | 覆盖 | 色数 | 调色板符合 | 轮廓 | 耗时 |', '|---|---|---|---|---|---|---|---|');
  for (const r of report.results) {
    if (r.error) { lines.push(`| ${r.id} | ${r.category} | ERR | | | | | ${r.error} |`); continue; }
    lines.push(`| ${r.id} | ${r.category} | ${r.score} | ${r.metrics.coverage} | ${r.metrics.colorCount} | ${r.metrics.paletteAdherence} | ${r.metrics.contourRatio} | ${r.elapsedMs}ms |`);
  }
  return lines.join('\n') + '\n';
}

main().catch((err) => {
  console.error(`\x1b[31m基准运行失败：${err.stack || err}\x1b[0m`);
  process.exitCode = 1;
});
