/**
 * 演示模式脚本库
 * ---------------------------------------------------------------
 * 未配置 API Key 时，用关键词匹配生成一份可用的 PixelScript，
 * 让整套 UI / 渲染 / 闭环流程在离线环境下依旧完整体验。
 */

/** 关键词 → 模板 */
const TEMPLATES = [
  {
    keys: ['史莱姆', 'slime', '史莱母', '果冻', 'jelly'],
    name: '史莱姆',
    build: (w, h) => {
      const cx = (w - 1) / 2, cy = h * 0.62;
      const rx = w * 0.34, ry = h * 0.26;
      return `
sym x
ellipse ${r(cx)} ${r(cy)} ${r(rx)} ${r(ry)} c3 fill
ellipse ${r(cx)} ${r(cy)} ${r(rx - 1)} ${r(ry - 1)} c11 fill
rect ${r(cx - rx)} ${r(cy)} ${r(rx * 2)} 1 c3 fill
circle ${r(cx - rx * 0.45)} ${r(cy - ry * 0.55)} 2 c0 fill
circle ${r(cx + rx * 0.45)} ${r(cy - ry * 0.55)} 2 c0 fill
px ${r(cx - rx * 0.45)} ${r(cy - ry * 0.7)} c7
px ${r(cx + rx * 0.45)} ${r(cy - ry * 0.7)} c7
dither ${r(cx - rx)} ${r(cy + ry * 0.35)} ${r(rx * 2)} ${r(ry * 0.6)} c11 c3 checker
outline c1`;
    },
  },
  {
    keys: ['药水', 'potion', '瓶子', 'bottle', '药剂'],
    name: '药水',
    build: (w, h) => {
      const cx = (w - 1) / 2;
      return `
sym x
rrect ${r(cx - w * 0.16)} ${r(h * 0.28)} ${r(w * 0.32)} ${r(h * 0.5)} 2 c7 fill
rect ${r(cx - w * 0.08)} ${r(h * 0.16)} ${r(w * 0.16)} ${r(h * 0.14)} c5 fill
rect ${r(cx - w * 0.14)} ${r(h * 0.14)} ${r(w * 0.28)} ${r(h * 0.04)} c4 fill
rrect ${r(cx - w * 0.13)} ${r(h * 0.5)} ${r(w * 0.26)} ${r(h * 0.26)} 2 c12 fill
hline ${r(cx - w * 0.13)} ${r(h * 0.5)} ${r(w * 0.26)} c14
px ${r(cx - w * 0.06)} ${r(h * 0.62)} c7
outline c1`;
    },
  },
  {
    keys: ['心', 'heart', '爱心', '喜欢', 'love'],
    name: '爱心',
    build: (w, h) => {
      const cx = (w - 1) / 2, cy = h * 0.42;
      const s = Math.min(w, h) * 0.3;
      return `
sym x
circle ${r(cx - s * 0.52)} ${r(cy)} ${r(s * 0.55)} c8 fill
circle ${r(cx + s * 0.52)} ${r(cy)} ${r(s * 0.55)} c8 fill
poly c8 fill ${r(cx - s * 1.05)} ${r(cy + s * 0.12)} ${r(cx + s * 1.05)} ${r(cy + s * 0.12)} ${r(cx)} ${r(cy + s * 1.35)}
px ${r(cx - s * 0.6)} ${r(cy - s * 0.35)} c14
px ${r(cx - s * 0.35)} ${r(cy - s * 0.55)} c14
outline c2`;
    },
  },
  {
    keys: ['树', 'tree', '森林', '松树'],
    name: '树',
    build: (w, h) => {
      const cx = (w - 1) / 2;
      return `
sym x
rect ${r(cx - w * 0.06)} ${r(h * 0.6)} ${r(w * 0.12)} ${r(h * 0.3)} c4 fill
poly c3 fill ${r(cx)} ${r(h * 0.06)} ${r(cx + w * 0.3)} ${r(h * 0.36)} ${r(cx - w * 0.3)} ${r(h * 0.36)}
poly c11 fill ${r(cx)} ${r(h * 0.16)} ${r(cx + w * 0.36)} ${r(h * 0.5)} ${r(cx - w * 0.36)} ${r(h * 0.5)}
circle ${r(cx)} ${r(h * 0.42)} ${r(w * 0.3)} c11 fill
dither ${r(cx)} ${r(h * 0.42)} ${r(w * 0.2)} ${r(h * 0.14)} c11 c3 checker
outline c1`;
    },
  },
  {
    keys: ['房子', 'house', '小屋', '建筑'],
    name: '小屋',
    build: (w, h) => `
sym x
rect ${r(w * 0.2)} ${r(h * 0.45)} ${r(w * 0.6)} ${r(h * 0.42)} c4 fill
poly c8 stroke ${r(w * 0.14)} ${r(h * 0.45)} ${r(w * 0.86)} ${r(h * 0.45)} ${r(w * 0.5)} ${r(h * 0.16)}
rect ${r(w * 0.42)} ${r(h * 0.62)} ${r(w * 0.16)} ${r(h * 0.25)} c9 fill
rect ${r(w * 0.26)} ${r(h * 0.54)} ${r(w * 0.12)} ${r(h * 0.1)} c12 fill
grad ${r(w * 0.14)} ${r(h * 0.8)} ${r(w * 0.72)} ${r(h * 0.1)} c3 c11 v
outline c1`,
  },
  {
    keys: ['星', 'star', '星星', '闪光'],
    name: '星星',
    build: (w, h) => {
      const cx = (w - 1) / 2, cy = h * 0.5;
      const R = Math.min(w, h) * 0.42;
      const inner = R * 0.42;
      const pts = [];
      for (let i = 0; i < 10; i++) {
        const ang = -Math.PI / 2 + (i * Math.PI) / 5;
        const rr = i % 2 === 0 ? R : inner;
        pts.push(`${r(cx + Math.cos(ang) * rr)} ${r(cy + Math.sin(ang) * rr)}`);
      }
      return `poly c10 fill ${pts.join(' ')}\npoly c9 stroke ${pts.join(' ')}\npx ${r(cx - 2)} ${r(cy - 2)} c7\noutline c1`;
    },
  },
  {
    keys: ['剑', 'sword', '武器', '刀'],
    name: '剑',
    build: (w, h) => `
sym y
rect ${r(w * 0.44)} ${r(h * 0.08)} ${r(w * 0.12)} ${r(h * 0.52)} c6 fill
rect ${r(w * 0.5)} ${r(h * 0.08)} ${r(w * 0.06)} ${r(h * 0.52)} c7 fill
poly c7 fill ${r(w * 0.44)} ${r(h * 0.08)} ${r(w * 0.56)} ${r(h * 0.08)} ${r(w * 0.5)} ${r(h * 0.02)}
rect ${r(w * 0.28)} ${r(h * 0.6)} ${r(w * 0.44)} ${r(h * 0.07)} c4 fill
rect ${r(w * 0.46)} ${r(h * 0.67)} ${r(w * 0.08)} ${r(h * 0.18)} c4 fill
circle ${r(w * 0.5)} ${r(h * 0.9)} 2 c9 fill
outline c1`,
  },
  {
    keys: ['幽灵', 'ghost', '鬼'],
    name: '幽灵',
    build: (w, h) => `
sym x
rrect ${r(w * 0.24)} ${r(h * 0.16)} ${r(w * 0.52)} ${r(h * 0.6)} ${r(w * 0.26)} c6 fill
rect ${r(w * 0.24)} ${r(h * 0.6)} ${r(w * 0.52)} ${r(h * 0.16)} c6 fill
ellipse ${r(w * 0.37)} ${r(h * 0.76)} ${r(w * 0.1)} ${r(h * 0.07)} c0 fill
ellipse ${r(w * 0.63)} ${r(h * 0.76)} ${r(w * 0.1)} ${r(h * 0.07)} c0 fill
ellipse ${r(w * 0.37)} ${r(h * 0.4)} ${r(w * 0.07)} ${r(h * 0.09)} c1 fill
ellipse ${r(w * 0.63)} ${r(h * 0.4)} ${r(w * 0.07)} ${r(h * 0.09)} c1 fill
px ${r(w * 0.4)} ${r(h * 0.38)} c7
px ${r(w * 0.66)} ${r(h * 0.38)} c7
outline c5`,
  },
  {
    keys: ['花', 'flower', '花朵'],
    name: '小花',
    build: (w, h) => `
sym xy
vline ${r((w - 1) / 2)} ${r(h * 0.5)} ${r(h * 0.42)} c3
ellipse ${r(w * 0.36)} ${r(h * 0.72)} ${r(w * 0.1)} ${r(h * 0.05)} c11 fill
circle ${r(w * 0.5)} ${r(h * 0.3)} ${r(w * 0.13)} c14 fill
circle ${r(w * 0.5)} ${r(h * 0.3)} ${r(w * 0.06)} c10 fill
outline c2`,
  },
  {
    keys: ['机器人', 'robot', '机甲'],
    name: '机器人',
    build: (w, h) => `
sym x
rect ${r(w * 0.26)} ${r(h * 0.26)} ${r(w * 0.48)} ${r(h * 0.38)} c6 fill
rect ${r(w * 0.3)} ${r(h * 0.36)} ${r(w * 0.12)} ${r(h * 0.08)} c12 fill
rect ${r(w * 0.58)} ${r(h * 0.36)} ${r(w * 0.12)} ${r(h * 0.08)} c12 fill
rect ${r(w * 0.34)} ${r(h * 0.54)} ${r(w * 0.32)} ${r(h * 0.05)} c5 fill
vline ${r(w * 0.5)} ${r(h * 0.16)} ${r(h * 0.1)} c6
circle ${r(w * 0.5)} ${r(h * 0.14)} 2 c8 fill
rect ${r(w * 0.2)} ${r(h * 0.64)} ${r(w * 0.6)} ${r(h * 0.22)} c5 fill
rect ${r(w * 0.36)} ${r(h * 0.68)} ${r(w * 0.28)} ${r(h * 0.1)} c9 fill
outline c0`,
  },
  {
    keys: ['云', 'cloud', '天空'],
    name: '云',
    build: (w, h) => `
sym x
circle ${r(w * 0.36)} ${r(h * 0.5)} ${r(w * 0.16)} c7 fill
circle ${r(w * 0.5)} ${r(h * 0.4)} ${r(w * 0.2)} c7 fill
circle ${r(w * 0.66)} ${r(h * 0.52)} ${r(w * 0.14)} c7 fill
rect ${r(w * 0.24)} ${r(h * 0.5)} ${r(w * 0.52)} ${r(h * 0.16)} c7 fill
adjust ${r(w * 0.24)} ${r(h * 0.58)} ${r(w * 0.52)} ${r(h * 0.08)} dark 0.15
outline c6`,
  },
  {
    keys: ['山', '风景', 'landscape', '山景', '背景'],
    name: '山景',
    build: (w, h) => `
grad 0 0 ${w} ${r(h * 0.62)} c12 c7 v
circle ${r(w * 0.76)} ${r(h * 0.18)} ${r(w * 0.09)} c10 fill
poly c3 fill 0 ${h} ${r(w * 0.22)} ${r(h * 0.42)} ${r(w * 0.48)} ${h}
poly c1 fill ${r(w * 0.34)} ${h} ${r(w * 0.66)} ${r(h * 0.36)} ${w} ${h}
poly c7 stroke ${r(w * 0.22)} ${r(h * 0.42)} ${r(w * 0.34)} ${h} ${r(w * 0.1)} ${h}
grad 0 ${r(h * 0.82)} ${w} ${r(h * 0.18)} c11 c3 v
noise 0 ${r(h * 0.82)} ${w} ${r(h * 0.18)} c11 0.08
noise 0 0 ${w} ${r(h * 0.5)} c7 0.02`,
  },
];

