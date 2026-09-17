/**
 * 提示词工程
 * ---------------------------------------------------------------
 * 三块拼装：身份 → 语言规范 → 绘制策略 → 输出契约。
 * 目标是让模型**一次写对** PixelScript，并在迭代中看懂渲染结果。
 */

import { dslReference } from '../lang/compiler.js';

/** 风格 → 该风格下的绘制与渲染策略提示 */
export const STYLE_GUIDE = {
  pixel: '像素风：硬边、有限色板、图元组合。不要用 blur/bloom，保持像素质感。',
  painting: '手绘/油画：先定大色块，再用 relief+tone 塑造体积与光感，dither 表现笔触过渡。',
  ink: '水墨/线稿：少色甚至单色，依赖 curve/arc 的线条与 tone 的高对比；relief 表现皴擦。',
  anime: '动画赛璐璐：平涂大色块 + 明确 outline；用 bloom 做高光，tone 提饱和度。',
  '3d': '3D/黏土：用 light 声明方向光，relief+specular 塑造体积与高光，tone 做相机曲线。',
  photo: '写实照片：先铺正确的大色块与明暗（这是构图骨架），再用 light+relief+specular 建立光照，'
    + 'fbm 生成材质（皮肤/石头/木纹），bloom 做高光溢出，tone 做相机色调；最后 render photo 交神经后端补高频细节。',
};

/**
 * @param {{width:number,height:number,paletteName:string,paletteSize:number,
 *          title:string,paletteLegend?:string}} docInfo
 * @returns {string}
 */
export function buildSystemPrompt(docInfo) {
  const legend = docInfo.paletteLegend
    ? `\n调色板速查（索引=色值(名称)）：${docInfo.paletteLegend}\n`
    : '';
  const style = docInfo.style || 'pixel';
  const styleLine = STYLE_GUIDE[style] || STYLE_GUIDE.pixel;
  const hasNeural = docInfo.neuralRender ? '可用（写实细节由神经后端补全）' : '不可用（用程序化光照/材质逼近）';
  return `你是「像素画笔」的绘制指令生成器。你无法直接输出图片，只能通过编写 PixelScript
代码来作画；引擎会立即执行并把你画的图渲染成 PNG 回传给你看。
当你需要照片级高频细节时，用 \`render\` 指令请求渲染管线（神经后端${hasNeural}）。

# 画布
当前尺寸 ${docInfo.width}×${docInfo.height}，坐标原点在左上角，x 向右、y 向下。
当前风格：${style}
渲染后端状态：${hasNeural}
调色板：${docInfo.paletteName}（可用颜色索引 c0 … c${docInfo.paletteSize - 1}）。${legend}
# PixelScript 指令表
${dslReference()}

# 颜色写法
- 调色板索引：c0 c1 c2 …（优先使用，能保证画面色彩统一）
- 十六进制：#f00 / #ff004d / #ff004d80
- 语义名：red blue white darkgreen … / transparent

# 绘制策略（非常重要）
1. **不要逐像素描摹**。用 ellipse / circle / rect / poly / curve / arc 等图元组合出形状。
2. 先定 3–6 种颜色的配色，再定大形，最后补细节。
3. 对称物体（角色、道具、徽章）务必使用 sym x 或 sym xy，可减少一半指令并保证对称。
4. 最后用 outline c0 或 outline c1 描边，可显著提升可读性。
5. **阴影/受光用 shade**：shade X Y W H 同色系深色 0.3 比 adjust 更可控（保持色相）；配合 dither 摆脱死黑。
6. **立体感用 bevel**：给道具、按钮、宝石加 bevel X Y W H 2 0.3（左上受光、右下阴影）。
7. **渐变用 graddither**：天空/光照过渡用 graddither X Y W H C1 C2 bayer v，比 grad 更有像素质感。
8. **有机曲线用 curve / arc**：叶形、毛发、飘带用 curve，圆角高光用 arc（角度制）。
9. 高光用 adjust 提亮或直接用小面积浅色；圆/椭圆半径取画布尺寸的 1/4 ~ 1/3 通常比较好看。
10. 所有绘制坐标必须在 0 … ${docInfo.width - 1} / 0 … ${docInfo.height - 1} 范围内。

# 写实/进阶管线（当风格不是 pixel 时）
A. 先用 \`light DX DY [Z] [STRENGTH] [COLOR]\` 声明方向光（如 \`light -1 -1 1 1\` 左上主光）。
B. \`relief STRENGTH AMBIENT\` 用法线做漫反射塑形，\`specular STRENGTH POWER\` 加湿润/金属高光。
C. \`fbm X Y W H C1 C2 OCTAVES SCALE mod\` 生成材质纹理，mod 模式会调制已有颜色的明度。
D. \`bloom THRESHOLD STRENGTH RADIUS\` 做光源溢出，\`tone GAMMA CONTRAST SATURATION BRIGHTNESS VIGNETTE\` 做相机色调。
E. 最后 \`render ${style}\` 交给渲染管线（程序化先验/神经后端），它会补全高频细节。
F. ${styleLine}

# 输出契约
- **只输出一个 \`\`\`pixelscript 代码块**，不要输出 JSON、不要输出解释性的多段文字。
- 代码块之外最多写一句中文说明；**不要在代码块前后粘贴你的推理/思考过程**。
- 第一行必须是 size ${docInfo.width} ${docInfo.height}。
- 不要使用未在指令表中出现的命令，不要用 Markdown 表格/列表描述画面。
- 颜色优先用 c0…c${docInfo.paletteSize - 1}，可对照上面的调色板速查选色。

# 示例
\`\`\`pixelscript
size 32 32
palette pico8
clear transparent
sym x
ellipse 16 20 11 8 c3 fill
ellipse 16 20 11 8 c11 fill
circle 11 16 2 c0 fill
circle 21 16 2 c0 fill
dither 8 22 16 4 c11 c3 checker
outline c1
\`\`\``;
}

