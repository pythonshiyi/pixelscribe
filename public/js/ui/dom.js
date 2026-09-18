/** DOM 小工具 */

/** @param {string} sel @param {ParentNode} [root] */
export const $ = (sel, root = document) => root.querySelector(sel);
/** @param {string} sel @param {ParentNode} [root] */
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * @param {string} tag @param {Record<string,any>} [attrs] @param {(Node|string)[]|string} [children]
 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else node.setAttribute(k, String(v));
  }
  const list = Array.isArray(children) ? children : [children];
  for (const c of list) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** 带图标的按钮 */
export function iconBtn(icon, label, attrs = {}) {
  return el('button', { class: 'btn small ghost', ...attrs }, [
    el('svg', {}, [el('use', { href: `#i-${icon}` })]),
    label ? el('span', { text: label }) : null,
  ]);
}

/** @param {string} msg @param {'ok'|'err'|'warn'|''} [kind] @param {number} [ms] */
export function toast(msg, kind = '', ms = 2600) {
  const host = $('#toastHost');
  if (!host) return;
  const node = el('div', { class: `toast ${kind}`, text: msg });
  host.append(node);
  setTimeout(() => {
    node.classList.add('out');
    setTimeout(() => node.remove(), 220);
  }, ms);
}

/**
 * 简易模态
 * @param {{title:string, body:Node|string, actions?:{label:string,kind?:string,onClick?:()=>void,close?:boolean}[]}} cfg
 * @returns {() => void} 关闭函数
 */
export function modal(cfg) {
  const backdrop = $('#modalBackdrop');
  const box = $('#modalBox');
  const title = $('#modalTitle');
  const body = $('#modalBody');
  const foot = $('#modalFoot');

  title.textContent = cfg.title;
  body.replaceChildren(typeof cfg.body === 'string' ? el('p', { text: cfg.body }) : cfg.body);
  foot.replaceChildren();

  const previouslyFocused = document.activeElement;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    backdrop.hidden = true;
    document.removeEventListener('keydown', onKey);
    // 无论用按钮 / Esc / 遮罩 / × 关闭，都通知调用方，避免 await 该模态的流程永久挂起。
    try { cfg.onClose?.(); } catch { /* ignore */ }
    try { previouslyFocused?.focus?.(); } catch { /* ignore */ }
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { close(); return; }
    // 焦点陷阱：Tab 在模态内循环，避免焦点跑到背景页面。
    if (e.key === 'Tab') {
      const f = [...box.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')];
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };

  for (const a of cfg.actions || []) {
    foot.append(el('button', {
      class: `btn ${a.kind || ''}`,
      text: a.label,
      onclick: () => {
        const keep = a.onClick?.();
        if (a.close !== false && keep !== false) close();
      },
    }));
  }

  $('#modalClose').onclick = close;
  backdrop.onclick = (e) => { if (e.target === backdrop) close(); };
  document.addEventListener('keydown', onKey);
  backdrop.hidden = false;
  if (!box.hasAttribute('tabindex')) box.tabIndex = -1;
  // 打开后把焦点移入模态（优先表单控件），关闭时再还给原元素。
  requestAnimationFrame(() => {
    const first = box.querySelector('input:not([disabled]),select:not([disabled]),textarea:not([disabled]),button:not([disabled])');
    try { (first || box).focus(); } catch { /* ignore */ }
  });
  return close;
}

/** 读取文件为文本 */
export function readTextFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

/** 读取文件为 dataURL */
export function readDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/** 触发下载 */
export function downloadText(filename, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadDataURL(filename, dataURL) {
  const a = el('a', { href: dataURL, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
}

/** 下载二进制（用于 GIF / Aseprite） */
export function downloadBytes(filename, bytes, mime = 'application/octet-stream') {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 防抖 */
export function debounce(fn, ms = 200) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
