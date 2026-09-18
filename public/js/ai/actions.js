/**
 * 动作动画预设（v2.5）
 * ---------------------------------------------------------------
 * 相比「生成 N 帧」，动作预设给模型明确的关键姿态与节奏约束，
 * 并在生成后对角色基线做确定性对齐，避免帧间抖动。
 */

/** @typedef {{id:string,label:string,frames:number,fps:number,loop:boolean,prompt:string,align?:boolean}} ActionPreset */

/** @type {ActionPreset[]} */
export const ACTIONS = [
  { id: 'none', label: '无（自定义）', frames: 1, fps: 8, loop: false, prompt: '' },
  {
    id: 'idle', label: '待机 idle', frames: 4, fps: 6, loop: true, align: true,
    prompt: '呼吸/上下起伏，幅度 1px；手臂与配饰轻微摆动；首尾姿态一致，可无缝循环。',
  },
  {
    id: 'walk', label: '行走 walk', frames: 6, fps: 8, loop: true, align: true,
    prompt: '2 拍步态：接触→下沉→通过→抬起的循环；手臂前后反摆；身体上下起伏 1px；首尾闭合。',
  },
  {
    id: 'run', label: '奔跑 run', frames: 6, fps: 12, loop: true, align: true,
    prompt: '大步幅奔跑，身体前倾；手脚摆动幅度大，含腾空帧；首尾闭合，节奏比行走更快。',
  },
  {
    id: 'attack', label: '攻击 attack', frames: 5, fps: 10, loop: false,
    prompt: '蓄力→前挥→命中→收回；躯干旋转、手臂/武器充分伸展；最后一帧回到接近起始姿态。',
  },
  {
    id: 'cast', label: '施法 cast', frames: 5, fps: 8, loop: false,
    prompt: '抬手蓄魔→能量汇聚→释放→收势；能量可用高光/dither 表现。',
  },
  {
    id: 'jump', label: '跳跃 jump', frames: 5, fps: 8, loop: false,
    prompt: '下蹲蓄力→起跳伸展→顶点收缩→下落→着地缓冲；角色整体有上下位移。',
  },
  {
    id: 'hit', label: '受击 hit', frames: 3, fps: 12, loop: false,
    prompt: '向后仰身/抖动→快速恢复；幅度明显但帧数少。',
  },
  {
    id: 'defeat', label: '倒下 defeat', frames: 5, fps: 8, loop: false,
    prompt: '踉跄→跪倒→倒地；整体位移向下，最后一帧静止。',
  },
];

/** @param {string} id @returns {ActionPreset} */
export function getAction(id) {
  return ACTIONS.find((a) => a.id === id) || ACTIONS[0];
}

/** 动作选项（供 UI 渲染下拉）。 */
export const ACTION_OPTIONS = ACTIONS.map((a) => ({ id: a.id, label: a.label }));
