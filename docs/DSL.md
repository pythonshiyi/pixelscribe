# PixelScript 语言参考

PixelScript 是「像素画笔」的绘制领域专用语言（DSL）。它被设计成**大模型能一次写对、
人类能一眼读懂、引擎能毫秒执行**。

- 版本：`1.0`
- 文件扩展名：`.pxs`
- MIME / 代码围栏：`pixelscript`、`px`、`pxs`

---

## 1. 词法与语法

### 1.1 基本规则

- **行式语法**：一行一条指令，`\n` 为分隔符。
- **大小写不敏感**：`RECT` ≡ `rect`。颜色名同理。
- **注释**：`#` 或 `//` 起始至行尾。
- **空行**：忽略。
- **缩进**：无语法意义，但建议缩进以增强可读性。
- **数值**：整数或小数（内部按需取整/取模处理）。
- **坐标系**：左上角为原点 `(0,0)`，`x` 向右增大，`y` 向下增大。
  绘制越界部分被**裁剪**，不报错。

### 1.2 一条指令的结构

```
<command> <positional-arg> <positional-arg> ... [# comment]
```

没有命名参数、没有括号、没有逗号、没有赋值。这是刻意的：

| 设计 | 理由 |
|---|---|
| 无括号 | 模型最容易在括号上失配 |
| 位置参数 | 输出 token 最少 |
| 无需预声明 | 降低规划负担 |
| 单行单指令 | 错误可精确定位到行 |

### 1.3 可选参数的省略

可选参数**只能从尾部省略**，且一旦提供前面的就必须提供。例如：

```
rect 4 4 10 10 c8              # 填充（默认）
rect 4 4 10 10 c8 stroke 2     # 描边，线宽 2
rect 4 4 10 10 c8 fill         # 显式填充
```

---

## 2. 颜色

颜色参数支持四种写法：

| 形式 | 示例 | 说明 |
|---|---|---|
| 调色板索引 | `c0` … `c15` | 也接受 `c:0` 与 `C0` |
| 十六进制 | `#f00` / `#ff004d` / `#ff004d80` | 3/6/8 位，8 位含 Alpha |
| 语义名 | `red`、`darkblue`、`skin` | 依据当前调色板的命名表 |
| 透明 | `transparent` / `none` / `clear` | `#00000000` |

> 引擎内部统一为 32 位 `ABGR` 打包整数。

### 2.1 调色板命名表

切换调色板后，命名表随之改变。以默认 `pico8` 为例：

| 索引 | 名称 | 色值 |
|---|---|---|
| c0 | black | `#000000` |
| c1 | darkblue | `#1d2b53` |
| c2 | darkpurple | `#7e2553` |
| c3 | darkgreen | `#008751` |
| c4 | brown | `#ab5236` |
| c5 | darkgray | `#5f574f` |
| c6 | lightgray | `#c2c3c7` |
| c7 | white | `#fff1e8` |
| c8 | red | `#ff004d` |
| c9 | orange | `#ffa300` |
| c10 | yellow | `#ffec27` |
| c11 | green | `#00e436` |
| c12 | blue | `#29adff` |
| c13 | lavender | `#83769c` |
| c14 | pink | `#ff77a8` |
| c15 | peach | `#ffccaa` |

另有一组**通用名**始终可用（跨越所有调色板，映射到 `#rrggbb` 字面量）：
`white` `black` `gray` `red` `green` `blue` `yellow` `cyan` `magenta`
`orange` `purple` `brown` `pink` `lime` `navy` `teal` `gold` `silver` `transparent`。

> 冲突规则：**调色板名称优先于通用名**。

---

## 3. 指令速查表

