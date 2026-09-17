/**
 * 作品库（专门的文件空间）
 * ---------------------------------------------------------------
 * 服务端把生成物落盘到 `<repo>/workspace/gallery`（`PX_WORKSPACE` 可改）。
 * 本模块负责浏览 / 存入 / 下载 / 删除 / 打开目录；AI 闭环完成后自动保存。
 */

import { $, el, toast } from './dom.js';

export class Gallery {
  /** @param {any} app */
  constructor(app) {
    this.app = app;
    this.grid = null;
    this.items = [];
    this.dir = '';
  }

  init() {
    this.grid = $('#galleryGrid');
    $('#btnGalleryRefresh')?.addEventListener('click', () => this.refresh());
    $('#btnGallerySave')?.addEventListener('click', () => this.saveCurrent());
    $('#btnGalleryReveal')?.addEventListener('click', () => this.reveal());
    this.refresh();
  }

  async refresh() {
    if (!this.grid) return;
    try {
      const r = await fetch('/api/gallery', { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      this.items = data.items || [];
      this.dir = data.dir || '';
      const p = $('#galleryPath');
      if (p) p.textContent = this.dir || '—';
      this.render();
    } catch (e) {
      this.grid.replaceChildren(el('div', {
        class: 'gallery-empty',
        html: `作品库需要后端服务。<br>请用 <b>npm start</b> 打开页面（${e.message}）。`,
      }));
    }
  }

  render() {
    if (!this.items.length) {
      this.grid.replaceChildren(el('div', {
        class: 'gallery-empty',
        html: '还没有作品。<br>完成一次 AI 生成会自动保存，或点「存入作品」。',
      }));
      return;
    }
    this.grid.replaceChildren(...this.items.map((it) => this.card(it)));
  }

  card(it) {
    const box = el('div', { class: 'gallery-card', title: `${it.name}\n${(it.size / 1024).toFixed(1)} KB` });
    box.append(it.kind === 'image'
      ? el('img', { src: it.url, alt: it.name, loading: 'lazy' })
      : el('div', { class: 'gallery-file', text: '.pxs' }));
    box.append(el('div', { class: 'gallery-meta', text: it.name }));
    box.append(el('div', { class: 'gallery-actions' }, [
      el('button', { class: 'btn small ghost', text: '查看', onclick: () => window.open(it.url, '_blank') }),
      el('button', { class: 'btn small ghost', text: '下载', onclick: () => this.download(it) }),
      el('button', { class: 'btn small ghost danger', text: '删', onclick: () => this.remove(it) }),
    ]));
    return box;
  }

  /** 当前画布 → 最近邻放大 PNG（默认源尺寸×4） */
  currentPng(longEdge = 0) {
    const doc = this.app.doc;
    const target = longEdge || Math.max(doc.width, doc.height) * 4;
    return this.app.renderer.export(target, false);
  }

  async _post(path, payload) {
    const r = await fetch(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  async _save(base, silent) {
    const { dataURL } = this.currentPng();
    await this._post('/api/gallery/save', { kind: 'png', name: `${base}.png`, dataURL });
    const script = this.app.scriptPanel?.getValue?.()?.trim();
    if (script) await this._post('/api/gallery/save', { kind: 'pxs', name: `${base}.pxs`, text: script });
    if (!silent) toast('已存入作品库', 'ok');
    this.refresh();
  }

  _stem(fallback) {
    const t = this.app.doc.title;
    const base = (t && t !== '未命名' ? t : fallback).replace(/[^\w.\-]+/g, '_');
    return `${base}_${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}`;
  }

  /** 手动存入当前作品（PNG + 脚本） */
  async saveCurrent() {
    try {
      await this._save(this._stem('pixelscribe'), false);
    } catch (e) {
      toast(`保存失败：${e.message}`, 'err');
    }
  }

  /** AI 闭环完成后自动保存（静默失败，离线/演示环境不打扰）。 */
  async autoSave(reason = 'ai') {
    if (this.app.doc.activeLayer.buffer.opaqueCount() === 0) return;
    try {
      await this._save(this._stem(reason), true);
      toast('作品已自动保存到「作品」', 'ok', 1800);
    } catch { /* file:// 或后端不可用时忽略 */ }
  }

  download(it) {
    const a = el('a', { href: it.url, download: it.name });
    document.body.append(a);
    a.click();
    a.remove();
  }

  async remove(it) {
    try {
      await this._post('/api/gallery/delete', { name: it.name });
      toast(`已删除 ${it.name}`, 'ok', 1600);
      this.refresh();
    } catch (e) {
      toast(`删除失败：${e.message}`, 'err');
    }
  }

  async reveal() {
    try {
      await this._post('/api/gallery/reveal', {});
      toast('已在文件管理器中打开', 'ok');
    } catch (e) {
      toast(`打开失败：${e.message}`, 'err');
    }
  }
}
