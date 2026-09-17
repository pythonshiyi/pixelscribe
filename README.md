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
# 1. 进入项目目录
cd pixelscribe

# 2. 配置模型（可选，跳过则进入离线演示模式）
cp .env.example .env        # Windows: copy .env.example .env
#   编辑 .env，填 PX_BASE_URL / PX_API_KEY / PX_MODEL

# 3. 启动
npm start

# 4. 浏览器打开
#    http://localhost:5173
```

启动后终端会打印监听地址与当前模式。按 `Ctrl+C` 停止。

无任何 npm 依赖，**Node 20+ 即可运行**，不需要 `npm install`。

> 开发测试需要 `npm install` 安装 jsdom（仅 devDependency），运行应用本身不需要。

### 常见启动问题

| 现象 | 原因与处理 |
|---|---|
| 端口被占用 | 改 `.env` 里的 `PX_PORT`，或 `set PX_PORT=8080 && npm start` |
| 终端中文/边框乱码 | Windows 旧控制台请先执行 `chcp 65001` 切到 UTF-8 |
| 提示"演示模式" | 未读到 `PX_API_KEY`。确认 `.env` 与 `server.mjs` 同目录 |
| 页面空白 | 必须通过 `http://localhost:5173` 访问；直接双击 `index.html`（`file://`）会被浏览器拦截 ES Module |
| 模型报 401 / 404 | 检查 `PX_API_KEY` 是否有效；`PX_BASE_URL` 填 `.../v1` 或完整 `.../v1/chat/completions` 都可以（自动归一化）；确认 `PX_MODEL` 是**支持视觉输入**的模型 |
| 报 400 `MissingSessionID` | 用了 OpenCode Go/Zen 但没有会话头——本程序已自动注入 `x-opencode-session`，若仍报错请确认端点域名含 `opencode.ai` |
| 模型不认 `thinking`（400） | 已自动去掉该字段重试；也可设 `PX_THINKING=auto` 或 `disabled` |
| AI 面板提示「纯文本审查」 | 当前模型/网关不接受图片输入，已自动降级继续作画（可用 `PX_VISION=off` 永久关闭回灌） |

---

## 手动指定端口 / 临时覆盖配置

```bash
# Windows PowerShell
$env:PX_PORT=8080; npm start

# macOS / Linux
PX_PORT=8080 npm start
```

---

## 核心特性

| 特性 | 说明 |
|---|---|
| **PixelScript DSL** | 43 条紧凑指令，一行一条，模型一次写对 |
| **程序化写实渲染** | `light`/`relief`/`specular`/`bloom`/`tone`/`fbm` —— 零依赖把平涂推进到有体积、材质与光照的写实层次 |
| **风格一等公民** | `style pixel\|painting\|ink\|anime\|3d\|photo`，同一套流水线覆盖像素风到照片级 |
| **可选神经后端** | 配置 `PX_RENDER_URL` 后，写实风格可调用扩散/img2img 后端（ControlNet 条件来自 DSL 控制图）；不可用自动降级，闭环不中断 |
| **控制图导出** | 边缘 / 深度 / 法线 / 遮罩四种控制图，供神经后端精确锚定构图 |
| **神经残差层** | 程序层保持可复现、可编辑，高熵细节写入独立残差层，兼顾写实与可控 |
| **局部重绘** | `inpaint` / 选区「局部重绘」只细化目标区域，其余像素不动（神经 inpaint，无后端则程序化细化） |
| **参考图转像素** | 导入任意图片：面积平均/最近邻降采样 + 调色板量化 + Floyd/Bayer 抖动 + 边缘增强 |
| **多后端路由** | `PX_RENDER_URL` / `PX_INPAINT_URL` / `PX_UPSCALE_URL` 按任务路由到各自的神经后端 |
| **动画帧** | 帧条增删/复制/排序/选择、播放预览、**洋葱皮**（前后帧半透明叠加）、**AI 生成 N 帧循环动画** |
| **参考图引导** | 导入图片为参考层（不烘焙进成图），作为神经后端的 ControlNet 式引导 |
| **大画布** | 画布最高 **2048²**；**百分比坐标**（`50%`）让模型不必心算大数字 |
| **大画布回灌** | 画布超过阈值时，除整图外额外回灌**改动热区的原分辨率裁剪图**，让模型真正看见细节 |
| **平滑超分导出** | 双线性 + 锐化 + 微纹理，把低分辨率画布"author small, render big"成写实大图 |
| **大文档存储** | 自动保存优先写 **IndexedDB**（超 localStorage 配额也能存），回退 localStorage/内存 |
| **导出多格式** | PNG / PixelScript，以及 **精灵表 PNG**、**GIF89a**（自带 LZW）、**Aseprite `.aseprite`** |
| **白天主题** | 文档风浅色配色（纸感底 + 中性灰 + 像素粉/文档蓝），一键切换、记忆偏好 |
| **作品库** | 生成物自动落盘到 `workspace/gallery`，内置面板可查看/下载/删除/打开文件夹 |
| **视觉闭环** | 渲染图回灌 → 模型看着自己的画自我修正，支持 6 轮迭代 + 区域热区诊断 + 导演模式 |
| **成本降低 1000×** | 图元指令 vs 逐像素调用，单图约 180 token |
| **精确可控** | 任意像素可指定；每次生成完全可复现（含随机种子） |
| **专业编辑器** | 图层、撤销栈、对称绘制、调色板、洪水填充、抖动、描边 |
| **零构建** | 原生 ES Module，改完代码刷新生效 |
| **多供应商** | DeepSeek Vision / OpenAI / 通义 / 智谱 / Moonshot / OpenRouter / Ollama / LM Studio |
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

