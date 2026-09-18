/**
 * 质量基准 · golden prompt 集（v2.5）
 * 覆盖生物 / 道具 / UI / 场景四类，尺寸覆盖 16 与 32。
 */
export const BENCH_PROMPTS = [
  { id: 'slime', category: 'creature', brief: '32×32 的绿色史莱姆，两只眼睛，带高光与描边' },
  { id: 'ghost', category: 'creature', brief: '32×32 的白色幽灵，波浪下摆，圆润可爱' },
  { id: 'robot', category: 'creature', brief: '32×32 的方形机器人，天线与方形身体' },
  { id: 'potion', category: 'item', brief: '32×32 的红色药水瓶，玻璃高光' },
  { id: 'sword', category: 'item', brief: '32×32 的银色长剑，斜向，带护手与剑柄' },
  { id: 'flower', category: 'item', brief: '32×32 的五瓣小花，黄色花心' },
  { id: 'heart', category: 'ui', brief: '16×16 的像素爱心图标' },
  { id: 'coin', category: 'ui', brief: '16×16 的金币，带星形高光' },
  { id: 'star', category: 'ui', brief: '16×16 的黄色五角星' },
  { id: 'tree', category: 'scene', brief: '32×32 的一棵树，圆润树冠与棕色树干' },
  { id: 'cloud', category: 'scene', brief: '32×32 的一朵云，轮廓清晰' },
  { id: 'house', category: 'scene', brief: '32×32 的小屋，红色屋顶与窗户' },
];

export const BENCH_CATEGORIES = ['creature', 'item', 'ui', 'scene'];
