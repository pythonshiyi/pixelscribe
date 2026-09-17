/**
 * 持久化存储（v1.7）
 * ---------------------------------------------------------------
 * 大画布 / 多帧的文档 JSON 很容易超过 localStorage 的 ~5MB 配额，
 * 因此优先写入 IndexedDB；不可用时回退 localStorage；再不可用回退内存。
 *
 * API 均为异步，但内部在 localStorage 环境下会同步完成，便于兼容旧调用。
 */

const DB_NAME = 'pixelscribe';
const DB_VERSION = 1;
const STORE = 'kv';

const memory = new Map();
let dbPromise = null;

function hasIDB() {
  try { return typeof indexedDB !== 'undefined' && indexedDB !== null; } catch { return false; }
}
function hasLS() {
  try { return typeof localStorage !== 'undefined' && localStorage !== null; } catch { return false; }
}

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function lsGet(key) {
  if (!hasLS()) return memory.has(key) ? memory.get(key) : null;
  try { return localStorage.getItem(key); } catch { return null; }
}
function lsSet(key, value) {
  if (!hasLS()) { memory.set(key, value); return true; }
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}
function lsDel(key) {
  memory.delete(key);
  if (!hasLS()) return;
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

/** @returns {Promise<any|null>} */
export async function storeGet(key) {
  if (hasIDB()) {
    try {
      const db = await openDB();
      const value = await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const rq = tx.objectStore(STORE).get(key);
        rq.onsuccess = () => resolve(rq.result ?? null);
        rq.onerror = () => reject(rq.error);
      });
      if (value != null) return value;
    } catch { /* 回退 */ }
  }
  const raw = lsGet(key);
  return raw == null ? null : raw;
}

/** @returns {Promise<boolean>} */
export async function storeSet(key, value) {
  let ok = false;
  if (hasIDB()) {
    try {
      const db = await openDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      ok = true;
    } catch { /* 回退 */ }
  }
  // 同时尝试 localStorage（小对象；大对象配额失败则忽略）
  if (!ok) ok = lsSet(key, value);
  return ok;
}

/** @returns {Promise<void>} */
export async function storeDel(key) {
  lsDel(key);
  if (!hasIDB()) return;
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch { /* ignore */ }
}