const FALLBACKS = [
  (w, h) => `
sym xy
circle ${r((w - 1) / 2)} ${r((h - 1) / 2)} ${r(Math.min(w, h) * 0.42)} c1 fill
circle ${r((w - 1) / 2)} ${r((h - 1) / 2)} ${r(Math.min(w, h) * 0.34)} c12 fill
circle ${r((w - 1) / 2)} ${r((h - 1) / 2)} ${r(Math.min(w, h) * 0.22)} c7 fill
circle ${r((w - 1) / 2)} ${r((h - 1) / 2)} ${r(Math.min(w, h) * 0.1)} c8 fill
outline c0`,
  (w, h) => `
sym x
poly c5 fill ${r(w * 0.5)} ${r(h * 0.08)} ${r(w * 0.92)} ${r(h * 0.5)} ${r(w * 0.5)} ${r(h * 0.92)} ${r(w * 0.08)} ${r(h * 0.5)}
poly c9 stroke ${r(w * 0.5)} ${r(h * 0.08)} ${r(w * 0.92)} ${r(h * 0.5)} ${r(w * 0.5)} ${r(h * 0.92)} ${r(w * 0.08)} ${r(h * 0.5)}
circle ${r(w * 0.5)} ${r(h * 0.5)} ${r(Math.min(w, h) * 0.14)} c10 fill
outline c0`,
];

