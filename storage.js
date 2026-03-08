/* ================================================================
   HeartBeat Studio — storage.js v3
   IndexedDB with localStorage fallback. Zero server dependency.
================================================================ */
'use strict';

const Storage = (() => {
  const DB_NAME = 'hbs_v3', DB_VER = 1, STORE = 'sessions', LS_KEY = 'hbs_v3_sessions';
  let db = null, ready = false, _init = null;

  function init() {
    if (_init) return _init;
    _init = new Promise(resolve => {
      if (!window.indexedDB) { resolve(false); return; }
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = e => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains(STORE))
          d.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = e => { db = e.target.result; ready = true; resolve(true); };
      req.onerror   = () => resolve(false);
    });
    return _init;
  }

  function _tx(mode, fn) {
    return new Promise((res, rej) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = e => res(e.target.result);
      req.onerror   = e => rej(e.target.error);
    });
  }
  function _lsGet()    { try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch { return []; } }
  function _lsSet(arr) { try { localStorage.setItem(LS_KEY, JSON.stringify(arr)); } catch {} }

  async function saveSession(s) {
    await init();
    if (ready) return _tx('readwrite', st => st.put(s));
    const all = _lsGet(), i = all.findIndex(x => x.id === s.id);
    i >= 0 ? all[i] = s : all.unshift(s);
    _lsSet(all); return s;
  }

  async function loadSessions() {
    await init();
    if (ready) {
      const all = await _tx('readonly', st => st.getAll());
      return (all || []).sort((a, b) => b.id - a.id);
    }
    return _lsGet();
  }

  async function deleteSession(id) {
    await init();
    if (ready) return _tx('readwrite', st => st.delete(id));
    _lsSet(_lsGet().filter(s => s.id !== id));
  }

  async function renameSession(id, name) {
    await init();
    if (ready) {
      const s = await _tx('readonly', st => st.get(id));
      if (!s) throw new Error('Not found');
      s.name = name;
      return _tx('readwrite', st => st.put(s));
    }
    const all = _lsGet(), item = all.find(s => s.id === id);
    if (item) { item.name = name; _lsSet(all); return item; }
    throw new Error('Not found');
  }

  function buildSession({ bpm, hrv, minBpm, maxBpm, mood, tempo, name, timeline }) {
    const now = new Date();
    const id  = now.getTime();
    const date = now.toLocaleDateString('en-CA');
    const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const finalName = (name || '').trim() ||
      `Session · ${now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${time}`;
    return { id, name: finalName, bpm, hrv, minBpm, maxBpm, mood, tempo, date, time,
             timeline: timeline || [] };
  }

  return { init, saveSession, loadSessions, deleteSession, renameSession, buildSession };
})();

window.Storage = Storage;