43 条指令，覆盖点、线、矩形、圆角矩形、圆、椭圆、多边形、洪水填充、
全图换色、描边、渐变、抖动、噪声、拷贝、翻转、旋转、明暗调整、位图文字，
精细化的贝塞尔曲线 `curve`、圆弧 `arc`、同色系 `shade`、立体浮雕 `bevel`、
抖动渐变 `graddither`，以及程序化写实渲染的 `style`、方向光 `light`、
浮雕受光 `relief`、镜面高光 `specular`、辉光 `bloom`、模糊 `blur`、
相机色调映射 `tone`、分形材质 `fbm`、渲染管线 `render`。

写实风格示例：

```
# 写实光影（程序化先验）
size 32 32
palette pico8
clear transparent
style photo
bg c1
light -1 -1 1 1
fbm 0 0 32 32 c1 c5 4 8 mod
circle 16 15 9 c9 fill
circle 16 15 8 c10 fill
shade 8 7 16 16 c4 0.25
outline c0
render photo
```

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
│     ├─ io/gif.js          纯 JS GIF89a 编码器（LZW，多帧/透明/循环）
│     ├─ io/aseprite.js     极简 Aseprite 写出器（单图层 + raw cel）
│     ├─ io/img2pixel.js    参考图 → 像素画（降采样 / 量化 / 抖动 / 边缘）
│     ├─ io/store.js        大文档持久化（IndexedDB → localStorage → 内存）
│     ├─ core/              引擎：palette buffer document history renderer animation
│     │                     effects（程序化光照/材质/色调） backends（控制图/裁剪/后端路由）
│     │                     supersample（平滑超分）
│     ├─ lang/              compiler（解析+执行） + font5x7
│     ├─ ai/                provider（流式+视觉） prompts demo agent（闭环+导演）
│     └─ ui/                dom app tools panels chat gallery
└─ test/
   ├─ selftest.mjs          单元 / 集成自测（232 项，含百分比坐标、超分、大画布分块回灌与 GIF/Aseprite 编码）
   └─ dom-smoke.mjs         jsdom 无头 UI 冒烟测试（69 项）
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

### 写实 / 风格渲染
AI 面板的「风格」下拉支持 `像素 / 手绘 / 水墨 / 动画 / 3D / 写实照片`。
选择非像素风格后：

1. 首轮先铺正确的大色块与明暗（构图骨架）；
2. 用 `light` 声明方向光，`relief`/`specular` 塑造体积与高光，`fbm` 生成材质，
   `bloom` 做高光溢出，`tone` 做相机色调；
3. `render <style>` 触发渲染管线——引擎把结果写入**神经残差层**，程序层保持可复现、可编辑。

