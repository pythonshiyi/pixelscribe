/**
 * 动画 / 帧序列模型（v1.5）
 * ---------------------------------------------------------------
 * 每个帧是文档图层的一次完整快照（含可见性/透明度/类型），
 * 因此帧之间彼此独立、可任意增删改序，且与撤销栈解耦。
 *
 * 提供：帧 CRUD、合成、缩略图、spritesheet、GIF、Aseprite 导出。
 * 纯逻辑 + 纯编码器，Node 可测。
 */

import { PixelBuffer } from './buffer.js';
import { Layer } from './document.js';
import { encodePNG, toBase64 } from '../io/png.js';
import { encodeGIF } from '../io/gif.js';
import { encodeAseprite } from '../io/aseprite.js';

/** 合成一组图层快照为 PixelBuffer（与 PixelDocument.composite 语义一致）。 */
function composeLayers(layers, width, height) {
  const out = new PixelBuffer(width, height);
  for (const l of layers) {
    if (l.kind === 'reference') continue; // 参考图只是引导，不参与成图/导出
    if (l.visible === false || l.opacity <= 0) continue;
    const data = l.data;
    const op = l.opacity == null ? 1 : l.opacity;
    for (let i = 0; i < out.u32.length; i++) {
      const a = data[i * 4 + 3];
      if (a === 0) continue;
      const sr = data[i * 4], sg = data[i * 4 + 1], sb = data[i * 4 + 2];
      if (a === 255 && op >= 1) { out.u32[i] = (255 << 24 | sb << 16 | sg << 8 | sr) >>> 0; continue; }
      const dst = out.get(i % width, (i / width) | 0);
      const sa = (a / 255) * op;
      const da = dst.a / 255;
      const oa = sa + da * (1 - sa);
      const mix = (s, d) => (s * sa + d * da * (1 - sa)) / (oa || 1);
      out.u32[i] = (
        ((oa * 255) & 0xff) << 24
        | (mix(sb, dst.b) & 0xff) << 16
        | (mix(sg, dst.g) & 0xff) << 8
        | (mix(sr, dst.r) & 0xff)
      ) >>> 0;
    }
  }
  return out;
}

function cloneFrame(frame) {
  return {
    width: frame.width,
    height: frame.height,
    layers: frame.layers.map((l) => ({ ...l, meta: l.meta ? { ...l.meta } : null, data: new Uint8ClampedArray(l.data) })),
  };
}

function emptyFrameLike(frame) {
  return {
    width: frame.width,
    height: frame.height,
    layers: frame.layers.map((l) => ({ ...l, meta: l.meta ? { ...l.meta } : null, data: new Uint8ClampedArray(l.data.length) })),
  };
}