const r = (v) => Math.round(v);

/**
 * 根据用户描述生成脚本
 * @param {string} brief
 * @param {number} w @param {number} h
 * @returns {string}
 */
export function demoScript(brief, w, h) {
  const text = String(brief || '').toLowerCase();
  const hit = TEMPLATES.find((t) => t.keys.some((k) => text.includes(k)));
  const body = hit ? hit.build(w, h) : FALLBACKS[Math.abs(hash(text)) % FALLBACKS.length](w, h);
  return [
    `size ${w} ${h}`,
    'palette pico8',
    'clear transparent',
    `name "${hit ? hit.name : '像素作品'}"`,
    'seed 1',
    body.trim(),
  ].join('\n');
}

function hash(s) {
  let x = 0;
  for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) | 0;
  return x;
}

/** 演示模式下的"审查意见" */
export function demoCritique(iteration) {
  if (iteration === 0) {
    return [
      '整体形状已经出来了，我再做几处优化：',
      '- 增加轮廓对比，让主体从背景中跳出',
      '- 补一点高光，提升立体感',
      '',
      '```pixelscript',
      'adjust 0 0 999 999 light 0.06',
      'text 2 2 c7 "PX" 1',
      '```',
    ].join('\n');
  }
  return 'DONE';
}

/**
 * 根据消息历史生成演示回复（纯同步，便于测试与复用）
 * @param {any[]} messages
 * @param {number} width @param {number} height
 * @returns {string}
 */