| # | 指令 | 签名 |
|---|---|---|
| 1 | `size` | `size W H` |
| 2 | `palette` | `palette NAME` \| `palette #h [#h ...]` |
| 3 | `bg` | `bg COLOR` |
| 4 | `clear` | `clear [COLOR]` |
| 5 | `sym` | `sym off\|x\|y\|xy` |
| 6 | `seed` | `seed N` |
| 7 | `name` | `name "TITLE"` |
| 8 | `px` | `px X Y COLOR` |
| 9 | `hline` | `hline X Y LEN COLOR` |
| 10 | `vline` | `vline X Y LEN COLOR` |
| 11 | `line` | `line X1 Y1 X2 Y2 COLOR [W]` |
| 12 | `rect` | `rect X Y W H COLOR [stroke\|fill] [W]` |
| 13 | `rrect` | `rrect X Y W H R COLOR [stroke\|fill]` |
| 14 | `circle` | `circle CX CY R COLOR [stroke\|fill]` |
| 15 | `ellipse` | `ellipse CX CY RX RY COLOR [stroke\|fill]` |
| 16 | `poly` | `poly COLOR [stroke\|fill] X1 Y1 X2 Y2 ...` |
| 17 | `fill` | `fill X Y COLOR` |
| 18 | `replace` | `replace OLD NEW` |
| 19 | `outline` | `outline COLOR` |
| 20 | `grad` | `grad X Y W H C1 C2 [v\|h]` |
| 21 | `dither` | `dither X Y W H C1 C2 [checker\|bayer\|h\|v] [SCALE] [RATIO]` |
| 22 | `noise` | `noise X Y W H COLOR [DENSITY] [SEED]` |
| 23 | `copy` | `copy SX SY W H DX DY` |
| 24 | `flip` | `flip x\|y` |
| 25 | `rot` | `rot 90\|180\|270` |
| 26 | `erase` | `erase X Y W H` |
| 27 | `adjust` | `adjust X Y W H light\|dark AMOUNT` |
| 28 | `text` | `text X Y COLOR "STRING" [SCALE]` |
| 29 | `curve` | `curve X1 Y1 CX CY X2 Y2 COLOR [W]` |
| 30 | `arc` | `arc CX CY R A0 A1 COLOR [W]` |
| 31 | `shade` | `shade X Y W H COLOR [AMOUNT]` |
| 32 | `bevel` | `bevel X Y W H [SIZE] [STRENGTH]` |
| 33 | `graddither` | `graddither X Y W H C1 C2 [checker\|bayer\|h\|v] [v\|h]` |

---

## 4. 指令详解

### 4.1 指令型

#### `size W H`
设定画布尺寸（1–512）。**必须是脚本的第一条有效指令**，否则报错。
```
size 64 64
```

#### `palette NAME` / `palette #h [...]`
切换预设或定义自定义调色板（索引 0..n-1）。应在绘制前调用。
```
palette pico8
palette #000000 #ff0000 #ffffff
```
预设：`pico8` `gameboy` `cga` `gray` `bw`。

#### `bg COLOR`
用 `COLOR` 填满**当前图层**（等效 `clear COLOR`）。
```
bg c0
```

#### `clear [COLOR]`
清空当前图层为透明，或填充 `COLOR`。
```
clear transparent
clear c1
```

#### `sym off|x|y|xy`
开启/关闭镜像对称，对**其后所有绘制指令**生效。
- `x`：沿垂直中轴镜像（左右对称）
- `y`：沿水平中轴镜像（上下对称）
- `xy`：四向镜像

```
sym x
circle 10 16 5 c8       # 同时在 (22,16) 画一个
sym off
```

> 镜像轴为画布中线（`x = (W-1)/2`）。

#### `seed N`
设定噪声随机种子。未设定时使用脚本首次执行时的时间戳（**非确定**）。
```
seed 42
```

#### `name "TITLE"`
设置文档标题（不影响像素）。
```
name "Slime - Idle Frame"
```

### 4.2 绘制型

#### `px X Y COLOR`
单像素。坐标为整数。
```
px 16 16 c7
```

#### `hline X Y LEN COLOR` / `vline X Y LEN COLOR`
水平/垂直线段，长度为 `LEN` 像素（含起点）。
```
hline 4 8 24 c3
vline 16 4 24 c3
```

#### `line X1 Y1 X2 Y2 COLOR [W]`
Bresenham 直线，线宽 `W`（默认 1，以端点为中心加粗）。
```
line 0 0 31 31 c5
line 4 4 27 4 c0 3
```

#### `rect X Y W H COLOR [stroke|fill] [W]`
矩形。默认 `fill`（填充）。`stroke` 时 `W` 为边框宽度（默认 1）。
`W`/`H` 可为负值表示反向延伸。
```
rect 2 2 28 28 c1 fill
rect 2 2 28 28 c0 stroke 2
```

#### `rrect X Y W H R COLOR [stroke|fill]`
圆角矩形，圆角半径 `R`（自动钳制到 `min(W,H)/2`）。
```
rrect 4 4 24 24 6 c12 fill
```

#### `circle CX CY R COLOR [stroke|fill]`
圆。默认 `fill`。
```
circle 16 16 12 c10 fill
circle 16 16 12 c0 stroke
```

#### `ellipse CX CY RX RY COLOR [stroke|fill]`
轴对齐椭圆。
```
ellipse 16 20 11 8 c3 fill
```