const bytesToHex = (arr) => { let s = ''; for (let i = 0; i < arr.length; i++) s += arr[i].toString(16).padStart(2, '0'); return s; };
const hexToBytes = (hex) => { const a = new Uint8ClampedArray(hex.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(hex.substr(i * 2, 2), 16); return a; };

export class Animation {
  /** @param {{width?:number,height?:number,fps?:number,loop?:number}} [opts] */
  constructor(opts = {}) {
    this.fps = opts.fps || 8;
    this.loop = opts.loop == null ? 0 : opts.loop;
    /** @type {ReturnType<typeof cloneFrame>[]} */
    this.frames = [];
    this.current = 0;
    this.onion = 0; // 0=关闭，1=仅上一帧，2=前后各一帧
  }

  get length() { return this.frames.length; }
  get frameDuration() { return Math.max(20, Math.round(1000 / Math.max(1, this.fps))); }

  /** 用当前文档快照覆盖/追加为当前帧。 */
  capture(doc, reset = false) {
    const frame = {
      width: doc.width,
      height: doc.height,
      duration: this.frameDuration,
      layers: doc.layers.map((l) => ({
        id: l.id,
        name: l.name,
        kind: l.kind || 'raster',
        meta: l.meta ? { ...l.meta } : null,
        visible: l.visible,
        opacity: l.opacity,
        locked: l.locked,
        data: new Uint8ClampedArray(l.buffer.data),
      })),
    };
    if (reset || !this.frames.length) { this.frames = [frame]; this.current = 0; }
    else this.frames[this.current] = frame;
    return frame;
  }

  /** 把某帧写回文档。 */
  applyTo(doc, index = this.current) {
    const f = this.frames[index];
    if (!f) return false;
    if (doc.width !== f.width || doc.height !== f.height) doc.resize(f.width, f.height);
    doc.layers = f.layers.map((fl) => {
      const l = new Layer(f.width, f.height, fl.name);
      l.id = fl.id;
      l.visible = fl.visible !== false;
      l.opacity = fl.opacity == null ? 1 : fl.opacity;
      l.locked = Boolean(fl.locked);
      l.kind = fl.kind || 'raster';
      l.meta = fl.meta ? { ...fl.meta } : null;
      l.buffer.data.set(fl.data);
      return l;
    });
    doc.activeLayerIndex = Math.min(doc.activeLayerIndex, doc.layers.length - 1);
    doc.invalidate();
    return true;
  }

  /** 选择帧：先把当前文档存入当前帧，再载入目标帧。 */
  select(doc, index) {
    if (index < 0 || index >= this.frames.length) return false;
    if (this.frames.length) this.capture(doc);
    this.current = index;
    this.applyTo(doc, index);
    return true;
  }

  /** 在当前帧后插入空帧并切换过去。 */
  insertBlank(doc) {
    if (!this.frames.length) { this.capture(doc, true); return this.current; }
    this.capture(doc);
    this.frames.splice(this.current + 1, 0, emptyFrameLike(this.frames[this.current]));
    this.current++;
    this.applyTo(doc, this.current);
    return this.current;
  }

  /** 复制当前帧并切换过去。 */
  duplicate(doc) {
    if (!this.frames.length) { this.capture(doc, true); return this.current; }
    this.capture(doc);
    this.frames.splice(this.current + 1, 0, cloneFrame(this.frames[this.current]));
    this.current++;
    this.applyTo(doc, this.current);
    return this.current;
  }

  remove(index = this.current) {
    if (this.frames.length <= 1) return false;
    this.frames.splice(index, 1);
    this.current = Math.min(this.current, this.frames.length - 1);
    return true;
  }

  move(from, to) {
    if (to < 0 || to >= this.frames.length || from < 0 || from >= this.frames.length) return false;
    const [f] = this.frames.splice(from, 1);
    this.frames.splice(to, 0, f);
    this.current = to;
    return true;
  }

  /** 合成某帧为 PixelBuffer。 */
  frameBuffer(index, width, height) {
    const f = this.frames[index];
    if (!f) return null;
    return composeLayers(f.layers, width || f.width, height || f.height);
  }

  /** 帧缩略图 dataURL。 */
  thumbnailDataURL(index, longEdge = 48) {
    const f = this.frames[index];
    if (!f) return '';
    const buf = this.frameBuffer(index);
    const scale = Math.max(1, Math.round(longEdge / Math.max(f.width, f.height)));
    // 用最近邻放大后编码
    const ow = f.width * scale, oh = f.height * scale;
    const out = new Uint8ClampedArray(ow * oh * 4);
    for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
      const si = ((Math.floor(y / scale) * f.width) + Math.floor(x / scale)) * 4;
      const di = (y * ow + x) * 4;
      out[di] = buf.data[si]; out[di + 1] = buf.data[si + 1]; out[di + 2] = buf.data[si + 2]; out[di + 3] = buf.data[si + 3];
    }
    return `data:image/png;base64,${toBase64(encodePNG(out, ow, oh))}`;
  }

  /**
   * 合成 spritesheet。
   * @param {{columns?:number, padding?:number}} [opts]
   */
  toSpritesheet(opts = {}) {
    const f0 = this.frames[0];
    if (!f0) return null;
    const fw = f0.width, fh = f0.height;
    const n = this.frames.length;
    const columns = Math.max(1, Math.min(n, opts.columns || n));
    const rows = Math.ceil(n / columns);
    const pad = Math.max(0, opts.padding || 0);
    const sw = columns * fw + (columns - 1) * pad;
    const sh = rows * fh + (rows - 1) * pad;
    const out = new Uint8ClampedArray(sw * sh * 4);
    for (let i = 0; i < n; i++) {
      const buf = this.frameBuffer(i);
      const cx = i % columns, cy = (i / columns) | 0;
      const ox = cx * (fw + pad), oy = cy * (fh + pad);
      for (let y = 0; y < fh; y++) {
        for (let x = 0; x < fw; x++) {
          const si = (y * fw + x) * 4;
          const di = ((oy + y) * sw + ox + x) * 4;
          out[di] = buf.data[si]; out[di + 1] = buf.data[si + 1]; out[di + 2] = buf.data[si + 2]; out[di + 3] = buf.data[si + 3];
        }
      }
    }
    return { data: out, width: sw, height: sh, frameWidth: fw, frameHeight: fh, columns, rows, count: n };
  }

  /** 每帧合成后的 RGBA 数组。 */
  frameDataList() {
    return this.frames.map((_, i) => this.frameBuffer(i).data);
  }

  /** 编码 GIF。@param {RGBA[]} palette */
  toGIF(palette) {
    const f0 = this.frames[0];
    if (!f0) return null;
    const frames = this.frameDataList().map((d) => new Uint8ClampedArray(d));
    return encodeGIF(frames, {
      width: f0.width,
      height: f0.height,
      palette,
      delays: this.frames.map((f) => f.duration || this.frameDuration),
      loop: this.loop,
    });
  }

  /** 编码 Aseprite。 */
  toAseprite(layerName = 'Layer') {
    const f0 = this.frames[0];
    if (!f0) return null;
    const frames = this.frameDataList().map((d) => new Uint8ClampedArray(d));
    return encodeAseprite(f0.width, f0.height, frames, {
      layerName,
      durations: this.frames.map((f) => f.duration || this.frameDuration),
    });
  }

  /* ── 持久化 ── */
  toJSON() {
    return {
      fps: this.fps,
      loop: this.loop,
      current: this.current,
      onion: this.onion,
      frames: this.frames.map((f) => ({
        width: f.width,
        height: f.height,
        duration: f.duration,
        layers: f.layers.map((l) => ({
          id: l.id, name: l.name, kind: l.kind, meta: l.meta,
          visible: l.visible, opacity: l.opacity, locked: l.locked,
          data: bytesToHex(l.data),
        })),
      })),
    };
  }

  static fromJSON(json) {
    const a = new Animation({ fps: json?.fps || 8, loop: json?.loop || 0 });
    a.current = json?.current || 0;
    a.onion = json?.onion || 0;
    a.frames = (json?.frames || []).map((f) => ({
      width: f.width,
      height: f.height,
      duration: f.duration || a.frameDuration,
      layers: (f.layers || []).map((l) => ({
        id: l.id, name: l.name, kind: l.kind || 'raster', meta: l.meta || null,
        visible: l.visible !== false, opacity: l.opacity == null ? 1 : l.opacity,
        locked: Boolean(l.locked), data: hexToBytes(l.data || ''),
      })),
    }));
    if (a.current >= a.frames.length) a.current = Math.max(0, a.frames.length - 1);
    return a;
  }
}