export function demoReply(messages, width, height) {
  const turns = messages.filter((m) => m.role === 'assistant').length;
  if (turns === 0) {
    const briefMsg = messages.find((m) => m.role === 'user');
    const brief = typeof briefMsg?.content === 'string'
      ? briefMsg.content
      : (briefMsg?.content || []).find((p) => p.type === 'text')?.text ?? '';
    return `好的，我来画一个。\n\n\`\`\`pixelscript\n${demoScript(brief, width, height)}\n\`\`\``;
  }
  return demoCritique(turns - 1);
}

/**
 * 演示 Provider：接口与真实 Provider 一致，便于 Agent 无差别驱动。
 */
export class DemoProvider {
  /** @param {{width:number, height:number}} docInfo */
  constructor(docInfo) {
    this.docInfo = { ...docInfo };
    this.model = 'demo-pixelbot';
    this.temperature = 0;
  }

  /** @param {any[]} messages */
  async chat(messages, opts = {}) {
    const text = demoReply(messages, this.docInfo.width, this.docInfo.height);
    if (opts.onDelta) {
      const step = Math.max(1, Math.ceil(text.length / 40));
      for (let i = 0; i < text.length; i += step) {
        if (opts.signal?.aborted) break;
        opts.onDelta(text.slice(i, i + step));
        await new Promise((res) => setTimeout(res, 12));
      }
    }
    return { text, usage: { prompt_tokens: 0, completion_tokens: text.length } };
  }
}

