/**
 * PixelScript 差分编辑（unified diff）
 * ---------------------------------------------------------------
 * 让模型只输出「相对上一版脚本的改动」而不是整段重画，从而：
 *   · 大幅节省输出 token；
 *   · 把修改限制在局部，避免「改一处崩全身」；
 *   · 每次修改可读、可解释、可回退。
 *
 * 纯函数，Node 可测。支持标准 unified diff（@@ 块）与简化的 -/+ 片段。
 */

/** 归一化换行并切分为行数组。 */
export function splitLines(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
}

/** 去除首尾空行后拼接。 */
function tidy(lines) {
  let a = 0, b = lines.length;
  while (a < b && lines[a].trim() === '') a++;
  while (b > a && lines[b - 1].trim() === '') b--;
  return lines.slice(a, b).join('\n');
}

const MAX_DIFF_LINES = 1500;

/** 计算行级编辑操作序列：{type:' '|'-'|'+', text}。 */
function diffOps(a, b) {
  const n = a.length, m = b.length;
  if (n > MAX_DIFF_LINES || m > MAX_DIFF_LINES) {
    // 超大脚本退化：整段替换，避免 O(n·m) 卡顿
    return [
      ...a.map((text) => ({ type: '-', text })),
      ...b.map((text) => ({ type: '+', text })),
    ];
  }
  // LCS 动态规划（行数不大，脚本通常 < 500 行）
  const w = m + 1;
  const dp = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j]
        ? dp[(i + 1) * w + j + 1] + 1
        : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ type: ' ', text: a[i] }); i++; j++; }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) { ops.push({ type: '-', text: a[i] }); i++; }
    else { ops.push({ type: '+', text: b[j] }); j++; }
  }
  while (i < n) ops.push({ type: '-', text: a[i++] });
  while (j < m) ops.push({ type: '+', text: b[j++] });
  return ops;
}

/**
 * 生成 unified diff 文本（供 UI 展示 / 提示词示例）。
 * @param {string} oldText @param {string} newText @param {{context?:number}} [opts]
 * @returns {string} 无差异时返回空串
 */
export function unifiedDiff(oldText, newText, opts = {}) {
  const context = Math.max(0, opts.context ?? 2);
  const a = splitLines(tidy(splitLines(oldText)));
  const b = splitLines(tidy(splitLines(newText)));
  const ops = diffOps(a, b);
  if (!ops.some((o) => o.type !== ' ')) return '';

  // 标记需要保留的 op 索引（改动行及其前后 context 行）
  const keep = new Uint8Array(ops.length);
  ops.forEach((o, idx) => {
    if (o.type === ' ') return;
    for (let k = Math.max(0, idx - context); k <= Math.min(ops.length - 1, idx + context); k++) keep[k] = 1;
  });

  const out = [];
  let oldLine = 1, newLine = 1;
  let idx = 0;
  while (idx < ops.length) {
    if (!keep[idx]) {
      if (ops[idx].type === ' ') { oldLine++; newLine++; }
      idx++;
      continue;
    }
    // 收集连续保留段
    const start = idx;
    while (idx < ops.length && keep[idx]) idx++;
    const seg = ops.slice(start, idx);
    const oldCount = seg.filter((o) => o.type !== '+').length;
    const newCount = seg.filter((o) => o.type !== '-').length;
    out.push(`@@ -${oldLine},${oldCount} +${newLine},${newCount} @@`);
    for (const o of seg) {
      if (o.type === ' ') oldLine++, newLine++;
      else if (o.type === '-') oldLine++;
      else newLine++;
      out.push(`${o.type}${o.text}`);
    }
  }
  return `${out.join('\n')}\n`;
}

