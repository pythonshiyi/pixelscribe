/**
 * 内置示例库
 */

export const SAMPLES = [
  {
    name: '史莱姆 · 32×32',
    desc: 'ellipse / dither / outline · 对称绘制',
    code: `# 史莱姆
size 32 32
palette pico8
clear transparent
seed 1
name "史莱姆"

sym x
ellipse 16 20 11 8 c3 fill
ellipse 16 20 10 7 c11 fill
rect 5 19 22 1 c3 fill
circle 11 16 2 c0 fill
circle 21 16 2 c0 fill
px 12 15 c7
px 22 15 c7
dither 8 23 16 4 c11 c3 checker
outline c1
`,
  },
  {
    name: '红药水 · 16×16',
    desc: 'rrect / adjust / outline · 小尺寸图标',
    code: `# 红药水
size 16 16
palette pico8
clear transparent
name "红药水"

sym x
rrect 5 5 6 9 2 c7 fill
rect 6 3 4 2 c5 fill
rect 4 10 8 4 c8 fill
hline 5 9 6 c15
px 7 12 c7
adjust 4 10 8 4 dark 0.2
outline c1
`,
  },
  {
    name: '山景 · 64×64',
    desc: 'grad / poly / noise · 背景绘制',
    code: `# 山景
size 64 64
palette pico8
clear transparent
seed 3
name "山景"

grad 0 0 64 48 c12 c7 v
circle 48 10 6 c10 fill
poly c3 fill 0 64 16 26 34 64
poly c1 fill 26 64 44 20 64 64
line 16 26 34 64 c7
grad 0 48 64 16 c11 c3 v
noise 0 48 64 16 c11 0.08
noise 0 0 64 40 c7 0.02
`,
  },
  {
    name: '幽灵 · 32×32',
    desc: 'rrect / ellipse / erase 组合 · 角色敌人',
    code: `# 幽灵
size 32 32
palette pico8
clear transparent
name "幽灵"

rrect 8 4 16 16 8 c6 fill
rect 8 12 16 7 c6 fill
ellipse 10 19 4 4 c6 fill
ellipse 16 19 4 4 c6 fill
ellipse 22 19 4 4 c6 fill
erase 13 20 3 5
erase 20 20 3 5
ellipse 12 11 2 3 c1 fill
ellipse 20 11 2 3 c1 fill
px 12 10 c7
px 20 10 c7
ellipse 16 15 1 2 c5 fill
adjust 8 17 16 7 dark 0.12
outline c5
`,
  },
  {
    name: '爱心徽章 · 24×24',
    desc: 'poly 多边形 · 自定义配色',
    code: `# 爱心徽章
size 24 24
palette pico8
clear transparent
name "徽章"

circle 12 12 11 c1 fill
circle 12 12 10 c13 fill
sym x
circle 9 10 4 c8 fill
circle 15 10 4 c8 fill
poly c8 fill 5 11 19 11 12 21
px 8 8 c14
px 10 7 c14
outline c2
`,
  },
  {
    name: '文字标题 · 48×24',
    desc: 'text 位图字体 · 像素字',
    code: `# 像素标题
size 48 24
palette pico8
clear transparent
name "标题"

grad 0 0 48 24 c1 c2 v
rect 0 0 48 24 c0 stroke 1
text 10 4 c10 "PIXEL" 1
text 10 13 c7 "BRUSH" 1
hline 10 22 29 c8
`,
  },
  {
    name: '渐变切片 · 32×32',
    desc: 'grad / dither 图案对照',
    code: `# 抖动与渐变
size 32 32
palette pico8
clear transparent
name "图案"

grad 0 0 32 8 c8 c10 v
dither 0 8 32 8 c8 c10 checker
dither 0 16 32 8 c12 c1 bayer
dither 0 24 32 4 c3 c11 h
dither 0 28 32 4 c4 c9 v
outline c0
`,
  },
  {
    name: '盾牌 · 32×32',
    desc: 'poly / grad / outline · 装备图标',
    code: `# 盾牌
size 32 32
palette pico8
clear transparent
name "盾牌"

sym x
poly c6 fill 6 5 26 5 26 17 16 28 6 17
poly c12 fill 8 7 24 7 24 16 16 25 8 16
poly c10 fill 13 7 19 7 19 14 16 19 13 14
rect 6 4 20 2 c4 fill
grad 6 5 20 12 c12 c1 v
outline c0
`,
  },
  {
    name: '蘑菇 · 24×24',
    desc: 'ellipse / px 细节 · 道具',
    code: `# 蘑菇
size 24 24
palette pico8
clear transparent
name "蘑菇"

sym x
ellipse 12 11 10 8 c8 fill
rect 8 13 8 8 c15 fill
ellipse 8 7 3 3 c7 fill
ellipse 16 7 3 3 c7 fill
px 12 4 c7
px 12 5 c7
adjust 8 14 8 6 dark 0.15
outline c2
`,
  },
  {
    name: '机器人 · 32×32',
    desc: 'rect / circle 拼装 · 硬边风格',
    code: `# 机器人
size 32 32
palette pico8
clear transparent
name "机器人"

sym x
rect 8 8 16 13 c6 fill
rect 10 11 4 3 c12 fill
rect 18 11 4 3 c12 fill
rect 11 17 10 2 c5 fill
vline 16 4 4 c6
circle 16 4 2 c8 fill
rect 6 21 20 8 c5 fill
rect 12 23 8 4 c9 fill
    rect 4 22 3 6 c5 fill
    rect 25 22 3 6 c5 fill
    outline c0
`,
  },
  {
    name: '写实光影 · 32×32',
    desc: 'style / light / fbm / render · 程序化写实管线',
    code: `# 写实光影（程序化先验）
size 32 32
palette pico8
clear transparent
seed 7
name "写实光影"
style photo

bg c1
light -1 -1 1 1
fbm 0 0 32 32 c1 c5 4 8 mod
circle 16 15 9 c9 fill
circle 16 15 8 c10 fill
shade 8 7 16 16 c4 0.25
px 12 10 c7
px 13 11 c7
outline c0
render photo
`,
  },
  {
    name: '黏土材质球 · 32×32',
    desc: 'light / relief / specular / bloom · 3D 质感',
    code: `# 黏土材质球
size 32 32
palette pico8
clear transparent
seed 2
name "材质球"
style 3d

light -1 -1 1.2 1
light 1 1 0.6 0.4
bg c1
fbm 0 0 32 32 c1 c6 3 6 mod
circle 16 15 11 c4 fill
circle 16 15 10 c9 fill
shade 7 6 16 16 c15 0.3
specular 0.8 20
bloom 0.8 0.45 2
tone 1.05 1.12 1.05 0 0.18
outline c0
render 3d
`,
  },
];
