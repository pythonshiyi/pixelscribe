/**
 * 提示词工程
 * ---------------------------------------------------------------
 * 三块拼装：身份 → 语言规范 → 绘制策略 → 输出契约。
 * 目标是让模型**一次写对** PixelScript，并在迭代中看懂渲染结果。
 */

import { dslReference } from '../lang/compiler.js';

/**
 * @param {{width:number,height:number,paletteName:string,paletteSize:number,
 *          title:string,paletteLegend?:string}} docInfo
 * @returns {string}
 */
export function buildSystemPrompt(docInfo) {
  const legend = docInfo.paletteLegend
    ? `\n调色板速查（索引=色值(名称)）：${docInfo.paletteLegend}\n`
    : '';
  return `你是「像素画笔」的绘制指令生成器。你无法直接输出图片，只能通过编写 PixelScript
代码来作画；引擎会立即执行并把你画的图渲染成 PNG 回传给你看。

# 画布
当前尺寸 ${docInfo.width}×${docInfo.height}，坐标原点在左上角，x 向右、y 向下。
调色板：${docInfo.paletteName}（可用颜色索引 c0 … c${docInfo.paletteSize - 1}）。${legend}
# PixelScript 指令表
${dslReference()}

# 颜色写法
- 调色板索引：c0 c1 c2 …（优先使用，能保证画面色彩统一）
- 十六进制：#f00 / #ff004d / #ff004d80
- 语义名：red blue white darkgreen … / transparent

# 绘制策略（非常重要）
1. **不要逐像素描摹**。用 ellipse / circle / rect / poly / grad 等图元组合出形状。
2. 先定 3–6 种颜色的配色，再定大形，最后补细节。
3. 对称物体（角色、道具、徽章）务必使用 sym x 或 sym xy，可减少一半指令并保证对称。
4. 最后用 outline c0 或 outline c1 描边，可显著提升可读性。
5. 阴影用同色系更深的颜色 + dither 抖动，而不是直接用黑。
6. 高光用 adjust 提亮或直接用小面积浅色。
7. 所有绘制坐标必须在 0 … ${docInfo.width - 1} / 0 … ${docInfo.height - 1} 范围内。
8. 圆/椭圆半径取画布尺寸的 1/4 ~ 1/3 通常比较好看。

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
  return `请画：${brief}

画布 ${docInfo.width}×${docInfo.height}。直接输出一个 \`\`\`pixelscript 代码块。`;
}

/**
 * 迭代轮：把渲染图 + 执行报告回灌
 * @param {{iteration:number, max:number, mode:'replace'|'append', report:any, ascii?:string, hasImage:boolean}} info
 */
export function buildCritique(info) {
  const { iteration, max, mode, report } = info;
  const head = `这是你上一轮脚本渲染出来的结果（第 ${iteration}/${max} 轮）。`;
  const stats = `执行报告：${report.ops} 条指令成功，改动 ${report.changed} 个像素。`;
  const ascii = info.ascii ? `\n低分辨率网格预览（每个字符代表一个色块，. 为透明）：\n${info.ascii}\n` : '';
  const modeHint = mode === 'append'
    ? '下一轮请输出**增量**脚本：只写需要新增或覆盖的指令（不要重画全部内容）。'
    : '下一轮如果修改，请输出完整的整幅脚本。';
  return `${head}
${stats}${ascii}
请像美术总监一样审视它：
- 形状比例是否正确？主体是否居中且占满画布？
- 配色是否协调？明暗是否有层次？
- 轮廓是否清晰？有没有明显的空洞、锯齿、错位？

如果还有改进空间，输出修正后的脚本（可以逐轮逼近，不必一步到位）。
如果已经足够好，请只回复：DONE

${modeHint}`;
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
