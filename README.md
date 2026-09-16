# 像素画笔 · PixelScribe

> 让**不具备生图能力**的多模态大模型，通过「PixelScript 绘制语言 + 视觉回灌 + 自我修正」
> 闭环，产出专业级像素美术。

---

## 这是什么

大模型的输出通道只有文本。你让它"画个史莱姆"，它只能描述，不能画。

朴素的解法是让它逐像素调用工具——64×64 就是 4096 次调用、约 20 万 token，**不可行**。

PixelScribe 换了个思路：

```
模型写 PixelScript  →  引擎秒级渲染  →  PNG 回灌给模型  →  模型自评  →  改脚本  → ...
         180 token            3 ms                 它真能看懂           收敛
```

模型缺的从来不是"脑"，而是"手"。本项目就是给它一只手。

---

## 30 秒上手

```bash
# 1. 配置模型（可选，不配也能跑演示模式）
cp .env.example .env
#   编辑 .env，填 PX_BASE_URL / PX_API_KEY / PX_MODEL

# 2. 启动
npm start

# 3. 打开
#    http://localhost:5173
```

无任何 npm 依赖，Node 20+ 即可。

> 开发测试需要 `npm install` 安装 jsdom（仅 devDependency），运行应用本身不需要。

---

## 核心特性

| 特性 | 说明 |
|---|---|
| **PixelScript DSL** | 28 条紧凑绘图指令，一行一条，模型一次写对 |
| **视觉闭环** | 渲染图回灌 → 模型看着自己的画自我修正，支持 6 轮迭代 |
| **成本降低 1000×** | 图元指令 vs 逐像素调用，单图约 180 token |
| **精确可控** | 任意像素可指定；每次生成完全可复现（含随机种子） |
| **专业编辑器** | 图层、撤销栈、对称绘制、调色板、洪水填充、抖动、描边 |
| **零构建** | 原生 ES Module，改完代码刷新生效 |
| **多供应商** | OpenAI / DeepSeek / 通义 / 智谱 / Moonshot / OpenRouter / Ollama / LM Studio |
| **密钥安全** | Key 只留服务端，永不下发浏览器 |

---

## PixelScript 长什么样

```
# 32x32 史莱姆
size 32 32
palette pico8
clear transparent
sym x

ellipse 16 20 11 8 c3 fill
ellipse 16 20 11 8 c11 fill
circle 11 16 2 c0 fill
circle 21 16 2 c0 fill
px 12 15 c7
px 22 15 c7
dither 8 22 16 4 c11 c3 checker
outline c1
```

28 条指令，覆盖点、线、矩形、圆角矩形、圆、椭圆、多边形、洪水填充、
全图换色、描边、渐变、抖动、噪声、拷贝、翻转、旋转、明暗调整、位图文字。

完整参考见 [`docs/DSL.md`](docs/DSL.md)。

---

## 目录结构

```
像素画笔/
├─ server.mjs               静态服务 + LLM 代理（零依赖）
├─ .env.example             环境变量模板
├─ docs/
│  ├─ DESIGN.md             完整设计文档（架构 / 协议 / 成本模型 / 路线图）
│  └─ DSL.md                PixelScript 语言参考
├─ public/
│  ├─ index.html
│  ├─ styles/app.css
│  └─ js/
│     ├─ main.js            启动
│     ├─ samples.js         内置示例库
│     ├─ util/color.js      颜色解析 / 转换 / Alpha 混合
│     ├─ io/png.js          纯 JS PNG 编码器（浏览器 / Node 通用）
│     ├─ core/              引擎：palette buffer document history renderer
│     ├─ lang/              compiler（解析+执行） + font5x7
│     ├─ ai/                provider（流式+视觉） prompts demo agent（闭环）
│     └─ ui/                dom app tools panels chat
└─ test/
   ├─ selftest.mjs          单元 / 集成自测（143 项，含真实 HTTP 闭环）
   └─ dom-smoke.mjs         jsdom 无头 UI 冒烟测试（53 项）
```

