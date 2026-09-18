/**
 * 音频 / 时间轴（v1.8）
 * ---------------------------------------------------------------
 * 纯函数部分（波形峰值、拍点检测、帧时长分配）与浏览器 AudioContext 解耦，
 * 可在 Node 中直接测试；AudioTrack 负责浏览器内的解码与播放。
 */

/** 每帧采样峰值，用于绘制波形。 */
export const DEFAULT_BUCKETS = 2048;

/**
 * 把单声道 PCM 归并成 buckets 段峰值。
 * @param {Float32Array|number[]} samples -1..1
 * @param {number} [buckets]
 * @returns {{min:Float32Array,max:Float32Array,peak:Float32Array,buckets:number}}
 */
export function computePeaks(samples, buckets = DEFAULT_BUCKETS) {
  const n = samples.length;
  const b = Math.max(1, buckets | 0);
  const min = new Float32Array(b);
  const max = new Float32Array(b);
  const peak = new Float32Array(b);
  if (!n) return { min, max, peak, buckets: b };
  for (let i = 0; i < b; i++) {
    const s0 = Math.floor((i * n) / b);
    const s1 = Math.max(s0 + 1, Math.floor(((i + 1) * n) / b));
    let lo = 0, hi = 0;
    for (let j = s0; j < s1 && j < n; j++) {
      const v = samples[j];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    min[i] = lo;
    max[i] = hi;
    peak[i] = Math.max(Math.abs(lo), Math.abs(hi));
  }
  return { min, max, peak, buckets: b };
}

/**
 * 简单能量包络起音检测：返回拍点时间（秒）。
 * @param {Float32Array} peak - computePeaks().peak
 * @param {number} durationSec
 * @param {{threshold?:number, minGapSec?:number}} [opts]
 * @returns {number[]}
 */
export function detectBeats(peak, durationSec, opts = {}) {
  const m = peak.length;
  if (!m || durationSec <= 0) return [];
  const onset = new Float32Array(m);
  let maxOn = 0;
  for (let i = 1; i < m; i++) {
    const d = peak[i] - peak[i - 1];
    onset[i] = d > 0 ? d : 0;
    if (onset[i] > maxOn) maxOn = onset[i];
  }
  if (maxOn <= 0) return [];
  const thr = (opts.threshold ?? 0.35) * maxOn;
  const minGap = Math.max(1, Math.round((opts.minGapSec ?? 0.12) * (m / durationSec)));
  const beats = [];
  for (let i = 1; i < m - 1; i++) {
    if (onset[i] < thr) continue;
    if (onset[i] < onset[i - 1] || onset[i] < onset[i + 1]) continue;
    if (beats.length && i - beats[beats.length - 1] < minGap) {
      if (onset[i] > onset[beats[beats.length - 1]]) beats[beats.length - 1] = i;
      continue;
    }
    beats.push(i);
  }
  return beats.map((i) => (i / m) * durationSec);
}

/** 由拍点估算 BPM（中位间隔）。 */
export function bpmFromBeats(beats) {
  if (!Array.isArray(beats) || beats.length < 2) return 0;
  const gaps = [];
  for (let i = 1; i < beats.length; i++) {
    const dt = beats[i] - beats[i - 1];
    if (dt > 0.05 && dt < 2) gaps.push(dt);
  }
  if (!gaps.length) return 0;
  gaps.sort((a, b) => a - b);
  const med = gaps[gaps.length >> 1];
  return Math.round(60 / med);
}

/**
 * 把总时长按拍点间隔分配给各帧（循环取用拍间隔；无拍点时均匀分配）。
 * @param {number} frameCount
 * @param {number} totalMs
 * @param {number[]} [beats] 拍点时间（秒）
 * @returns {number[]} 每帧毫秒数
 */
export function frameDurationsForBeats(frameCount, totalMs, beats) {
  const n = Math.max(0, frameCount | 0);
  if (!n) return [];
  const even = Math.max(20, Math.round((totalMs || 0) / n));
  if (!Array.isArray(beats) || beats.length < 2 || !(totalMs > 0)) return new Array(n).fill(even);
  const intervals = [];
  for (let i = 1; i < beats.length; i++) {
    const dt = Math.round((beats[i] - beats[i - 1]) * 1000);
    if (dt >= 20) intervals.push(dt);
  }
  if (!intervals.length) return new Array(n).fill(even);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = intervals[i % intervals.length];
  return out;
}

/** BPM 由拍点估算（见 bpmFromBeats）。 */

/** 持久化时把峰值降到不超过 maxBuckets，避免文档过大。 */
function serializePeaks(peaks, maxBuckets = 512) {
  const n = peaks.min.length;
  if (n <= maxBuckets) {
    return { min: Array.from(peaks.min), max: Array.from(peaks.max), buckets: peaks.buckets };
  }
  const min = new Array(maxBuckets);
  const max = new Array(maxBuckets);
  for (let i = 0; i < maxBuckets; i++) {
    const s0 = Math.floor((i * n) / maxBuckets);
    const s1 = Math.max(s0 + 1, Math.floor(((i + 1) * n) / maxBuckets));
    let lo = 0, hi = 0;
    for (let j = s0; j < s1 && j < n; j++) {
      if (peaks.min[j] < lo) lo = peaks.min[j];
      if (peaks.max[j] > hi) hi = peaks.max[j];
    }
    min[i] = lo;
    max[i] = hi;
  }
  return { min, max, buckets: maxBuckets };
}

/**
 * 浏览器音频轨道：解码、波形、拍点、与帧序列同步播放。
 * 无 AudioContext 的环境（Node / jsdom）下所有方法安全降级。
 */
export class AudioTrack {
  constructor() {
    this.name = '';
    this.duration = 0;   // 秒
    this.peaks = null;
    this.beats = [];
    this.bpm = 0;
    this.url = '';
    this._audio = null;
    this._ctx = null;
  }

  get loaded() { return Boolean(this._audio); }
  get currentTime() { return this._audio ? this._audio.currentTime : 0; }

  /**
   * @param {File|Blob} file
   * @returns {Promise<boolean>} 是否成功
   */
  async load(file) {
    if (typeof window === 'undefined' || typeof Audio === 'undefined') return false;
    this.name = file.name || 'audio';
    this.url = URL.createObjectURL(file);
    this._audio = new Audio(this.url);
    this._audio.preload = 'auto';

    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) {
      // 无法解码，仅保留播放能力（时长靠元数据）
      await new Promise((resolve) => {
        this._audio.addEventListener('loadedmetadata', resolve, { once: true });
        this._audio.addEventListener('error', resolve, { once: true });
      });
      this.duration = this._audio.duration || 0;
      return true;
    }
    try {
      if (!this._ctx) this._ctx = new Ctx();
      const raw = await file.arrayBuffer();
      const decoded = await this._ctx.decodeAudioData(raw.slice(0));
      this.duration = decoded.duration;
      const ch = decoded.getChannelData(0);
      const p = computePeaks(ch, DEFAULT_BUCKETS);
      this.peaks = p;
      this.beats = detectBeats(p.peak, decoded.duration);
      this.bpm = bpmFromBeats(this.beats);
      return true;
    } catch {
      // 解码失败（不支持的编码）：退回 HTMLAudio 元数据
      await new Promise((resolve) => {
        this._audio.addEventListener('loadedmetadata', resolve, { once: true });
        this._audio.addEventListener('error', resolve, { once: true });
      });
      this.duration = this._audio.duration || 0;
      return true;
    }
  }

  play(offset = 0) {
    if (!this._audio) return;
    try { this._audio.currentTime = Math.max(0, offset); } catch { /* 尚未就绪 */ }
    this._audio.loop = false;
    this._audio.play().catch(() => { /* 自动播放策略 */ });
  }

  pause() { this._audio?.pause(); }
  stop() {
    if (!this._audio) return;
    this._audio.pause();
    try { this._audio.currentTime = 0; } catch { /* ignore */ }
  }

  dispose() {
    this.stop();
    if (this.url) { try { URL.revokeObjectURL(this.url); } catch { /* ignore */ } }
    this._audio = null;
    this.peaks = null;
    this.beats = [];
    this.url = '';
  }

  /** 序列化元数据（不含音频数据本身）：刷新后仍可显示波形与拍点。 */
  toJSON() {
    return {
      name: this.name,
      duration: this.duration,
      bpm: this.bpm,
      beats: this.beats,
      peaks: this.peaks ? serializePeaks(this.peaks) : null,
    };
  }

  static fromJSON(json) {
    const t = new AudioTrack();
    if (!json) return t;
    t.name = json.name || '';
    t.duration = json.duration || 0;
    t.bpm = json.bpm || 0;
    t.beats = Array.isArray(json.beats) ? json.beats : [];
    if (json.peaks?.min && json.peaks?.max) {
      t.peaks = {
        min: Float32Array.from(json.peaks.min),
        max: Float32Array.from(json.peaks.max),
        peak: Float32Array.from(json.peaks.max.map((v, i) => Math.max(Math.abs(v), Math.abs(json.peaks.min[i] || 0)))),
        buckets: json.peaks.buckets || json.peaks.min.length,
      };
    }
    return t;
  }
}
