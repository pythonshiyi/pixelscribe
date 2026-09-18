/**
 * WebM 录像导出（v2.2）
 * ---------------------------------------------------------------
 * 用 MediaRecorder 把逐帧绘制的 canvas + 可选音轨录成 WebM。
 * 浏览器 API 软依赖：Node / jsdom 下 isSupported() 返回 false，调用安全降级。
 */

/** 是否支持 MediaRecorder + canvas.captureStream。 */
export function canRecordWebM(win = typeof window !== 'undefined' ? window : null) {
  if (!win) return false;
  const Rec = win.MediaRecorder;
  if (typeof Rec !== 'function') return false;
  if (typeof win.HTMLCanvasElement?.prototype?.captureStream !== 'function') return false;
  if (Rec.isTypeSupported) {
    return ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
      .some((t) => Rec.isTypeSupported(t));
  }
  return true;
}

/** 挑选一个受支持的 mimeType。 */
export function pickMimeType(win = window) {
  const cands = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9', 'video/webm'];
  const Rec = win?.MediaRecorder;
  if (Rec?.isTypeSupported) {
    for (const t of cands) if (Rec.isTypeSupported(t)) return t;
  }
  return 'video/webm';
}

/**
 * 录制一段帧动画为 WebM。
 * @param {{canvas:HTMLCanvasElement, frames:HTMLCanvasElement[]|HTMLImageElement[], durations:number[],
 *          fps?:number, audio?:{mediaStream?:MediaStream, audio?:HTMLAudioElement}, win?:Window,
 *          onProgress?:(i:number,total:number)=>void, signal?:AbortSignal}} opts
 * @returns {Promise<{blob:Blob, mimeType:string, frames:number, durationMs:number}|null>}
 */
export function recordWebM(opts) {
  const win = opts.win || (typeof window !== 'undefined' ? window : null);
  if (!win || !canRecordWebM(win)) return Promise.resolve(null);
  const { canvas, frames, durations } = opts;
  if (!canvas || !frames?.length) return Promise.resolve(null);

  const mimeType = opts.mimeType || pickMimeType(win);
  const stream = canvas.captureStream(opts.fps || Math.max(1, 1000 / (durations[0] || 100)));
  // 合并音轨
  const audioStream = opts.audio?.mediaStream || opts.audio?.audio?.captureStream?.();
  if (audioStream) {
    for (const track of audioStream.getAudioTracks()) {
      try { stream.addTrack(track); } catch { /* 部分实现不支持 */ }
    }
  }

  const rec = new win.MediaRecorder(stream, { mimeType, videoBitsPerSecond: opts.bitrate || 4_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

  return new Promise((resolve) => {
    let idx = 0;
    let timer = 0;
    const total = frames.length;

    const drawFrame = () => {
      const g = canvas.getContext('2d');
      g.imageSmoothingEnabled = false;
      g.clearRect(0, 0, canvas.width, canvas.height);
      g.drawImage(frames[idx], 0, 0, canvas.width, canvas.height);
      opts.onProgress?.(idx + 1, total);
    };

    const stop = () => {
      clearTimeout(timer);
      try { rec.stop(); } catch { /* 已停止 */ }
    };

    rec.onstop = () => {
      const blob = new win.Blob(chunks, { type: mimeType });
      resolve({
        blob,
        mimeType,
        frames: total,
        durationMs: durations.reduce((s, d) => s + d, 0),
      });
    };

    const step = () => {
      if (opts.signal?.aborted) { stop(); return; }
      if (idx >= total) { stop(); return; }
      drawFrame();
      const wait = Math.max(20, durations[idx] || 100);
      idx++;
      timer = setTimeout(step, wait);
    };

    try {
      rec.start();
      opts.audio?.audio?.play?.();
      step();
    } catch {
      resolve(null);
    }
  });
}