---

## 使用指南

### 手动绘制
左侧工具栏选工具，右侧调色板选色，直接画。
快捷键：`B` 铅笔 `E` 橡皮 `G` 桶 `I` 吸管 `L` 线 `R` 矩形 `O` 椭圆 `M` 选区
`空格` 平移 `X` 交换主副色 `+/-` 缩放 `Ctrl+Z/Y` 撤销重做 `Ctrl+G` 网格。

### AI 生成
右侧 **AI 面板** → 输入需求（如 "32×32 的火焰史莱姆，三帧循环配色"）→ 发送。
模型每轮产出脚本，引擎渲染后回灌，最多 6 轮或收敛为止。
每个轮次都留缩略图，可一键**回退到该轮**。

### 脚本模式
右侧 **脚本面板** 直接手写 PixelScript，点「运行」。
错误行会标红并给出 `line N: message`。

### 导出
- **PNG**：最近邻放大到 128/256/512/1024，保留硬边
- **PixelScript**：`.pxs` 文本，可入版本库，可复现
- **色板**：从当前图像提取

---

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PX_BASE_URL` | `https://api.openai.com/v1` | OpenAI 兼容端点 |
| `PX_API_KEY` | *(空)* | 留空则进入演示模式 |
| `PX_MODEL` | `gpt-4o-mini` | **必须是支持视觉输入的模型** |
| `PX_PORT` | `5173` | 服务端口 |
| `PX_TEMPERATURE` | `0.6` | 采样温度 |
| `PX_MAX_ITERATIONS` | `6` | 闭环最大轮次 |
| `PX_VISION_LONG_EDGE` | `384` | 回灌图长边像素 |
| `PX_TIMEOUT_MS` | `120000` | 上游超时 |

推荐的视觉模型：`gpt-4o` / `gpt-4o-mini` / `qwen-vl-max` / `glm-4v` /
`gemini-2.0-flash` / `moonshot-v1-8k-vision-preview` / `llava`（本地）。

---

## 测试

```bash
npm test           # 单元 + 集成 + 无头 UI 冒烟（共 196 项）
npm run test:unit  # 仅单元 / 集成（无需浏览器，含真实 HTTP 闭环）
npm run test:dom   # 仅 jsdom 无头 UI 冒烟
```

`test/selftest.mjs` 覆盖：颜色、调色板、像素缓冲图元、文档与图层、撤销栈、
**28 条指令逐条执行**、错误行定位、语法预检、模型回复解析、PNG 编解码（zlib 校验）、
提示词工程、位图字体、内置范例端到端渲染，以及一个**跑在真实 HTTP 上的视觉闭环**
（Mock 模型 → 流式 SSE → 执行 → 回灌图像 → DONE → 中止传播）。

`test/dom-smoke.mjs` 在 jsdom 中真实启动整个应用并模拟用户操作：
工具栏、对称、缩放、调色板、图层、画布指针绘制、选区、撤销重做、快捷键、
脚本运行、全部模态框、AI 演示闭环、localStorage 持久化、PNG 导出。

产物落在 `out/test/`。

---

## 能力边界

**强**：像素精灵、图标、道具、徽章、极简插画、UI 线框、示意图、地图草稿。
**弱**：写实照片、复杂光照、>256×256 的细节丰富场景。

这不是通用生图模型的替代品，而是它在**受限高精度域**的补集。

---

## 公网部署加固清单

本服务默认面向本机开发。若需公网部署，请至少：

1. 增加鉴权（Basic / Token），限制 `/api/chat` 调用频率
2. 收紧 `PX_TIMEOUT_MS` 与 `MAX_BODY`
3. 置于反向代理（Nginx/Caddy）之后并启用 HTTPS
4. 设置 `PX_API_KEY` 的用量上限与告警
5. 关闭前端直连模式，强制走服务端代理

---

## 许可

MIT