#### `poly COLOR [stroke|fill] X1 Y1 X2 Y2 ...`
多边形。顶点为**变长参数**，因此颜色必须写在最前。
默认 `fill`（扫描线填充，奇偶规则）。至少 3 个顶点。
```
poly c11 fill 16 4 28 26 4 26
poly c0 stroke 16 4 28 26 4 26
```

#### `fill X Y COLOR`
从 `(X,Y)` 开始的 4 连通洪水填充，替换**所有与之颜色相同**的连通像素。
```
fill 16 16 c12
```

#### `replace OLD NEW`
将当前图层中所有等于 `OLD` 的像素替换为 `NEW`（全局换色）。
```
replace c4 c9
```

#### `outline COLOR`
为所有**不透明且四邻域存在透明**的像素**外侧**描一圈 `COLOR`。
常用于让精灵从背景中跳出来。
```
outline c0
```

#### `grad X Y W H C1 C2 [v|h]`
线性渐变，`v` 垂直（默认，自上而下），`h` 水平（自左向右）。
在 16 色板上会产生明显色带——这是像素画的**特性而非缺陷**。
```
grad 0 0 32 12 c0 c6 v
```

#### `dither X Y W H C1 C2 [checker|bayer|h|v] [SCALE] [RATIO]`
在区域内用 `C1` 为底、`C2` 按图案打点，得到"第三种颜色"的错觉。
- `checker`（默认）：棋盘
- `bayer`：4×4 有序抖动矩阵（渐变更平滑，适合表现光照过渡）
- `h` / `v`：水平/垂直线纹

`SCALE` 为图案放大倍数（默认 1）。
`RATIO` 为 `C2` 的占比，0–1（默认 0.5）。**这是控制明暗的关键旋钮**：
占比 0.25 偏暗、0.75 偏亮，配合同一组颜色即可表现多个明度层级。

```
dither 4 20 24 8 c3 c11 checker
dither 0 0 32 16 c0 c6 bayer 2 0.35
dither 0 16 32 16 c0 c6 bayer 2 0.7
```

> 注意：任何有序抖动在 `RATIO = 0.5` 时都会退化成棋盘，这是数学性质而非缺陷。
> 需要纹理差异时请改变 `RATIO`。

#### `noise X Y W H COLOR [DENSITY] [SEED]`
随机撒点。`DENSITY` 为 0–1（默认 0.1，即 10% 的像素）。
```
seed 7
noise 0 0 32 32 c7 0.05
```

#### `copy SX SY W H DX DY`
把区域 `(SX,SY,W,H)` 拷贝到 `(DX,DY)`（**直接覆盖**，不混合）。
```
copy 0 0 16 16 16 0
```

#### `flip x|y`
整层翻转。`x` 左右翻转，`y` 上下翻转。
```
flip x
```

#### `rot 90|180|270`
整层顺时针旋转。**非正方形图层旋转 90/270 会裁剪到原尺寸**（并给出警告）。
```
rot 90
```

#### `erase X Y W H`
把区域擦除为透明。
```
erase 0 0 32 4
```

#### `adjust X Y W H light|dark AMOUNT`
区域内所有不透明像素整体提亮/压暗。`AMOUNT` ∈ (0,1]，默认 0.2。
用于快速做高光与阴影。
```
adjust 4 20 24 8 dark 0.3
adjust 10 8 6 4 light 0.4
```

#### `text X Y COLOR "STRING" [SCALE]`
用内置 5×7 位图字体绘制文本（A–Z 0–9 及常用标点，小写自动转大写）。
`SCALE` 为放大倍数（默认 1），字距 1 像素。
```
text 2 2 c7 "LV 12" 2
```

### 4.3 精细化 / 可控扩展（v1.2）

#### `curve X1 Y1 CX CY X2 Y2 COLOR [W]`
二次贝塞尔曲线：起点 `(X1,Y1)`、控制点 `(CX,CY)`、终点 `(X2,Y2)`，`W` 为线宽（默认 1）。
用于有机轮廓、叶形、毛发、飘带等直线/圆无法自然表达的曲线。
```
curve 4 28 16 2 28 28 c11 1     # 一片叶子
curve 10 8 16 2 22 8 c7 2       # 一挑高光
```

#### `arc CX CY R A0 A1 COLOR [W]`
圆弧描边。角度制：`0` 为右（3 点方向），`90` 为下，逆时针为负；`A1` 可小于 `A0`。
```
arc 16 16 12 200 340 c6 2       # 下半圈高光/裂纹
```