/** 用户需求 */
export function buildUserBrief(brief, docInfo) {
  const style = docInfo.style || 'pixel';
  const extra = style !== 'pixel'
    ? `\n目标风格：${style}。请用 light/relief/specular/fbm/bloom/tone 建立光照与材质，并以 render ${style} 收尾。`
    : '';
  return `请画：${brief}

画布 ${docInfo.width}×${docInfo.height}。${extra}
直接输出一个 \`\`\`pixelscript 代码块。`;
}

/**
 * 导演阶段（Planner）：先让模型做构图/光照规划，再写脚本。
 * 双智能体里的「导演」，与执行脚本的「画师」分离，降低一次性生成的认知负担。
 */
export function buildPlanPrompt(brief, docInfo) {
  const style = docInfo.style || 'pixel';
  return `你是像素/图像美术的**导演**。用户需求：${brief}
画布 ${docInfo.width}×${docInfo.height}，目标风格 ${style}。

请先用不超过 6 行中文给出制作计划，覆盖：
1. 主体与构图（位置、占比、视线方向）
2. 配色方案（主色/辅色/阴影色）
3. 光照方案（光源方向、材质高光）——若风格非 pixel
4. 分几轮推进、每轮目标

只输出计划，不要输出代码。`;
}

/** 详情阶段：把导演计划交给画师写成脚本 */
export function buildDetailPrompt(plan) {
  return `根据以下导演计划，写出 PixelScript 脚本：
${plan}

现在输出一个 \`\`\`pixelscript 代码块。`;
}

/**
 * 迭代轮：把渲染图 + 执行报告 + 区域（tile）诊断回灌
 * @param {{iteration:number, max:number, mode:'replace'|'append', report:any,
 *          ascii?:string, hasImage:boolean, style?:string, tiles?:any[]}} info
 */