若配置了 `PX_RENDER_URL`（img2img / ControlNet 后端），写实风格会把底图 + 控制图
（边缘/深度/法线）发给后端补全高频细节；后端不可用时自动降级为内置程序化管线，闭环不中断。
勾选「导演模式」可先让模型做构图/光照规划，再写脚本，提升复杂画面的稳定性。

### 局部重绘
用选区工具（`M`）框选要修改的区域，在需求框写下描述，点 AI 面板的 **局部重绘**。
引擎只重绘该区域：

- 配置了 `PX_INPAINT_URL`（或 `PX_RENDER_URL`）→ 生成蒙版调用神经 inpaint；
- 未配置 → 用程序化先验（`relief`/`tone`）对区域局部细化。

脚本中也可写 `inpaint X Y W H "PROMPT" [STRENGTH]`，由闭环消费。
整幅结构保持不变——这是「改左上角那个角」级别的可控性。

### 参考图转像素
`导入` 选择任意图片，对话框里可选：

- **采样**：面积平均（平滑）或最近邻（保硬边）；
- **抖动**：无 / Floyd–Steinberg（照片级过渡）/ Bayer（像素风）；
- **吸附调色板**：量化到当前色板；**渐隐阈值**：剔除半透明脏边。

结果按最大边等比缩放并居中写入当前图层。

### 大画布与超分
- 新建画布可选 **16–1024**；DSL `size` 上限 **2048²**；AI 面板画布最大 512。
- **用百分比坐标**：`ellipse 50% 55% 30% 22% c9 fill`——x 按宽、y 按高、半径按长边换算，
  模型在大画布上不必心算像素值，指令遵循更稳。
- **平滑超分导出**：导出对话框勾选「平滑超分」，引擎用双线性 + 锐化 + 微纹理放大，
  得到写实/绘画风格的大图（像素风请关闭，保持最近邻硬边）。
- 画布超过 160px 时，闭环会额外回灌**改动最大区域的原始分辨率裁剪图**，弥补视觉 token 上限。

### 动画与导出
画布底部的**帧条**：

- `＋` 新增空白帧、`⧉` 复制当前帧、`🗑` 删除、`▶` 播放/暂停、`◍` 切换洋葱皮、右侧调 `fps`；
- 点击缩略图切换帧；洋葱皮会把前一帧（红）后一帧（蓝）半透明叠加，方便对齐动作。

`导出` 对话框提供：PNG、`.pxs` 脚本、**精灵表 PNG**（横向排列所有帧）、
**GIF**（无限循环，帧率取 fps）、**Aseprite**（单图层多帧，可直接继续编辑）。

**AI 生成多帧**：在 AI 面板把「帧数」设为 N（>1），模型会先生成第 1 帧，
再逐帧基于上一帧的渲染图做增量修改，自动写入帧序列。配合「导演模式」效果更稳。

**参考图引导**：`导入` 图片时勾选「作为 AI 参考层」——图片以 40% 透明度垫在底层供你对照，
但**不会烘焙进成图**；配置神经后端后，它会作为 ControlNet 式引导随请求发送（`reference` + `controls`）。

### 脚本模式
右侧 **脚本面板** 直接手写 PixelScript，点「运行」。
错误行会标红并给出 `line N: message`。

### 导出
- **PNG**：最近邻放大到 128/256/512/1024，保留硬边
- **PixelScript**：`.pxs` 文本，可入版本库，可复现
- **精灵表 PNG**：所有帧横向/网格排列，供游戏引擎或风格迁移使用
- **GIF**：多帧循环动画（纯 JS LZW，透明安全）
- **Aseprite**：`.aseprite` 单图层多帧，可直接在 Aseprite / Libresprite 继续编辑
- **色板**：从当前图像提取

