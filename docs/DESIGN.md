# 像素画笔 PixelScribe · 完整设计文档

> 让**不具备原生生图能力**的多模态大模型，通过「结构化绘制 + 视觉回灌 + 自我修正」闭环，
> 产出专业级像素美术作品。

- 版本：`1.0.0`
- 文档状态：定稿
- 关键词：PixelScript DSL · 视觉闭环 · 像素级可控 · 零构建 Web 应用

---

## 目录

1. [问题定义](#1-问题定义)
2. [核心洞察](#2-核心洞察)
3. [系统架构](#3-系统架构)
4. [PixelScript：绘制语言](#4-pixelscript绘制语言)
5. [视觉闭环协议](#5-视觉闭环协议)
6. [引擎设计](#6-引擎设计)
7. [AI 层设计](#7-ai-层设计)
8. [UI / UX 设计](#8-ui--ux-设计)
9. [服务端与安全](#9-服务端与安全)
10. [性能与成本模型](#10-性能与成本模型)
11. [能力边界与路线图](#11-能力边界与路线图)
12. [测试与验收](#12-测试与验收)

---

## 1. 问题定义

### 1.1 现实约束

主流多模态大模型的输出通道只有 **文本**（部分支持原生图像生成，但不可控、不可复现、
无法精确约束）。当用户要求"画一个 32×32 的火柴人精灵图"时：

| 模型类型 | 能力 | 缺陷 |
|---|---|---|
| 纯文本 LLM | 能描述，不能画 | 无输出通道 |
| 多模态 LLM（本方案目标） | 能**看图**，不能画 | 缺输出通道 |
| 扩散生图模型 | 能画 | 不可控、不可复现、像素画会糊、无法局部精确修改 |

**缺口**：多模态模型有"眼睛"（视觉输入）却没有"手"（结构化图像输出）。

### 1.2 朴素方案为何失败

最直觉的做法是让模型逐像素调用工具：

```
set_pixel(0,0,#FF0000)
set_pixel(1,0,#FF0000)
...  (64×64 = 4096 次)
```

**成本测算**：单次工具调用往返约 30–60 token，4096 次 ≈ 150k–250k token，
且延迟以分钟计、无法保证一致性、极易在中途丢失全局结构。

> 结论：**逐像素调用在工程上不可行**。需要把"像素"抽象成"模型说人话就能画的东西"。

### 1.3 设计目标

| 目标 | 指标 |
|---|---|
| 表达力 | 32×32 ~ 256×256 像素画、图标、sprite、UI 线框、示意图 |
| 成本 | 单张图 ≤ 4k token 输出 |
| 可控性 | 任意像素可精确指定；每次修改可复现 |
| 可迭代 | 模型能看着渲染结果自我修正，收敛 |
| 零依赖 | 浏览器原生 ES Module 运行，无需打包 |

### 1.4 非目标

- ❌ 写实照片级生成（这是扩散模型的主场，本项目不做无谓竞争）
- ❌ 高清复杂场景（>512×512）
- ❌ 视频 / 3D

---

## 2. 核心洞察

### 2.1 洞察一：光栅对 Transformer 不友好，符号才友好

Transformer 擅长的是**离散符号序列**。像素画天然是低分辨率、强结构、有限色板的数据，
把它编码成**紧凑符号指令**而不是像素矩阵，信息密度可提升 **100 倍以上**。

```
朴素：4096 次工具调用        ≈ 200,000 token
本方案：12 行 PixelScript   ≈ 180 token
```

### 2.2 洞察二：模型缺的是"手"，不是"脑"

多模态模型已经能**看懂**渲染出来的 PNG。因此：

```
模型写指令 → 引擎渲染 → PNG 回灌 → 模型自评 → 修指令 → ...
```

这个环路让模型从"一次性生成"变成"渐进式雕塑"。**这才是本方案不可替代的价值**——
扩散模型给不了这种"改左上角那个角"级别的可控性。

### 2.3 洞察三：先粗后细（Coarse-to-Fine）

模型在低分辨率下更容易掌握全局结构。流程：

```
Pass 1 (8×8 色块)   → 定构图
Pass 2 (16×16 细化) → 定形状
Pass 3 (32×32 精修) → 定细节、描边、高光
Pass 4 (回灌审查)   → 局部 patch
```

配合 `sym` 对称与 `outline` 描边等**高层图元**，能极大降低模型的空间推理负担。

### 2.4 洞察四：差分优于重绘

迭代时让模型只输出**改动部分**（新增/覆盖的指令行），而非整幅重画。
在 token 成本上再降一个数量级，同时避免"改一处崩全身"。

---

## 3. 系统架构

```
┌──────────────────────────────────────────────────────────────┐
│                         浏览器 (public/)                      │
│                                                              │
│  ┌────────────┐   ┌────────────┐   ┌──────────────────────┐  │
│  │  UI 层      │   │  引擎层     │   │  语言层               │  │
│  │ toolbar    │──▶│ document   │◀──│  compiler.js         │  │
│  │ panels     │   │ history    │   │  commands.js (24 op) │  │
│  │ chat       │   │ renderer   │   │  font5x7             │  │
│  │ tools      │   │ buffer     │   └──────────────────────┘  │
│  └────────────┘   │ palette    │              ▲               │
│        ▲          └────────────┘              │               │
│        │                                     │               │
│        │          ┌──────────────────────────┴───────────┐   │
│        └──────────│  AI 层                                │   │
│                   │  agent.js  (闭环状态机)               │   │
│                   │  prompts.js(系统提示 / DSL 内联)       │   │
│                   │  provider.js(OpenAI 兼容 + 视觉)      │   │
│                   └──────────────────┬───────────────────┘   │
└──────────────────────────────────────┼───────────────────────┘
                                       │ POST /api/chat (SSE)
┌──────────────────────────────────────▼───────────────────────┐
│                    server.mjs  (Node 22, 零依赖)              │
│  · 静态文件服务 (public/)                                     │
│  · LLM 反向代理：注入 API Key，规避 CORS                      │
│  · GET /api/config  返回能力探测（是否配置 Key / 模型名）      │
└──────────────────────────────────────────────────────────────┘
```

### 3.1 分层职责

| 层 | 文件 | 职责 | 禁止 |
|---|---|---|---|
| 语言层 | `js/lang/*` | 文本 → 绘图操作序列 | 不触碰 DOM，不触碰网络 |
| 引擎层 | `js/core/*` | 像素缓冲、图层、历史、渲染 | 不认识 AI，不认识 UI |
| AI 层 | `js/ai/*` | 组消息、调模型、抽脚本、驱动闭环 | 不直接改像素，只调用引擎 API |
| UI 层 | `js/ui/*` | 交互、状态同步、绘制视图 | 不含业务逻辑 |
| 服务端 | `server.mjs` | 静态托管 + 代理 | 无状态、不落盘用户数据 |

**单向依赖**：`ui → ai → core → lang`，反向引用一律通过回调/事件。

---

## 4. PixelScript：绘制语言

### 4.1 设计原则

1. **行式语法**（Line-oriented）：一行一条指令，便于模型逐行生成、逐行报错。
2. **位置参数**：不用 `key=value`，降低模型输出 token 与括号失配概率。
3. **容错解析**：单行错误不中止整个脚本，收集全部错误后回报模型。
4. **确定性**：随机相关指令（`noise`）必须显式 `seed`。
5. **颜色三态**：调色板索引 `c3` / 十六进制 `#ff004d` / 语义名 `red`。

### 4.2 指令总表（24 条）

#### 指令型（Directive）

| 指令 | 说明 |
|---|---|
| `size W H` | 画布尺寸，默认 32×32 |
| `palette NAME` / `palette #h #h ...` | 切换/自定义调色板 |
| `bg COLOR` | 用颜色填满当前图层 |
| `clear [COLOR]` | 清空为透明或指定色 |
| `sym off\|x\|y\|xy` | 后续绘制开启镜像对称 |
| `seed N` | 设定随机种子 |
| `name "标题"` | 文档标题 |

#### 绘制型（Draw）

| 指令 | 签名 | 说明 |
|---|---|---|
| `px` | `px X Y COLOR` | 单像素 |
| `hline` | `hline X Y LEN COLOR` | 水平线 |
| `vline` | `vline X Y LEN COLOR` | 垂直线 |
| `line` | `line X1 Y1 X2 Y2 COLOR [W]` | 任意直线（Bresenham） |
| `rect` | `rect X Y W H COLOR [stroke\|fill] [W]` | 矩形 |
| `rrect` | `rrect X Y W H R COLOR [stroke\|fill]` | 圆角矩形 |
| `circle` | `circle CX CY R COLOR [stroke\|fill]` | 圆 |
| `ellipse` | `ellipse CX CY RX RY COLOR [stroke\|fill]` | 椭圆 |
| `poly` | `poly COLOR [stroke\|fill] X1 Y1 X2 Y2 ...` | 多边形（变长参数） |
| `fill` | `fill X Y COLOR` | 洪水填充（4 连通） |
| `replace` | `replace OLD NEW` | 全图换色 |
| `outline` | `outline COLOR` | 为不透明区域描边 |
| `grad` | `grad X Y W H C1 C2 [v\|h]` | 线性渐变 |
| `dither` | `dither X Y W H C1 C2 [checker\|bayer\|h\|v] [SCALE] [RATIO]` | 有序抖动，RATIO 控制 C2 占比 |
| `noise` | `noise X Y W H COLOR [DENSITY] [SEED]` | 随机噪点 |
| `copy` | `copy SX SY W H DX DY` | 区域拷贝 |
| `flip` | `flip x\|y` | 整体翻转 |
| `rot` | `rot 90\|180\|270` | 整体旋转 |
| `erase` | `erase X Y W H` | 擦除为透明 |
| `adjust` | `adjust X Y W H light\|dark AMOUNT` | 区域明暗调整 |
| `text` | `text X Y COLOR "STRING" [SCALE]` | 5×7 位图字体 |

### 4.3 色板预设

| 名称 | 色数 | 用途 |
|---|---|---|
| `pico8` | 16 | 默认，复古像素风 |
| `gameboy` | 4 | Game Boy 绿 |
| `cga` | 16 | DOS / CGA |
| `gray` | 8 | 灰度素描稿 |
| `bw` | 2 | 纯黑白 |

### 4.4 示例

```
# 32x32 史莱姆
size 32 32
palette pico8
clear transparent
sym x

ellipse 16 20 11 8 c3 fill
ellipse 16 20 11 8 c11 fill
rect 6 19 21 1 c3
circle 11 16 2 c0 fill
circle 21 16 2 c0 fill
px 12 15 c7
px 22 15 c7
outline c1
```

### 4.5 执行报告（回灌给模型）

```json
{
  "ok": false,
  "ops": 9,
  "changed": 412,
  "errors": ["line 6: unknown color 'c19'"],
  "warnings": ["line 3: 'sym x' has no effect on this layer"]
}
```

---

## 5. 视觉闭环协议

### 5.1 状态机

```
        ┌───────────────────────────────────────────────┐
        │                                               │
   [IDLE] ──user brief──▶ [PLAN] ──script──▶ [EXECUTE]  │
                            ▲                    │       │
                            │                    ▼       │
                            │              ┌──────────┐  │
                            │              │ 有错误?    │  │
                            │              └────┬─────┘  │
                            │        是 │        │ 否     │
                            │           ▼        ▼       │
                            │      [REPAIR]  [RENDER]    │
                            │           │        │       │
                            │           └────────┤       │
                            │                    ▼       │
                            │              [CRITIQUE] ◀──┘
                            │                    │
                            │        ┌───────────┴─────────┐
                            │     DONE│                  │refine
                            └────────▶[FINISH]        [PATCH]─┘
```

### 5.2 消息序列（每轮）

| # | role | 内容 |
|---|---|---|
| 1 | system | 角色 + PixelScript 规范 + 绘制策略 + 输出格式约束 |
| 2 | user | 用户需求（文本） |
| 3 | assistant | ` ```pixelscript ... ``` ` |
| 4 | user | **图**（渲染 PNG dataURL） + 执行报告 + `请自评；完成则回复 DONE，否则输出修正脚本` |
| 5 | assistant | 新一轮脚本 或 `DONE` |
| … | … | 最多 `maxIterations` 轮 |

### 5.3 关键协议约定

- **只认围栏代码块**：` ```pixelscript ` 或 ` ```px `，其余文本视为思考过程（可展示不计入执行）。
- **整幅模式 vs 增量模式**：首轮整幅；后续默认增量（累加指令）。提示词中显式声明当前模式。
- **DONE 判定**：正则 `^\s*DONE\s*$`（大小写不敏感）出现在回复末尾。
- **视觉编码**：渲染结果放大到最近邻 `×N`（默认使长边 ≥ 256px），保证模型看清像素块。
  同时**附上文字版网格**（低分辨率时）以辅助空间定位：

```
渲染图 (256×256 PNG)
+ 网格文本（≤ 24×24 时附带）：
  c0 = #000000, c3 = #008751 ...
  ................
  .....333333.....
  ....33333333....
```

### 5.4 收敛控制

- 迭代上限 `maxIterations`（默认 6）。
- 若连续两轮 `changed < 阈值`（默认 8 像素）→ 视为收敛，自动结束。
- 每轮完整快照入历史栈，用户可回退到任意轮次。

---

## 6. 引擎设计

### 6.1 像素缓冲 `PixelBuffer`

- 底层 `Uint8ClampedArray(w*h*4)`，RGBA，**非预乘**。
- 所有图元在缓冲上以整数运算绘制；抗锯齿**关闭**（像素画必须硬边）。
- 合成规则：源 `src-over`，`alpha < 255` 时按标准 Alpha 混合。
- 提供：`get/set`、`fillRect`、`blit`、`snapshot/restore`、`toImageData`。

### 6.2 文档模型 `PixelDocument`

```
PixelDocument
 ├─ width, height
 ├─ palette: Palette
 ├─ layers: Layer[]        // { name, buffer, visible, opacity, locked }
 ├─ activeLayerIndex
 ├─ symmetry: 'off'|'x'|'y'|'xy'
 └─ dirty: boolean
```

- 合成：自底向上按 `opacity` 叠加到 `composite` 缓冲。
- 单图层模式是默认（减少模型认知负担）；图层能力保留给人工精修。

### 6.3 历史 `History`

- 快照式，存储受影响图层的 `Uint8ClampedArray` 拷贝。
- 32×32 → 4 KB/步；128×128 → 64 KB/步；上限 120 步（可配）。
- 事务：`history.begin(label)` / `commit()` / `rollback()`，一次 AI 轮次 = 一个事务。

### 6.4 渲染器 `Renderer`

- 离屏 `OffscreenCanvas`（回退 `<canvas>`）承载 `putImageData`。
- 屏幕绘制：`drawImage(offscreen, 0,0,w,h, 0,0,w*scale,h*scale)`，
  `imageSmoothingEnabled = false`。
- 附加层：棋盘透明底、像素网格、对称轴、选区框、光标高亮。
- 视口：`scale ∈ [1, 64]`，`offset` 平移，支持滚轮缩放 + 空格拖拽。
- 导出：长边放大到目标尺寸的最近邻 PNG（默认 512，可选 128/256/512/1024）。

---

## 7. AI 层设计

### 7.1 Provider（OpenAI 兼容）

- 端点：`POST {baseUrl}/chat/completions`
- 支持 **流式 SSE**（`stream: true`），逐 token 回调 UI。
- 多模态消息：

```json
{ "role": "user", "content": [
  { "type": "text", "text": "这是当前渲染结果..." },
  { "type": "image_url", "image_url": { "url": "data:image/png;base64,..." } }
]}
```

- 兼容目标：OpenAI / DeepSeek / 通义 / Moonshot / 智谱 / OpenRouter / Ollama / vLLM / LM Studio。
- 无 Key 时降级为**本地演示模式**：使用内置规则模板生成脚本（保证 UI 可完整体验）。

### 7.2 Prompt 工程

系统提示词由三块拼装（见 `js/ai/prompts.js`）：

1. **身份与任务**：你是像素美术引擎的指令生成器。
2. **语言规范**：完整 PixelScript 指令表 + 颜色语法 + 3 个范例。
3. **绘制策略**：
   - 先规划调色板（≤ 6 色）
   - 先大形状后细节
   - 对称物体用 `sym`
   - 用 `outline` 增强轮廓可读性
   - 阴影用同色系深色 + `dither`
   - **不要**试图逐像素描摹
4. **输出契约**：仅输出一个 ` ```pixelscript ` 块；除脚本外最多一句说明。

**迭代轮**追加：当前渲染图 + 报告 + 收敛指令。

### 7.3 Agent 闭环实现

```js
async function run(agent) {
  for (let i = 0; i < max; i++) {
    const reply = await provider.chat(messages);      // 流式
    const script = extractScript(reply);              // 围栏提取
    if (isDone(reply)) break;
    const report = interpreter.run(script, doc);      // 执行
    const actuallyChanged = report.changed;           // 差异像素数
    if (report.errors.length) { messages.push(repair(report)); continue; }
    const png = renderer.exportDataURL(doc);          // 图元编码
    messages.push(critique(png, report, mode));       // 视觉回灌
    if (actuallyChanged < EPS && i > 0) break;        // 收敛
  }
}
```

- 全程 `AbortController` 可中断。
- 每轮把 `{ iteration, script, report, dataURL }` 写入 UI 时间线。

---

## 8. UI / UX 设计

### 8.1 布局

```
┌─────────────────────────────────────────────────────────────────┐
│ HEADER  PixelScribe · [标题] · 32×32   ↶ ↷  缩放  导入 导出  AI●   │
├──────┬──────────────────────────────────────────┬───────────────┤
│ 工具  │                                          │  右侧面板      │
│ 栏    │            画布视口                       │  ┌─ AI ─┐     │
│      │        （棋盘底 + 网格 + 对称轴）          │  │ 对话  │     │
│ ✏ ▭ ○ │                                          │  │ 迭代  │     │
│ 🪣 💧 ▢│                                          │  ├─ 脚本─┤     │
│      │                                          │  │ 编辑器 │     │
│ 调色板 │                                          │  ├─ 图层─┤     │
│ ▪▪▪▪ │                                          │  │ 列表  │     │
│ ▪▪▪▪ │                                          │  └───────┘     │
├──────┴──────────────────────────────────────────┴───────────────┤
│ STATUS  (16, 20) · c3 #008751 · 128 px · 轮次 2/6 · 已保存        │
└─────────────────────────────────────────────────────────────────┘
```

### 8.2 工具

| 工具 | 快捷键 | 说明 |
|---|---|---|
| 铅笔 | `B` | 左键主色 / 右键副色 |
| 橡皮 | `E` | 擦为透明 |
| 油漆桶 | `G` | 洪水填充（含容差） |
| 吸管 | `I` | 取色（Alt 临时） |
| 直线 | `L` | 拖拽预览 |
| 矩形 | `R` | Shift 正方形 |
| 椭圆 | `O` | Shift 正圆 |
| 选区 | `M` | 移动/删除选区内容 |
| 平移 | `空格` | 拖拽画布 |

**通用**：`Ctrl+Z/Y` 撤销重做，`X` 交换主副色，`+/-` 缩放，`0` 适配窗口，
`G` 网格开关（`Ctrl+G`），`1–8` 快速取色。

### 8.3 右侧面板

- **AI 面板**：需求输入框、模型/温度/迭代次数设置、发送/中止、流式思考区、
  每轮缩略图 + 改动统计 + "回退到本轮"按钮。
- **脚本面板**：PixelScript 代码编辑器（行号、高亮、错误行标红），
  运行 / 格式化 / 复制 / 示例库。
- **图层面板**：新增/删除/重排/可见性/透明度/合并。
- **调色板面板**：点击编辑色块、预设切换、从图中提取色板。

---

## 9. 服务端与安全

### 9.1 `server.mjs`（Node 22，零 npm 依赖）

| 路由 | 方法 | 说明 |
|---|---|---|
| `/` | GET | 静态文件（`public/`，含 MIME 映射与路径穿越防护） |
| `/api/config` | GET | `{ keyConfigured, baseUrl, model, demoMode }`，**不含 Key** |
| `/api/chat` | POST | 反向代理到 LLM，支持 SSE 透传与中断 |

### 9.2 安全要点

- API Key **仅存于服务端环境变量**，永不下发浏览器。
- 路径穿越防护：解析后必须仍在 `public/` 前缀内。
- 请求体上限 8 MB（图像 base64 可能较大）。
- 无鉴权设计用于**本机开发**；如需公网部署，见 README 的加固清单。
- 前端直连模式（用户在 UI 填 Key）仅存 `sessionStorage`，关页即失。

---

## 10. 性能与成本模型

### 10.1 Token 成本对比（32×32 单图）

| 方案 | 输出 token | 相对成本 |
|---|---|---|
| 逐像素工具调用 | ~196,000 | 1000× |
| 逐像素文本行（`px x y c`） | ~12,000 | 60× |
| 行字符串（每行 32 字符） | ~5,000 | 25× |
| **PixelScript 图元** | **~180** | **1×** |
| PixelScript + 增量迭代（4 轮） | ~700 | 3.6× |

### 10.2 延迟预算

| 阶段 | 目标 |
|---|---|
| 本地指令执行（32×32，50 条） | < 3 ms |
| 渲染 + 放大导出 | < 8 ms |
| 单轮模型往返 | 由 provider 决定（流式首 token < 1.5 s） |
| 完整闭环（4 轮） | 20–60 s |

---

## 11. 能力边界与路线图

### 11.1 强项（当前版本即达专业可用）

- 像素精灵 / 角色 / 道具（16×16 ~ 64×64）
- 游戏 UI 图标、道具图标
- 极简插画、表情、徽章、Logo 草稿
- 数据示意图 / 逻辑图 / 地图草稿
- 任意"低分辨率 + 有限色板"的领域

### 11.2 弱项（不承诺）

- 写实照片、复杂光照、材质
- 高分辨率（>256×256）细节丰富场景
- 文字排版（仅有 5×7 位图字体）

### 11.3 路线图

| 版本 | 内容 |
|---|---|
| v1.0 | 本版本：DSL + 引擎 + 视觉闭环 + Web UI |
| v1.1 | 图层感知的 AI 增量编辑、脚本 diff 合并、色板提取 |
| v1.2 | 动画帧序列（spritesheet）、ONION 洋葱皮、GIF/Aseprite 导出 |
| v1.3 | 局部选区重绘（inpainting 式）、参考图 img2pixel 转换 |
| v2.0 | 多智能体协作（构图师 / 上色师 / 审查师）、SVG 分支后端 |

---

## 12. 测试与验收

### 12.1 自动化自测

`npm run selftest` 覆盖：

1. **语言层**：24 条指令逐条执行不报错；非法输入产出预期错误行号。
2. **引擎层**：对称、洪水填充、描边、翻转、旋转的像素级断言。
3. **导出**：PNG 魔数、尺寸、最近邻放大正确性。
4. **端到端**：内置范例脚本渲染 → 校验非空像素占比 → 落到 `out/test/`。

### 12.2 人工验收清单

- [ ] 输入"画一个 32×32 的史莱姆"，AI 闭环 ≤ 6 轮产出可辨识作品
- [ ] 中途"中止"按钮立即生效
- [ ] 任意轮次可回退且像素完全一致
- [ ] 导出的 PNG 在 Aseprite / 系统查看器中正常打开
- [ ] 无 Key 环境下演示模式可用，界面无报错
- [ ] 刷新页面后文档可从 localStorage 恢复

---

## 附录 A：文件清单

```
像素画笔/
├─ README.md                  使用说明
├─ package.json               脚本与元数据（无 runtime 依赖）
├─ server.mjs                 静态服务 + LLM 代理
├─ .env.example               环境变量模板
├─ .gitignore
├─ docs/
│  ├─ DESIGN.md               本文档
│  └─ DSL.md                  PixelScript 完整参考
├─ public/
│  ├─ index.html
│  ├─ styles/app.css
│  └─ js/
│     ├─ main.js              启动与装配
│     ├─ samples.js           内置示例库
│     ├─ util/color.js        颜色解析 / 转换 / Alpha 混合
│     ├─ io/png.js            纯 JS PNG 编码器（零依赖，浏览器/Node 通用）
│     ├─ core/
│     │  ├─ palette.js        调色板与预设
│     │  ├─ buffer.js         像素缓冲与光栅化图元
│     │  ├─ document.js       文档 / 图层 / 合成
│     │  ├─ history.js        撤销栈
│     │  └─ renderer.js       视口渲染与导出
│     ├─ lang/
│     │  ├─ font5x7.js        位图字体
│     │  └─ compiler.js       PixelScript 解析与执行
│     ├─ ai/
│     │  ├─ provider.js       LLM 客户端（流式 + 视觉）
│     │  ├─ prompts.js        提示词工程
│     │  ├─ demo.js           离线演示 Provider 与模板库
│     │  └─ agent.js          视觉闭环状态机
│     └─ ui/
│        ├─ dom.js            DOM 小工具（$ / el / modal / toast）
│        ├─ app.js            应用控制器（装配层）
│        ├─ tools.js          画布交互
│        ├─ panels.js         图层 / 色板 / 脚本面板
│        └─ chat.js           AI 面板与轮次时间线
└─ test/
   ├─ selftest.mjs            单元 / 集成自测（143 项）
   └─ dom-smoke.mjs           jsdom 无头 UI 冒烟测试（53 项）
```

## 附录 C：测试矩阵

| 套件 | 命令 | 覆盖 |
|---|---|---|
| 单元 / 集成 | `npm run test:unit` | 颜色、调色板、缓冲图元、文档、历史、28 条指令、语法预检、回复解析、PNG 编解码、AI 提示词、字体、端到端范例渲染、**真实 HTTP 视觉闭环**、中止传播 |
| UI 冒烟 | `npm run test:dom` | jsdom 中真实启动应用：工具栏、对称、缩放、调色板、图层、画布指针绘制、选区、撤销重做、快捷键、脚本运行、模态框、AI 演示闭环、持久化、导出 |
| 全部 | `npm test` | 上述两者，任一失败即退出非零 |


## 附录 B：术语表

| 术语 | 含义 |
|---|---|
| PixelScript | 本项目的像素绘制 DSL |
| 回灌 | 把渲染结果作为图像输入再送给模型 |
| 收敛 | 连续轮次改动像素数低于阈值 |
| 图元 | line/rect/circle 等高层几何绘制指令 |
| 整幅 / 增量 | 每轮重画全部 / 只追加改动指令 |