export function buildCritique(info) {
  const { iteration, max, mode, report } = info;
  const style = info.style || 'pixel';
  const head = `这是你上一轮脚本渲染出来的结果（第 ${iteration}/${max} 轮，风格 ${style}）。`;
  const stats = `执行报告：${report.ops} 条指令成功，改动 ${report.changed} 个像素。`;
  const ascii = info.ascii ? `\n低分辨率网格预览（每个字符代表一个色块，. 为透明）：\n${info.ascii}\n` : '';
  const tiles = formatTiles(info.tiles);
  const modeHint = mode === 'append'
    ? '下一轮请输出**增量**脚本：只写需要新增或覆盖的指令（不要重画全部内容）。'
    : '下一轮如果修改，请输出完整的整幅脚本。';
  const pipelineHint = style !== 'pixel'
    ? '\n- 光照/材质是否到位？可追加 light / relief / specular / fbm / bloom / tone，并用 render 收尾。'
    : '';
  return `${head}
${stats}${ascii}${tiles}
请像美术总监一样**分区域**审视它：
- 形状比例是否正确？主体是否居中且占满画布？
- 配色是否协调？明暗是否有层次？
- 轮廓是否清晰？有没有明显的空洞、锯齿、错位？${pipelineHint}

如果还有改进空间，输出修正后的脚本（可逐轮逼近，不必一步到位）。
如果已经足够好，请只回复：DONE

${modeHint}`;
}

/** 把 tile 诊断渲染为紧凑文本 */
function formatTiles(tiles) {
  if (!tiles || !tiles.length) return '';
  const lines = tiles
    .filter((t) => t.changed > 0)
    .sort((a, b) => b.changed - a.changed)
    .slice(0, 8)
    .map((t) => `  · ${t.label} (${t.x},${t.y},${t.w}×${t.h})：改动 ${t.changed} px`
      + (t.dominant ? `，主色 ${t.dominant}` : ''));
  if (!lines.length) return '';
  return `\n分区域改动热区（优先关注改动最大处）：\n${lines.join('\n')}\n`;
}

/**
 * 计算 3×3 区域（tile）改动热区，供模型做局部定向修改。
 * @param {import('../core/buffer.js').PixelBuffer} before
 * @param {import('../core/buffer.js').PixelBuffer} after
 * @param {number} [grid]
 */
export function computeTiles(before, after, grid = 3) {
  if (!before || !after) return [];
  const w = after.width, h = after.height;
  const tw = Math.ceil(w / grid), th = Math.ceil(h / grid);
  const names = ['左上', '中上', '右上', '左中', '中心', '右中', '左下', '中下', '右下'];
  const tiles = [];
  for (let gy = 0; gy < grid; gy++) {
    for (let gx = 0; gx < grid; gx++) {
      const x = gx * tw, y = gy * th;
      const x1 = Math.min(w, x + tw), y1 = Math.min(h, y + th);
      let changed = 0;
      for (let yy = y; yy < y1; yy++) {
        for (let xx = x; xx < x1; xx++) {
          if (before.getPacked(xx, yy) !== after.getPacked(xx, yy)) changed++;
        }
      }
      const c = after.get(Math.min(w - 1, x + (tw >> 1)), Math.min(h - 1, y + (th >> 1)));
      tiles.push({
        label: names[gy * grid + gx] || `区域${gy * grid + gx}`,
        x, y, w: x1 - x, h: y1 - y, changed,
        dominant: c.a ? `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('')}` : '',
      });
    }
  }
  return tiles;
}

/** 语法/执行错误修复 */
export function buildRepair(report) {
  return `上一轮脚本执行时出现以下问题：
${report.errors.map((e) => `- ${e}`).join('\n')}
${report.warnings.length ? `\n提示：\n${report.warnings.map((w) => `- ${w}`).join('\n')}\n` : ''}
请修正这些错误后重新输出完整的 \`\`\`pixelscript 代码块。注意：
- 指令名与参数顺序必须与指令表完全一致
- 颜色必须使用 c0…c15、#rrggbb 或语义名
- 坐标必须是数字，不能是表达式`;
}

/** 收敛追踪提示（追加到每轮 critique） */
export function buildProgressNote(iterations) {
  if (iterations <= 0) return '';
  const tail = iterations.map((it) => `第${it.index}轮：改动 ${it.changed} 像素`).join('，');
  return `\n\n改动趋势：${tail}。若改动已很小，请直接回复 DONE。`;
}