---

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PX_BASE_URL` | `https://api.deepseek.com` | OpenAI 兼容端点；**粘贴完整 `/chat/completions` 端点也能用**（会自动归一化） |
| `PX_API_KEY` | *(空)* | 留空则进入演示模式 |
| `PX_MODEL` | `deepseek-flash` | **必须是支持视觉输入的模型** |
| `PX_PORT` | `5173` | 服务端口 |
| `PX_TEMPERATURE` | `0.6` | 采样温度 |
| `PX_MAX_ITERATIONS` | `6` | 闭环最大轮次 |
| `PX_VISION_LONG_EDGE` | `384` | 回灌图长边像素 |
| `PX_VISION_DETAIL` | `high` | DeepSeek 视觉细节级别：`high`（=original，保留原图）/ `low`（缩到 512×512，更省 token）/ `auto` |
| `PX_TIMEOUT_MS` | `180000` | 上游超时 |
| `PX_MAX_TOKENS` | `2048` | 单轮最大输出 token（PixelScript 很短） |
| `PX_THINKING` | `auto` | 思考模式：`auto`（已知网关自动关；`deepseek-flash` 一律不发）/ `disabled` / `enabled` |
| `PX_VISION` | `auto` | 视觉回灌：`auto`（不可用自动降级）/ `on` / `off` |
| `PX_RENDER_URL` | *(空)* | 可选：神经渲染后端（img2img / ControlNet）。留空则只用程序化先验 |
| `PX_RENDER_KEY` | *(空)* | 可选：神经渲染后端的 Bearer Key |
| `PX_INPAINT_URL` | *(空)* | 可选：局部重绘专用端点；缺省回退 `PX_RENDER_URL` |
| `PX_UPSCALE_URL` | *(空)* | 可选：放大专用端点；缺省回退 `PX_RENDER_URL` |
| `PX_GATEWAY_CONFIG` | *(空)* | 可选：复用鲸语 WhaleTalk 的 `config.json` 路径（取 `base_url`/`model`；其 `api_key` 经 DPAPI 加密，Node 无法解密，仍需 `PX_API_KEY`） |

推荐的视觉模型：`deepseek-flash`（原生多模态，默认推荐；旧名 `deepseek-v4-flash-vision-exp` 仍可调用）/
`gpt-4o` / `gpt-4o-mini` / `qwen-vl-max` / `glm-4v` / `gemini-2.0-flash` / `llava`（本地）。

## 网关与模型适配

服务端与前端都已内置与鲸语 WhaleTalk 同款的网关适配：

- **端点归一化**：`https://opencode.ai/zen/go/v1/chat/completions` 与
  `.../v1` 都能填，自动去掉重复的 `/chat/completions`（否则会拼成
  `.../chat/completions/chat/completions` → 404）。
- **OpenCode Go / Zen**：自动注入 `x-opencode-session` 会话头（不透明、按进程稳定，
  用于缓存路由）与自定义 `User-Agent`；缺失该头会返回 400 `MissingSessionID`。
- **DeepSeek Vision（`deepseek-flash`）**：原生多模态，同一模型既写脚本又看图回灌，无需切换视觉模型；
  该系列不接受 `thinking` 字段，程序会自动省略（旧名 `deepseek-v4-flash-vision-exp` 仍可调用）。
- **图片仅在 user 消息**：DeepSeek 规定 system/assistant 携带图片返回 400；程序会做防御性清洗，
  并支持 `detail` 细节级别（`PX_VISION_DETAIL`）。
- **深度兼容未知 OpenAI 兼容端点**：若网关不认 `thinking` 字段而返回 400，
  会自动去掉该字段重试一次；若网关/模型不接受图片输入，闭环会**自动降级为纯文本审查**
  并继续作画，不会中断。
- **思考流**：开启 thinking 时，`reasoning_content` 会单独显示在 AI 面板的「模型思考中」区，
  不会混入脚本抽取。

---

## 测试

```bash
npm test           # 单元 + 集成 + 无头 UI 冒烟（共 301 项）
npm run test:unit  # 仅单元 / 集成（无需浏览器，含真实 HTTP 闭环）
npm run test:dom   # 仅 jsdom 无头 UI 冒烟
```

`test/selftest.mjs` 覆盖：颜色、调色板、像素缓冲图元、文档与图层、撤销栈、
**43 条指令逐条执行**、程序化渲染效果（法线/浮雕/高光/泛光/色调/分形材质/风格管线）、
渲染后端与控制图、DeepSeek 多模态适配（thinking/图片清洗）、区域热区诊断、
错误行定位、语法预检、模型回复解析、PNG 编解码（zlib 校验）、提示词工程、位图字体、
内置范例端到端渲染，以及一个**跑在真实 HTTP 上的视觉闭环**
（Mock 模型 → 流式 SSE → 执行 → 回灌图像 → 风格后端 → DONE → 中止传播）。

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