/** 解析 unified diff 的块。 */
function parseHunks(diffText) {
  const lines = splitLines(diffText);
  const hunks = [];
  let cur = null;
  for (const line of lines) {
    const m = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(line);
    if (m) {
      cur = { oldStart: Number(m[1]), lines: [] };
      hunks.push(cur);
      continue;
    }
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('\\')) continue;
    const ch = line[0];
    if (ch === ' ') { if (cur) cur.lines.push({ type: ' ', text: line.slice(1) }); continue; }
    if (ch === '+' || ch === '-') {
      const type = ch === '+' ? '+' : '-';
      if (!cur) { cur = { oldStart: NaN, lines: [] }; hunks.push(cur); }
      cur.lines.push({ type, text: line.slice(1) });
      continue;
    }
    // 无前缀的裸行视为上下文（容错）
    if (cur && line.trim() !== '') cur.lines.push({ type: ' ', text: line });
  }
  return hunks.filter((h) => h.lines.length);
}

const same = (a, b) => a.trim() === b.trim();

function matchAt(base, idx, seq) {
  if (idx < 0) return false;
  for (let k = 0; k < seq.length; k++) {
    if (idx + k >= base.length || !same(base[idx + k], seq[k])) return false;
  }
  return true;
}

/**
 * 应用 unified diff。容错：允许在预期位置附近 ±N 行搜索匹配块，容忍模型行号漂移。
 * @returns {{ok:boolean, text:string, error?:string, applied:number}}
 */
export function applyUnifiedDiff(baseText, diffText) {
  const base = splitLines(tidy(splitLines(baseText)));
  const hunks = parseHunks(diffText);
  if (!hunks.length) return { ok: false, text: baseText, error: '未找到可应用的 diff 块', applied: 0 };

  let offset = 0;
  let applied = 0;
  for (const h of hunks) {
    const oldSeq = h.lines.filter((l) => l.type !== '+').map((l) => l.text);
    const newSeq = h.lines.filter((l) => l.type !== '-').map((l) => l.text);
    if (!oldSeq.length) {
      // 纯插入：定位到 oldStart（或末尾）
      const at = Number.isFinite(h.oldStart) ? Math.max(0, h.oldStart - 1 + offset) : base.length;
      base.splice(at, 0, ...newSeq);
      offset += newSeq.length;
      applied++;
      continue;
    }
    const expected = Number.isFinite(h.oldStart) ? h.oldStart - 1 + offset : offset;
    let found = -1;
    if (matchAt(base, expected, oldSeq)) found = expected;
    else {
      const win = Math.max(50, oldSeq.length * 4);
      for (let d = 1; d <= win && found < 0; d++) {
        if (matchAt(base, expected - d, oldSeq)) found = expected - d;
        else if (matchAt(base, expected + d, oldSeq)) found = expected + d;
      }
    }
    if (found < 0) return { ok: false, text: baseText, error: `第 ${applied + 1} 个 diff 块找不到匹配上下文`, applied };
    base.splice(found, oldSeq.length, ...newSeq);
    offset += newSeq.length - oldSeq.length;
    applied++;
  }
  return { ok: true, text: base.join('\n'), applied };
}

/**
 * 从模型回复中提取 diff 代码块。
 * 支持 ```pixelscript-diff / ```pxdiff / ```diff / ```patch，
 * 以及 ```pixelscript 内含 @@ / --- / +/- 行的情况。
 * @returns {string|null}
 */
export function extractDiffBlock(text) {
  if (!text) return null;
  const s = String(text);
  const re = /```[ \t]*([A-Za-z0-9_-]*)[ \t]*\r?\n([\s\S]*?)(?:```|$)/g;
  const cands = [];
  let m;
  while ((m = re.exec(s)) !== null) {
    const lang = m[1].toLowerCase();
    const body = m[2];
    if (['pixelscript-diff', 'pxdiff', 'diff', 'patch'].includes(lang)) cands.push(body);
    else if (['pixelscript', 'px', 'pxs', 'pix'].includes(lang)
      && /(^|\n)\s*(?:@@|---|\+\+\+)/.test(body)) cands.push(body);
  }
  if (!cands.length) return null;
  const body = String(cands[0]).trim();
  return body || null;
}

/**
 * 把「纯 + 行」的增量片段转成可插入的 diff（无上下文）。
 * @param {string[]} plusLines
 */
export function appendDiff(plusLines) {
  return plusLines.map((l) => `+${l}`).join('\n');
}