#### `shade X Y W H COLOR [AMOUNT]`
区域内所有不透明像素**向 `COLOR` 线性靠拢** `AMOUNT`（0–1，默认 0.25）。
相比 `adjust`（只提亮/压暗），`shade` 能选定色相，是「同色系阴影/受光」的可控做法。
```
shade 4 18 24 8 c1 0.35         # 底部沉入深蓝阴影
shade 10 8 12 4 c7 0.2          # 顶部向白受光
```

#### `bevel X Y W H [SIZE] [STRENGTH]`
立体浮雕：区域**左上边缘受光、右下边缘阴影**，`SIZE` 为边缘宽度（默认 2），
`STRENGTH` 为强度（默认 0.3）。给道具、按钮、宝石快速加体积感。
```
bevel 2 2 12 12 2 0.35
```

#### `graddither X Y W H C1 C2 [checker|bayer|h|v] [v|h]`
**抖动渐变**：沿方向用有序抖动在 `C1→C2` 之间过渡，像素画表现天空/光照的经典手法，
比 `grad` 更有像素质感（不产生连续色带）。
```
graddither 0 0 64 32 c12 c7 bayer v
```

---

## 5. 执行语义

### 5.1 裁剪
所有绘制越界部分静默裁剪。

### 5.2 错误处理
- **行级错误**不终止脚本：该行跳过，继续执行后续行。
- 除 `size` 缺失/非法外，脚本总是执行到末尾。
- 错误信息格式：`line N: <message>`。

### 5.3 执行报告

```json
{
  "ok": true,
  "ops": 12,
  "changed": 337,
  "errors": [],
  "warnings": [],
  "elapsedMs": 1.4
}
```

| 字段 | 含义 |
|---|---|
| `ok` | 是否无错误 |
| `ops` | 成功执行的指令数 |
| `changed` | 本次执行实际改动的像素数（用于收敛判断） |
| `errors` | `["line 6: unknown color 'c19'"]` |
| `warnings` | 如 `"line 9: rot 90 on non-square layer will crop"` |

### 5.4 模式

| 模式 | 语义 |
|---|---|
| `replace`（整幅） | 执行前 `clear` 当前图层，脚本描述完整画面 |
| `append`（增量） | 在现有像素上叠加，脚本只描述改动 |

---

## 6. 完整示例集

### 6.1 史莱姆（32×32）

```
# Slime
size 32 32
palette pico8
clear transparent
seed 1

ellipse 16 20 11 8 c3 fill
ellipse 16 20 11 8 c11 fill
rect 5 19 22 1 c3
circle 11 16 2 c0 fill
circle 21 16 2 c0 fill
px 12 15 c7
px 22 15 c7
dither 8 22 16 4 c11 c3 checker
outline c1
```

### 6.2 药水道具（16×16）

```
size 16 16
palette pico8
clear transparent
sym x

rrect 5 5 6 9 2 c7 fill
rect 6 3 4 2 c5 fill
rect 4 10 8 4 c12 fill
rect 4 10 8 4 c12 fill
hline 5 9 6 c15
px 7 12 c7
outline c1
```

### 6.3 渐变天空 + 远山（64×64）

```
size 64 64
palette pico8
seed 3

grad 0 0 64 48 c12 c7 v
circle 48 10 6 c10 fill
poly c3 fill 0 64 16 26 34 64
poly c1 fill 26 64 44 20 64 64
line 16 26 34 64 c7
grad 0 48 64 16 c11 c3 v
noise 0 48 64 16 c11 0.08
noise 0 0 64 40 c7 0.02
```

---

## 7. 让模型写对 PixelScript 的提示词模板

```text
你只能输出 PixelScript。规则：
1. 第一行必须是 size W H。
2. 一行一条指令，不要括号、逗号或引号（除 text 的字符串）。
3. 颜色用 c0..c15 或 #rrggbb。
4. 不要逐像素描摹，用 circle/rect/poly/ellipse 等图元组合。
5. 先用 3-6 种颜色定大形，再补细节与 outline。
6. 把所有指令放进一个 ```pixelscript 代码块。
```

---

## 8. 版本历史

| 版本 | 变更 |
|---|---|
| 1.0 | 初始 28 条指令，5 套调色板，5×7 字体，容错执行与执行报告 |
| 1.2 | 新增 5 条精细化指令：`curve`（贝塞尔）/`arc`（圆弧）/`shade`（同色系着色）/`bevel`（浮雕）/`graddither`（抖动渐变），共 33 条 |
