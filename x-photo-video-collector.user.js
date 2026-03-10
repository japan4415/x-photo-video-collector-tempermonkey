// ==UserScript==
// @name         X Photo Video Collector
// @namespace    https://github.com/japan4415/x-photo-video-collector-tempermonkey
// @version      0.5.1
// @description  Collect media post URLs and direct image/mp4 links from X profile media tabs.
// @match        https://x.com/*
// @run-at       document-idle
// @grant        GM_openInTab
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @connect      pbs.twimg.com
// @connect      video.twimg.com
// @connect      *.video.twimg.com
// @updateURL    https://github.com/japan4415/x-photo-video-collector-tempermonkey/raw/main/x-photo-video-collector.user.js
// @downloadURL  https://github.com/japan4415/x-photo-video-collector-tempermonkey/raw/main/x-photo-video-collector.user.js
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const DEBUG_CAPTURE_KEY = 'xm-debug-capture';
  const DEBUG_CAPTURE_TIMEOUT = 45000;
  const DEBUG_SNIPPET_LIMIT = 8000;
  const LOG_PREFIX = '[xm-debug]';
  const ZIP_LOCAL_FILE_HEADER_SIG = 0x04034b50;
  const ZIP_CENTRAL_DIRECTORY_SIG = 0x02014b50;
  const ZIP_END_OF_CENTRAL_DIRECTORY_SIG = 0x06054b50;
  const ZIP_STORE_METHOD = 0;
  const ZIP_VERSION_NEEDED = 20;
  const ZIP_UTF8_FLAG = 0x0800;
  const ZIP_MAX_UINT32 = 0xffffffff;
  const ZIP_MAX_ENTRIES = 0xffff;
  const utf8Encoder = new TextEncoder();
  let debugBridgeInitialized = false;
  let activeDownloadAbort = null;

  /* -------------------- Visibility shim -------------------- */
  (function ensureVisibleEnvironment() {
    try {
      const hiddenDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
      if (!hiddenDesc || hiddenDesc.configurable) {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      }
    } catch (err) {
      try { console.debug(LOG_PREFIX, 'failed to override document.hidden', err?.message || err); } catch { /* noop */ }
    }
    try {
      const visDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
      if (!visDesc || visDesc.configurable) {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      }
    } catch (err) {
      try { console.debug(LOG_PREFIX, 'failed to override document.visibilityState', err?.message || err); } catch { /* noop */ }
    }
    const suppressVisibilityChange = (ev) => {
      ev.stopImmediatePropagation();
    };
    document.addEventListener('visibilitychange', suppressVisibilityChange, true);
  })();

  /* -------------------- URL change watcher (SPA) -------------------- */
  const onUrlChange = (() => {
    const listeners = new Set();
    let last = location.href;
    const wrap = (type) => {
      const orig = history[type];
      return function () {
        const ret = orig.apply(this, arguments);
        const now = location.href;
        if (now !== last) { last = now; listeners.forEach(fn => fn(now)); }
        return ret;
      };
    };
    history.pushState = wrap('pushState');
    history.replaceState = wrap('replaceState');
    addEventListener('popstate', () => {
      const now = location.href;
      if (now !== last) { last = now; listeners.forEach(fn => fn(now)); }
    });
    return { start: (fn) => { listeners.add(fn); fn(location.href); } };
  })();

  /* -------------------- Page detector -------------------- */
  function isProfileMediaPage() {
    // 例: https://x.com/<screenName>/media
    return /\/[^/]+\/media\/?$/.test(location.pathname);
  }

  /* -------------------- UI -------------------- */
  const PANEL_ID = 'x-media-topright-panel';
  function ensureStyles() {
    if (document.getElementById('xm-styles')) return;
    const style = document.createElement('style');
    style.id = 'xm-styles';
    style.textContent = `
      #${PANEL_ID}{
        position: fixed; top: 12px; right: 12px; z-index: 999999;
        min-width: 280px; max-height: 72vh; overflow: hidden;
        background: rgba(20,20,20,.92); color:#fff; border-radius: 12px;
        border: 1px solid rgba(255,255,255,.08); box-shadow: 0 6px 24px rgba(0,0,0,.35);
        font-family: system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
        font-size: 13px; line-height: 1.4; backdrop-filter: blur(6px);
        display: flex; flex-direction: column;
      }
      #${PANEL_ID} .xm-header{ padding:8px 10px; font-weight:700; font-size:12px; opacity:.9; display:flex; align-items:center; justify-content:space-between; gap:8px; }
      #${PANEL_ID} .xm-controls{ display:flex; gap:8px; padding:0 10px 8px 10px; flex-wrap:wrap; }
      #${PANEL_ID} .xm-btn{
        appearance:none; outline:none; cursor:pointer;
        padding:8px 10px; border-radius:10px; border:1px solid rgba(255,255,255,.2);
        background: rgba(255,255,255,.06); color:#fff;
        transition: background .15s ease, border-color .15s ease, opacity .15s ease;
      }
      #${PANEL_ID} .xm-btn:hover{ background: rgba(255,255,255,.12); }
      #${PANEL_ID} .xm-btn:disabled{ opacity:.45; cursor:not-allowed; }
      #${PANEL_ID} .xm-status{ padding: 4px 10px; font-size:11px; opacity:.85; border-top:1px solid rgba(255,255,255,.08); }
      #${PANEL_ID} .xm-list{ margin: 6px 10px 10px 10px; padding: 8px; border-radius: 8px;
        background: rgba(255,255,255,.04); overflow: auto; flex: 1 1 auto; }
      #${PANEL_ID} .xm-list ul{ list-style:none; margin:0; padding:0; display:grid; grid-template-columns: 1fr; gap:6px; }
      #${PANEL_ID} .xm-list li{ white-space:nowrap; text-overflow:ellipsis; overflow:hidden; border-bottom:1px dotted rgba(255,255,255,.12); padding-bottom:4px; }
      #${PANEL_ID} .xm-list .type{ font-size:10px; opacity:.75; margin-right:6px; }
      #${PANEL_ID} .xm-draghint{ font-size:10px; opacity:.6; }
    `;
    document.documentElement.appendChild(style);
  }
  function createPanel() {
    if (document.getElementById(PANEL_ID)) return;
    ensureStyles();
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="xm-header">
        <span>Media Tools</span>
        <span class="xm-draghint">drag me</span>
      </div>
      <div class="xm-controls">
        <button id="xm-btn-url" class="xm-btn">URL収集</button>
        <button id="xm-btn-media" class="xm-btn" disabled>メディア取得</button>
        <button id="xm-btn-download" class="xm-btn" disabled>ZIPダウンロード</button>
        <button id="xm-btn-stop" class="xm-btn" style="display:none">停止</button>
      </div>
      <label style="padding:0 10px 8px 10px; display:flex; align-items:center; gap:6px; font-size:11px; opacity:.8;">
        <input type="checkbox" id="xm-debug-toggle" style="margin:0;">デバッグ（最初の1件のみ）
      </label>
      <div class="xm-status" id="xm-status">mediaページ検出</div>
      <div class="xm-list" id="xm-list"><ul id="xm-ul"></ul></div>
      <div id="xm-debug-box" style="display:none; margin:0 10px 10px 10px; padding:8px; border-radius:8px; background:rgba(255,255,255,.08); max-height:160px; overflow:auto; font-family:monospace; font-size:11px; white-space:pre-wrap;">
        <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:4px; gap:8px;">
          <span style="font-weight:600;">Debug HTML Preview</span>
          <button id="xm-debug-copy" class="xm-btn" style="padding:4px 8px; font-size:10px; border-radius:6px;" disabled>コピー</button>
        </div>
        <pre id="xm-debug-pre" style="margin:0; white-space:pre-wrap;"></pre>
      </div>
    `;
    document.body.appendChild(panel);
    document.getElementById('xm-btn-url').addEventListener('click', onClickCollectUrls);
    document.getElementById('xm-btn-media').addEventListener('click', onClickCollectMedia);
    document.getElementById('xm-btn-download').addEventListener('click', onClickDownloadZip);
    const debugToggle = document.getElementById('xm-debug-toggle');
    if (debugToggle) {
      debugToggle.checked = state.debug;
      debugToggle.addEventListener('change', () => {
        state.debug = debugToggle.checked;
        if (state.debug) {
          setStatus('デバッグモード: メディア取得は最初の1件のみ');
          setDebugHtml('(debug) HTML未取得');
        } else {
          setStatus('デバッグモード解除');
          setDebugHtml('');
        }
      });
    }
    setDebugHtml(state.debug ? '(debug) HTML未取得' : '');
    const copyBtn = document.getElementById('xm-debug-copy');
    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        if (!state.debugHtmlRaw) return;
        try {
          await navigator.clipboard.writeText(state.debugHtmlRaw);
          setStatus('デバッグHTMLをクリップボードへコピーしました');
        } catch (err) {
          console.error('clipboard write failed', err);
          setStatus('クリップボードへのコピーに失敗しました');
        }
      });
      copyBtn.disabled = !state.debugHtmlRaw;
    }
    makeDraggable(panel);
  }
  function removePanel() { const el = document.getElementById(PANEL_ID); if (el) el.remove(); }
  function setStatus(text) { const s = document.getElementById('xm-status'); if (s) s.textContent = text; }

  function debugLog(...args) {
    if (!state.debug && !shouldCloseDebugTabAfterSend) return;
    try {
      console.debug(LOG_PREFIX, ...args);
    } catch (err) {
      // ignore logging errors
    }
  }

  function renderTweetList(items) {
    const ul = document.getElementById('xm-ul'); if (!ul) return;
    ul.innerHTML = '';
    const frag = document.createDocumentFragment();
    items.forEach((it) => {
      const li = document.createElement('li');

      const spanType = document.createElement('span');
      spanType.className = 'type';
      spanType.textContent = '[URL]';
      li.appendChild(spanType);

      const a = document.createElement('a');
      a.href = it.url;
      a.textContent = `${it.screenName}/${it.tweetId}`;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.style.color = '#aee3ff';
      a.style.textDecoration = 'none';
      a.addEventListener('mouseenter', () => a.style.textDecoration = 'underline');
      a.addEventListener('mouseleave', () => a.style.textDecoration = 'none');
      li.appendChild(a);

      if (it.mediaSummary) {
        const summary = document.createElement('span');
        summary.style.marginLeft = '8px';
        summary.style.opacity = '0.7';
        summary.textContent = `(${it.mediaSummary})`;
        li.appendChild(summary);
      }

      frag.appendChild(li);
    });
    ul.appendChild(frag);
  }
  function makeDraggable(el) {
    let sx, sy, px, py, dragging = false;
    el.addEventListener('mousedown', (e) => {
      if ((e.target).closest('.xm-btn')) return;
      dragging = true; sx = e.clientX; sy = e.clientY;
      const r = el.getBoundingClientRect(); px = r.left; py = r.top; e.preventDefault();
    });
    addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      el.style.left = (px + dx) + 'px'; el.style.top = (py + dy) + 'px'; el.style.right = 'auto';
    });
    addEventListener('mouseup', () => dragging = false);
  }

  function renderMediaList(items) {
    const ul = document.getElementById('xm-ul'); if (!ul) return;
    ul.innerHTML = '';
    const frag = document.createDocumentFragment();
    items.forEach((it) => {
      const li = document.createElement('li');

      const spanType = document.createElement('span');
      spanType.className = 'type';
      spanType.textContent = `[${it.type.toUpperCase()}]`;
      li.appendChild(spanType);

      const a = document.createElement('a');
      a.href = it.url;
      a.textContent = it.filename || it.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.style.color = '#aee3ff';
      a.style.textDecoration = 'none';
      a.addEventListener('mouseenter', () => a.style.textDecoration = 'underline');
      a.addEventListener('mouseleave', () => a.style.textDecoration = 'none');
      li.appendChild(a);

      const meta = document.createElement('span');
      meta.style.marginLeft = '8px';
      meta.style.opacity = '0.7';
      meta.textContent = `(@${it.screenName} ${it.tweetId})`;
      li.appendChild(meta);

      frag.appendChild(li);
    });
    ul.appendChild(frag);
  }

  function setDebugHtml(content, raw = '') {
    const box = document.getElementById('xm-debug-box');
    const pre = document.getElementById('xm-debug-pre');
    const btn = document.getElementById('xm-debug-copy');
    if (!box || !pre) return;
    if (!content) {
      pre.textContent = '';
      box.style.display = state.debug ? 'block' : 'none';
      state.debugHtmlRaw = '';
      if (btn) btn.disabled = true;
      return;
    }
    pre.textContent = content;
    box.style.display = 'block';
    state.debugHtmlRaw = raw || '';
    if (btn) btn.disabled = !state.debugHtmlRaw;
    debugLog('setDebugHtml', { previewLength: content.length, rawLength: raw?.length || 0 });
  }

  function createDebugSnippet(raw) {
    if (!raw) return '';
    return raw.length > DEBUG_SNIPPET_LIMIT ? raw.slice(0, DEBUG_SNIPPET_LIMIT) + '\n... (truncated)' : raw;
  }

  /* -------------------- Debug capture bridge -------------------- */

  function initDebugBridge() {
    if (debugBridgeInitialized) return;
    debugBridgeInitialized = true;
    if (typeof GM_addValueChangeListener === 'function') {
      GM_addValueChangeListener(DEBUG_CAPTURE_KEY, (_name, _oldValue, newValue, remote) => {
        if (!remote || !newValue) return;
        handleDebugCaptureMessage(safeJsonParse(newValue));
      });
    }
    window.addEventListener('storage', (event) => {
      if (event.key !== DEBUG_CAPTURE_KEY || !event.newValue) return;
      handleDebugCaptureMessage(safeJsonParse(event.newValue));
    });
  }

  function safeJsonParse(str) {
    try { return JSON.parse(str); } catch { return null; }
  }

  function handleDebugCaptureMessage(msg) {
    if (!msg || !msg.token) return;
    if (state.debugCaptureToken !== msg.token) return;
    debugLog('handleDebugCaptureMessage', { hasError: !!msg.error, rawLength: msg.raw?.length || 0 });
    clearDebugCaptureTimeout();
    state.debugCaptureToken = null;
    const waiter = state.debugCaptureWaiters.get(msg.token);
    if (state.debugTabRef && typeof state.debugTabRef.close === 'function' && msg.autoClose) {
      try { state.debugTabRef.close(); debugLog('closed debug tab via GM handle'); } catch { /* noop */ }
    }
    state.debugTabRef = null;
    if (waiter) {
      state.debugCaptureWaiters.delete(msg.token);
    }
    if (msg.error) {
      setDebugHtml(`(debug) ${msg.error}`, msg.raw || '');
      setStatus('デバッグHTML取得に失敗: ' + msg.error);
      waiter?.reject(new Error(msg.error));
      return;
    }
    const raw = msg.raw || '';
    const snippet = msg.snippet || createDebugSnippet(raw);
    setDebugHtml(snippet, raw);
    if (msg.mediaReady === false) {
      setStatus('デバッグHTMLを取得しました（メディア要素未検出）');
    } else {
      setStatus('デバッグHTMLを取得しました');
    }
    debugLog('debug HTML received', { mediaReady: msg.mediaReady !== false });
    waiter?.resolve({ raw, mediaReady: msg.mediaReady !== false });
  }

  function clearDebugCaptureTimeout() {
    if (state.debugCaptureTimer) {
      clearTimeout(state.debugCaptureTimer);
      state.debugCaptureTimer = null;
    }
  }

  function startDebugCapture(tweet) {
    if (!tweet) return null;
    initDebugBridge();
    if (state.debugCaptureToken) {
      const waiter = state.debugCaptureWaiters.get(state.debugCaptureToken);
      if (waiter) return { token: state.debugCaptureToken, promise: waiter.promise };
      return { token: state.debugCaptureToken, promise: Promise.reject(new Error('debug capture in progress')) };
    }
    const token = `dbg-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let resolveFn;
    let rejectFn;
    const promise = new Promise((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
    state.debugCaptureWaiters.set(token, { resolve: resolveFn, reject: rejectFn, promise });
    state.debugCaptureToken = token;
    setDebugHtml('(debug) JavaScript無効のページを検出: バックグラウンドのツイート詳細を解析中…');
    debugLog('startDebugCapture', { token, tweet });
    clearDebugCaptureTimeout();
    state.debugCaptureTimer = setTimeout(() => {
      if (state.debugCaptureToken !== token) return;
      state.debugCaptureTimer = null;
      state.debugCaptureToken = null;
      setDebugHtml('(debug) バックグラウンドのツイートDOM取得がタイムアウトしました');
      setStatus('デバッグタブから応答がありません (timeout)');
      debugLog('debug capture timeout');
      const waiter = state.debugCaptureWaiters.get(token);
      if (waiter) {
        state.debugCaptureWaiters.delete(token);
        waiter.reject(new Error('debug capture timeout'));
      }
    }, DEBUG_CAPTURE_TIMEOUT);
    const opened = openDebugInBackground(tweet, token);
    if (opened?.tab) state.debugTabRef = opened.tab;
    state.debugOpenedBackground = opened?.mode === 'background' || opened?.mode === 'window-fallback';
    if (opened?.mode === 'background') {
      setStatus('デバッグ用にツイート詳細をバックグラウンドで開きました');
    } else if (opened?.mode === 'window-fallback') {
      setStatus('デバッグ用にツイート詳細を開きました（フォーカスが移動する場合があります）');
    } else if (opened?.mode === 'same-tab') {
      setStatus('デバッグ用タブを開けないため、同一タブへ遷移します');
    }
    debugLog('debug tab opened', { mode: opened?.mode || 'failed' });
    return { token, promise };
  }

  function buildDebugUrlForTweet(tweet, token) {
    if (!tweet) return null;
    try {
      const base = tweet.detailPath
        ? new URL(tweet.detailPath, 'https://x.com')
        : new URL(`https://x.com/${tweet.screenName}/status/${tweet.tweetId}`);
      if (token) {
        base.searchParams.set('xm_debug_capture', '1');
        base.searchParams.set('xm_debug_token', token);
      }
      return base.toString();
    } catch (err) {
      console.warn('failed to build debug url', err);
      return null;
    }
  }

  function openDebugInBackground(tweet, token = '') {
    const targetUrl = buildDebugUrlForTweet(tweet, token);
    if (!targetUrl) return { tab: null, mode: 'failed' };
    try {
      const opened = openTabInBackground(targetUrl);
      if (!opened?.tab && opened?.mode !== 'same-tab') setStatus('デバッグ用タブのオープンに失敗しました');
      return opened;
    } catch (err) {
      console.warn('failed to open debug tab', err);
      setStatus('デバッグ用タブのオープンに失敗しました');
      return { tab: null, mode: 'failed' };
    }
  }

  function openTabInBackground(url) {
    try {
      if (typeof GM !== 'undefined' && typeof GM.openInTab === 'function') {
        const tab = GM.openInTab(url, { active: false, insert: true, setParent: true });
        if (tab) return { tab, mode: 'background' };
      } else if (typeof GM_openInTab === 'function') {
        const tab = GM_openInTab(url, { active: false, insert: true, setParent: true });
        if (tab) return { tab, mode: 'background' };
      }
    } catch (err) {
      console.debug(LOG_PREFIX, 'GM open tab failed', err?.message || err);
    }

    try {
      const w = window.open(url, '_blank', 'noopener,noreferrer');
      if (w) {
        try { w.blur(); } catch { /* noop */ }
        setTimeout(() => { try { window.focus(); } catch { /* noop */ } }, 50);
        return { tab: w, mode: 'window-fallback' };
      }
    } catch (err) {
      console.debug(LOG_PREFIX, 'window.open failed', err?.message || err);
    }

    try {
      location.assign(url);
      return { tab: null, mode: 'same-tab' };
    } catch {
      return { tab: null, mode: 'failed' };
    }
  }

  function sendDebugCaptureMessage(payload) {
    if (!payload) return;
    const enriched = { autoClose: true, ...payload, sentAt: Date.now() };
    const str = JSON.stringify(enriched);
    if (typeof GM_setValue === 'function') {
      GM_setValue(DEBUG_CAPTURE_KEY, str);
    }
    try {
      localStorage.setItem(DEBUG_CAPTURE_KEY, str);
      setTimeout(() => {
        try { localStorage.removeItem(DEBUG_CAPTURE_KEY); } catch { /* noop */ }
      }, 0);
    } catch {
      // noop
    }
    if (shouldCloseDebugTabAfterSend) {
      scheduleDebugWindowClose();
    }
  }

  function scheduleDebugWindowClose() {
    try {
      console.debug(LOG_PREFIX, 'schedule debug window close');
      setTimeout(() => {
        try {
          window.close();
        } catch (err) {
          console.debug(LOG_PREFIX, 'window.close failed', err);
        }
      }, 500);
    } catch {
      // noop
    }
  }

  function getDebugTokenFromLocation() {
    try {
      const search = new URLSearchParams(location.search);
      if (search.has('xm_debug_token')) return search.get('xm_debug_token');
      const hash = location.hash && location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
      if (hash) {
        const hashParams = new URLSearchParams(hash);
        if (hashParams.has('xm_debug_token')) return hashParams.get('xm_debug_token');
      }
    } catch {
      // noop
    }
    return null;
  }

  async function captureTweetDomForDebug(token) {
    if (!token) return;
    try {
      const group = await waitForDebugTweetGroup();
      if (!group) throw new Error('role="group" の要素が見つかりません');
      const timelineNodes = findTimelineConversationNodes(document);
      const captureNodes = timelineNodes.length ? timelineNodes : [group];
      await pumpTimeline(captureNodes);
      let mediaReady = true;
      for (const node of captureNodes) {
        try {
          await waitForMediaContent(node);
        } catch (err) {
          mediaReady = false;
          debugLog('waitForMediaContent error', err?.message || err);
        }
      }
      const rawParts = captureNodes.map(node => node.outerHTML || node.innerHTML || '').filter(Boolean);
      const raw = rawParts.join('\n');
      if (!raw) throw new Error('capture HTML を取得できませんでした');
      const snippetSource = rawParts[0] || raw;
      const snippet = createDebugSnippet(snippetSource);
      sendDebugCaptureMessage({ token, raw, snippet, mediaReady });
    } catch (err) {
      sendDebugCaptureMessage({ token, error: err?.message || String(err) });
    }
  }

  function waitForDebugTweetGroup(timeout = 15000) {
    const existing = document.querySelector('div[role="group"]');
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error('role="group" が見つかりません (timeout)'));
      }, timeout);
      const observer = new MutationObserver(() => {
        const el = document.querySelector('div[role="group"]');
        if (!el) return;
        clearTimeout(timer);
        observer.disconnect();
        resolve(el);
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    });
  }

  function hasMediaNodes(root) {
    if (!root) return false;
    if (root.querySelector('img[src*="pbs.twimg.com/"], img[srcset*="pbs.twimg.com/"]')) return true;
    const hasBg = Array.from(root.querySelectorAll('[style*="background-image"]')).some(el => {
      const style = el.getAttribute('style') || '';
      return /pbs\.twimg\.com/.test(style);
    });
    if (hasBg) return true;
    if (root.querySelector('video[src*="video.twimg.com"], video source[src*="video.twimg.com"], source[src*="video.twimg.com"], a[href*="video.twimg.com"]')) return true;
    return false;
  }

  const TIMELINE_CONV_SELECTORS = [
    '[aria-label="タイムライン: 会話"]',
    '[aria-label="タイムライン:会話"]',
    '[aria-label="タイムライン：会話"]',
    '[aria-label="タイムライン： 会話"]',
    '[aria-label="Timeline: Conversation"]',
    '[aria-label="Timeline: conversation"]',
    '[aria-label="Timeline: Conversation with"]'
  ];

  function findTimelineConversationNodes(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return [];
    const set = new Set();
    TIMELINE_CONV_SELECTORS.forEach(sel => {
      try {
        root.querySelectorAll(sel).forEach(node => set.add(node));
      } catch {
        // ignore invalid selectors
      }
    });
    if (set.size === 0) {
      try {
        root.querySelectorAll('[aria-label*="タイムライン"][aria-label*="会話"]').forEach(node => set.add(node));
      } catch {
        // noop
      }
    }
    if (set.size === 0) {
      try {
        root.querySelectorAll('[aria-label*="Timeline"][aria-label*="Conversation"]').forEach(node => set.add(node));
      } catch {
        // noop
      }
    }
    return Array.from(set);
  }

  function waitForMediaContent(group, timeout = 30000) {
    if (hasMediaNodes(group)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error('メディア要素が見つかりません (timeout)'));
        debugLog('waitForMediaContent timeout');
      }, timeout);
      const observer = new MutationObserver(() => {
        if (!hasMediaNodes(group)) return;
        clearTimeout(timer);
        observer.disconnect();
        resolve();
        debugLog('waitForMediaContent resolved');
      });
      observer.observe(group, { childList: true, subtree: true });
    });
  }

  async function pumpTimeline(nodes) {
    if (!nodes || !nodes.length) return;
    for (const node of nodes) {
      const scroller = node.querySelector('[data-testid="primaryColumn"] [data-testid="ScrollSnap-List"]')
        || node.querySelector('[data-testid="ScrollSnap-List"]')
        || node;
      for (let i = 0; i < 6; i++) {
        try {
          scroller.scrollTop = scroller.scrollHeight;
          scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
        } catch { /* noop */ }
        await sleep(250);
      }
    }
  }

  const debugTokenHere = getDebugTokenFromLocation();
  const shouldCloseDebugTabAfterSend = !!debugTokenHere;
  if (debugTokenHere) {
    captureTweetDomForDebug(debugTokenHere);
  }

  const state = {
    tweets: [],
    media: [],
    debug: false,
    debugHtmlRaw: '',
    debugOpenedBackground: false,
    debugCaptureToken: null,
    debugCaptureTimer: null,
    debugTabRef: null,
    debugCaptureWaiters: new Map(),
  };

  /* -------------------- Collect flow -------------------- */
  let stopFlag = false;

  async function onClickCollectUrls() {
    stopFlag = false;
    const btnUrl = document.getElementById('xm-btn-url');
    const btnMedia = document.getElementById('xm-btn-media');
    const btnDownload = document.getElementById('xm-btn-download');
    const btnStop = document.getElementById('xm-btn-stop');
    btnUrl.disabled = true; btnMedia.disabled = true; btnDownload.disabled = true; btnStop.style.display = '';
    state.tweets = [];
    renderTweetList([]);
    setDebugHtml(state.debug ? '(debug) HTML未取得' : '');
    btnStop.onclick = () => { stopFlag = true; setStatus('停止要求…'); };

    try {
      // 1) 正しいスクロールコンテナを決定
      const scroller = detectScrollContainer();
      const scInfo = scroller === window ? '[window]' : describeEl(scroller);
      setStatus(`スクロール対象: ${scInfo}`);

      const collector = createTweetCollector();

      // 2) 最後までスクロール
      await autoScrollToEnd(scroller, () => collector.addFromDom(document));

      if (stopFlag) { setStatus('停止しました'); return; }

      // 3) 収集結果を UI 表示
      const finalStats = collector.addFromDom(document); // 終了前に最終スナップショット
      setStatus(`URL収集完了: ${finalStats.total} 件`);
      const tweets = collector.getItems();
      state.tweets = tweets;
      renderTweetList(tweets);
      if (tweets.length > 0) {
        btnMedia.disabled = false;
      }
    } catch (e) {
      console.error(e);
      setStatus('収集中にエラー: ' + (e?.message || e));
    } finally {
      btnStop.style.display = 'none';
      btnUrl.disabled = false;
    }
  }

  async function onClickCollectMedia() {
    if (!state.tweets.length) {
      setStatus('先にURL収集を実行してください');
      return;
    }

    stopFlag = false;
    const btnUrl = document.getElementById('xm-btn-url');
    const btnMedia = document.getElementById('xm-btn-media');
    const btnDownload = document.getElementById('xm-btn-download');
    const btnStop = document.getElementById('xm-btn-stop');
    btnUrl.disabled = true; btnMedia.disabled = true; btnDownload.disabled = true; btnStop.style.display = '';
    state.media = [];
    state.debugOpenedBackground = false;
    clearDebugCaptureTimeout();
    state.debugCaptureToken = null;
    state.debugTabRef = null;
    state.debugCaptureWaiters.forEach(({ reject }) => {
      try { reject?.(new Error('debug capture reset')); } catch { /* noop */ }
    });
    state.debugCaptureWaiters.clear();
    renderMediaList([]);
    setDebugHtml(state.debug ? '(debug) HTML取得中…' : '');
    btnStop.onclick = () => { stopFlag = true; setStatus('停止要求…'); };

    try {
      const targetTweets = state.debug ? state.tweets.slice(0, 1) : state.tweets.slice();
      if (!targetTweets.length) {
        setStatus('メディア取得対象のツイートがありません');
        return;
      }

      if (state.debug) {
        setStatus('デバッグモード: 最初の1件のみメディアを取得します');
      }

      const mediaMap = new Map();
      for (let i = 0; i < targetTweets.length; i++) {
        if (stopFlag) break;
        const tweet = targetTweets[i];
        setStatus(`メディア取得中 (${i + 1}/${targetTweets.length}): @${tweet.screenName}`);
        try {
          const captureHtml = state.debug && i === 0;
          const items = await fetchTweetMedia(tweet, captureHtml);
          debugLog('tweet media fetched', { tweetId: tweet.tweetId, count: items.length });
          for (const item of items) {
            const key = `${item.type}|${item.url}`;
            if (!mediaMap.has(key)) mediaMap.set(key, item);
          }
        } catch (err) {
          console.warn('メディア取得失敗', tweet, err);
          debugLog('tweet media fetch error', err?.message || err);
        }
        if (i < targetTweets.length - 1 && !stopFlag) {
          await sleep(2000);
        }
      }

      state.media = addFilenames(Array.from(mediaMap.values()));
      renderMediaList(state.media);
      debugLog('mediaMap summary', { uniqueItems: mediaMap.size, rendered: state.media.length });
      if (!stopFlag) {
        setStatus(`メディア取得完了: ${state.media.length} 件`);
      } else {
        setStatus(`停止しました (取得済: ${state.media.length} 件)`);
      }
      btnDownload.disabled = state.media.length === 0;
    } catch (e) {
      console.error(e);
      setStatus('メディア取得中にエラー: ' + (e?.message || e));
    } finally {
      btnStop.style.display = 'none';
      btnUrl.disabled = false;
      btnMedia.disabled = false;
    }
  }

  async function onClickDownloadZip() {
    if (!state.media.length) {
      setStatus('先にメディア取得を実行してください');
      return;
    }

    stopFlag = false;
    const btnUrl = document.getElementById('xm-btn-url');
    const btnMedia = document.getElementById('xm-btn-media');
    const btnDownload = document.getElementById('xm-btn-download');
    const btnStop = document.getElementById('xm-btn-stop');
    btnUrl.disabled = true; btnMedia.disabled = true; btnDownload.disabled = true; btnStop.style.display = '';
    btnStop.onclick = () => {
      stopFlag = true;
      abortActiveDownload();
      setStatus('停止要求…');
    };

    let successCount = 0;
    let failedCount = 0;

    try {
      const entries = [];
      const archiveName = buildArchiveFilename(state.media);
      for (let i = 0; i < state.media.length; i++) {
        if (stopFlag) break;
        const item = state.media[i];
        const ordinal = `${i + 1}/${state.media.length}`;
        setStatus(`ZIP取得中 (${ordinal}): ${item.filename} 成功=${successCount} 失敗=${failedCount}`);
        try {
          const bytes = await downloadMediaBytes(item, ({ loaded, total }) => {
            const progressText = total ? `${formatBytes(loaded)} / ${formatBytes(total)}` : `${formatBytes(loaded)}`;
            setStatus(`ZIP取得中 (${ordinal}): ${item.filename} ${progressText} 成功=${successCount} 失敗=${failedCount}`);
          });
          entries.push({ filename: item.filename, bytes, modifiedAt: Date.now() });
          successCount += 1;
        } catch (err) {
          if (stopFlag && isAbortError(err)) break;
          failedCount += 1;
          console.warn('ZIP media download failed', item, err);
          setStatus(`ZIP取得失敗 (${ordinal}): ${item.filename} 成功=${successCount} 失敗=${failedCount}`);
        }
        await sleep(0);
      }

      if (stopFlag) {
        setStatus(`停止しました (ZIP未生成: 成功=${successCount} 失敗=${failedCount})`);
        return;
      }

      if (!entries.length) {
        setStatus(`ZIP生成対象がありません (失敗=${failedCount})`);
        return;
      }

      const zipBlob = await buildStoredZip(entries, ({ index, total, filename }) => {
        setStatus(`ZIP生成中 (${index}/${total}): ${filename} 成功=${successCount} 失敗=${failedCount}`);
      });
      triggerBlobDownload(zipBlob, archiveName);
      const summary = failedCount > 0
        ? `ZIPダウンロード準備完了: ${archiveName} (成功=${successCount} 失敗=${failedCount})`
        : `ZIPダウンロード準備完了: ${archiveName} (${successCount} 件)`;
      setStatus(summary);
    } catch (e) {
      if (stopFlag && isAbortError(e)) {
        setStatus(`停止しました (ZIP未生成: 成功=${successCount} 失敗=${failedCount})`);
      } else {
        console.error(e);
        setStatus('ZIP生成中にエラー: ' + (e?.message || e));
      }
    } finally {
      abortActiveDownload();
      btnStop.style.display = 'none';
      btnUrl.disabled = false;
      btnMedia.disabled = false;
      btnDownload.disabled = state.media.length === 0;
    }
  }

  /* -------------------- Robust auto-scroll -------------------- */

  // 1) スクロールコンテナ自動検出
  function detectScrollContainer() {
    // 候補を列挙（上ほど優先）
    const candidates = [
      document.scrollingElement,
      document.querySelector('[data-testid="primaryColumn"] [role="region"]'),
      document.querySelector('[data-testid="primaryColumn"]'),
      document.querySelector('main [role="region"]'),
      document.querySelector('main'),
      document.body,
      document.documentElement,
    ].filter(Boolean);

    // 最も「スクロール可能」な要素（overflowYがscroll/auto、かつ scrollHeight > clientHeight）を選ぶ
    let best = null, bestScore = -1;
    for (const el of candidates) {
      const style = el === window ? null : getComputedStyle(el);
      const overflowY = style?.overflowY;
      const scrollHeight = el.scrollHeight || document.scrollingElement.scrollHeight;
      const clientHeight = el.clientHeight || innerHeight;
      const canScroll = (overflowY === 'auto' || overflowY === 'scroll' || el === document.scrollingElement || el === document.documentElement || el === document.body);
      const delta = scrollHeight - clientHeight;
      const score = (canScroll ? 1 : 0) * 1000000 + delta; // 雑に delta を優先
      if (delta > 0 && score > bestScore) { best = el; bestScore = score; }
    }
    // どれも駄目なら window
    return best || window;
  }

  function describeEl(el) {
    if (!el || el === window) return '[window]';
    const id = el.id ? `#${el.id}` : '';
    const cls = el.className && typeof el.className === 'string' ? '.' + el.className.split(/\s+/).filter(Boolean).join('.') : '';
    return `<${el.tagName.toLowerCase()}${id}${cls}>`;
  }

  // 2) scrollHeight 収束＋scrollIntoView フォールバック
  async function autoScrollToEnd(scroller, onProgress) {
    const MAX_IDLE = 3;          // 高さ/件数が増えないラウンドが続いたら終端
    const MAX_TIME = 120_000;    // 120秒の安全タイムアウト
    const WAITS = [250, 350, 500, 700, 900, 1200, 1600, 2000];

    // 開始時なるべくトップへ
    if (scroller === window) scrollTo({ top: 0, behavior: 'auto' });
    else scroller.scrollTop = 0;

    let idle = 0, backoff = 0;
    const t0 = performance.now();

    const initialProgress = onProgress?.(document) || {};
    if (initialProgress.total) {
      setStatus(`スクロール開始: 現在 ${initialProgress.total} 件`);
    }

    while (!stopFlag && idle < MAX_IDLE && (performance.now() - t0) < MAX_TIME) {
      const before = getScrollMetrics(scroller);

      // メイン手段：コンテナの最下部へ
      if (scroller === window) scrollTo({ top: before.scrollHeight, behavior: 'auto' });
      else scroller.scrollTop = before.scrollHeight;

      // フォールバック：グリッド最下段のメディアを scrollIntoView で押し込む
      const lastCard = findLastTweetCard();
      if (lastCard) lastCard.scrollIntoView({ block: 'end', inline: 'nearest', behavior: 'auto' });

      // 待機（ネットワーク・描画安定）
      await sleep(WAITS[Math.min(backoff, WAITS.length - 1)]);

      const after = getScrollMetrics(scroller);
      const grew = (after.scrollHeight > before.scrollHeight + 2) || (after.count > before.count);

      const progress = onProgress?.(document) || {};

      const total = progress.total ?? after.count;
      const added = progress.added ?? Math.max(0, after.count - before.count);
      const effectiveGrew = grew || (added > 0);
      setStatus(`スクロール中: 高さ ${after.scrollHeight} (Δ${after.scrollHeight - before.scrollHeight}), 収集 ${total} 件 (＋${added}), idle=${effectiveGrew ? 0 : idle + 1}`);

      if (effectiveGrew) { idle = 0; backoff = 0; }
      else { idle++; if (backoff < WAITS.length - 1) backoff++; }
    }
  }

  function getScrollMetrics(scroller) {
    const sh = scroller === window
      ? (document.scrollingElement || document.documentElement).scrollHeight
      : scroller.scrollHeight;
    return { scrollHeight: sh, count: countTweetCards(document) };
  }

  function findLastTweetCard() {
    const nodes = document.querySelectorAll('li[role="listitem"]');
    return nodes[nodes.length - 1] || null;
  }

  function countTweetCards(root) {
    return root.querySelectorAll('li[role="listitem"]').length;
  }

  /* -------------------- Tweet URL collection -------------------- */
  function createTweetCollector() {
    const tweets = new Map();
    return {
      addFromDom(root) {
        const added = collectTweetUrls(root, tweets);
        return { added, total: tweets.size };
      },
      getItems() {
        return Array.from(tweets.values());
      }
    };
  }

  function collectTweetUrls(root, store) {
    let added = 0;
    const cards = root.querySelectorAll('li[role="listitem"]');
    cards.forEach(card => {
      const info = extractTweetFromCard(card);
      if (!info) return;
      if (!store.has(info.key)) {
        store.set(info.key, info);
        added++;
      }
    });
    return added;
  }

  function extractTweetFromCard(card) {
    if (!card) return null;
    const hints = analyzeMediaHints(card);
    if (!hints.hasMedia) return null;

    const anchor = findStatusAnchor(card);
    if (!anchor) return null;
    const info = parseTweetFromHref(anchor.getAttribute('href') || '');
    if (!info) return null;

    const summary = summarizeMediaHints(hints);
    const detailPath = anchor.getAttribute('href') || '';
    return {
      key: `${info.screenName}:${info.tweetId}`,
      screenName: info.screenName,
      tweetId: info.tweetId,
      url: `https://x.com/${info.screenName}/status/${info.tweetId}`,
      detailPath,
      mediaSummary: summary,
      hints
    };
  }

  function findStatusAnchor(card) {
    const anchors = card.querySelectorAll('a[href*="/status/"]');
    let fallback = null;
    for (const anchor of anchors) {
      const href = anchor.getAttribute('href') || '';
      if (!href.startsWith('/')) continue;
      const parsed = parseTweetFromHref(href);
      if (!parsed) continue;
      if (!fallback) fallback = anchor;
      if (!/\/(photo|video)\//.test(href)) {
        return anchor;
      }
    }
    return fallback;
  }

  function parseTweetFromHref(href) {
    if (!href) return null;
    const m = href.match(/^\/([^/?#]+)\/status\/(\d+)/);
    if (!m) return null;
    return { screenName: m[1], tweetId: m[2] };
  }

  function analyzeMediaHints(card) {
    const hasPhoto = !!(card.querySelector('a[href*="/photo/"]') || card.querySelector('img[src*="pbs.twimg.com/"]'));
    const hasVideo = !!(card.querySelector('a[href*="/video/"]') || card.querySelector('video, source[src*="video.twimg.com"]'));
    const iconPath = card.querySelector('a[href*="/status/"] svg path');
    const pathD = iconPath?.getAttribute('d') || '';
    const isMulti = /M2\s*8\.5C2\s*7\.12/.test(pathD) || pathD.includes('19.5 4');
    return {
      hasMedia: hasPhoto || hasVideo,
      hasPhoto,
      hasVideo,
      isMulti
    };
  }

  function summarizeMediaHints(hints) {
    if (!hints?.hasMedia) return '';
    const parts = [];
    if (hints.hasPhoto) parts.push('photo');
    if (hints.hasVideo) parts.push('video');
    let summary = parts.join('+') || 'media';
    if (hints.isMulti) summary = `multi-${summary}`;
    return summary;
  }

  async function fetchTweetMedia(tweet, captureHtml = false) {
    const endpoints = [];
    if (tweet.detailPath) {
      try {
        const detailUrl = ensurePrefetchParam(new URL(tweet.detailPath, 'https://x.com').toString());
        endpoints.push(detailUrl);
      } catch {
        // ignore invalid detailPath
      }
    }
    const baseStatus = ensurePrefetchParam(`https://x.com/${tweet.screenName}/status/${tweet.tweetId}`);
    if (!endpoints.includes(baseStatus)) endpoints.push(baseStatus);
    const fallback = ensurePrefetchParam(`https://x.com/i/web/status/${tweet.tweetId}`);
    if (!endpoints.includes(fallback)) endpoints.push(fallback);
    let html = null;
    for (const url of endpoints) {
      try {
        const resp = await fetch(url, {
          credentials: 'include',
          headers: {
            'x-twitter-active-user': 'yes',
            'x-twitter-client-language': navigator.language || 'en'
          }
        });
        if (resp.ok) {
          html = await resp.text();
          break;
        }
      } catch (err) {
        console.warn('tweet fetch failed', url, err);
      }
    }
    if (!html) {
      if (captureHtml) setDebugHtml('(debug) HTML取得に失敗しました');
      return [];
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    if (!doc) {
      if (captureHtml) setDebugHtml('(debug) HTML のパースに失敗しました');
      return [];
    }

    const looksDisabled = /JavaScriptを使用できません/.test(html) || html.includes('id="ScriptLoadFailure"');
    if (looksDisabled) {
      try {
        const capture = startDebugCapture(tweet);
        if (capture?.promise) {
          const captureResult = await capture.promise;
          const rawGroupHtml = (captureResult && typeof captureResult === 'object') ? (captureResult.raw || '') : (captureResult || '');
          const mediaReadyFlag = (captureResult && typeof captureResult === 'object') ? captureResult.mediaReady : undefined;
          if (rawGroupHtml) {
            debugLog('processing debug HTML from capture', { length: rawGroupHtml.length, mediaReady: mediaReadyFlag });
            const fromDebug = collectMediaFromDebugHtml(rawGroupHtml, tweet);
            debugLog('media collected from debug HTML', { count: fromDebug.length });
            if (fromDebug.length) {
              setStatus(`デバッグHTMLからメディアを取得 (${fromDebug.length} 件)`);
              return fromDebug;
            }
            if (mediaReadyFlag === false) {
              setStatus('デバッグHTML受信済み: メディア要素が見つかりませんでした (タイムアウト)');
            } else {
              setStatus('デバッグHTMLを解析しましたがメディアが見つかりませんでした');
            }
          }
        } else {
          setDebugHtml('(debug) バックグラウンドのツイート詳細からHTML取得待ちです…', html);
          debugLog('waiting for debug capture (promise missing)');
        }
      } catch (err) {
        console.warn('debug capture flow failed', err);
        debugLog('debug capture flow failed', err?.message || err);
      }
      return [];
    }

    if (captureHtml) {
      const group = doc.querySelector('div[role="group"]');
      if (group) {
        const htmlStr = group.outerHTML || group.innerHTML || '';
        const snippet = createDebugSnippet(htmlStr);
        clearDebugCaptureTimeout();
        state.debugCaptureToken = null;
        setDebugHtml(snippet, htmlStr);
        debugLog('using inline tweet HTML', { length: htmlStr.length });
      } else {
        setDebugHtml('(debug) role="group" の要素が見つかりませんでした', html);
        debugLog('role="group" not found in inline HTML');
      }
    }

    const collected = collectMediaFromDoc(doc, tweet);
    debugLog('media collected from inline document', { count: collected.length });
    return collected;
  }

  function collectMediaFromDebugHtml(html, tweet) {
    if (!html) return [];
    try {
      const tmpDoc = document.implementation.createHTMLDocument('xm-debug');
      tmpDoc.body.innerHTML = html;
      const items = collectMediaFromDoc(tmpDoc, tweet);
      debugLog('collectMediaFromDebugHtml result', { count: items.length });
      return items;
    } catch (err) {
      console.warn('collectMediaFromDebugHtml failed', err);
      debugLog('collectMediaFromDebugHtml failed', err?.message || err);
      return [];
    }
  }

  function findArticleForTweet(doc, tweetId) {
    const selector = `article a[href*="/status/${tweetId}"]`;
    const anchor = doc.querySelector(selector);
    return anchor?.closest('article') || null;
  }

  function ensurePrefetchParam(url) {
    try {
      const u = new URL(url);
      if (!u.searchParams.has('prefetch')) {
        u.searchParams.set('prefetch', '1');
      }
      return u.toString();
    } catch {
      return url;
    }
  }

  function collectMediaFromArticle(article, tweet) {
    const items = [];
    const seen = new Set();

    const pushItem = (type, rawUrl, meta = {}) => {
      const normalized = type === 'img' ? normalizeImageUrl(rawUrl) : normalizeVideoUrl(rawUrl);
      if (!normalized) return;
      const key = `${type}|${normalized}`;
      if (seen.has(key)) return;
      seen.add(key);
      items.push({
        type,
        url: normalized,
        tweetId: tweet.tweetId,
        screenName: tweet.screenName,
        meta
      });
    };

    if (!article) return items;

    const photoBlocks = article.querySelectorAll('[data-testid="tweetPhoto"], div[aria-label="画像"], div[aria-label="Image"]');
    photoBlocks.forEach(block => {
      block.querySelectorAll('img').forEach(img => {
        const raw = img.currentSrc || img.src || img.getAttribute('src');
        if (!raw) return;
        pushItem('img', raw);
      });
      block.querySelectorAll('[style*="background-image"]').forEach(el => {
        const style = el.getAttribute('style') || '';
        const match = style.match(/background-image:\s*url\((['"]?)(.*?)\1\)/i);
        if (match) pushItem('img', match[2]);
      });
    });

    article.querySelectorAll('img[src*="pbs.twimg.com/"]').forEach(img => {
      const raw = img.currentSrc || img.src || img.getAttribute('src');
      if (!raw) return;
      pushItem('img', raw);
    });

    article.querySelectorAll('video, source[src*="video.twimg.com"], a[href*="video.twimg.com"]').forEach(node => {
      let raw = null;
      if (node.tagName === 'VIDEO') raw = node.currentSrc || node.src || node.getAttribute('src');
      else if (node.tagName === 'SOURCE') raw = node.src || node.getAttribute('src');
      else if (node.tagName === 'A') raw = node.href || node.getAttribute('href');
      if (!raw) return;
      pushItem('mp4', raw);
    });

    return items;
  }

  function collectMediaFromDoc(doc, tweet) {
    const aggregate = new Map();
    const addFromArticle = (article, label) => {
      if (!article) return;
      const items = collectMediaFromArticle(article, tweet);
      debugLog('collectMediaFromArticle', { label, count: items.length });
      for (const item of items) {
        const key = `${item.type}|${item.url}`;
        if (!aggregate.has(key)) aggregate.set(key, item);
      }
    };

    const primaryArticle = findArticleForTweet(doc, tweet.tweetId);
    if (primaryArticle) addFromArticle(primaryArticle, 'primary');

    if (aggregate.size === 0) {
      const timelineNodes = findTimelineConversationNodes(doc);
      timelineNodes.forEach((node, idx) => {
        const article = node.querySelector(`article a[href*="/status/${tweet.tweetId}"]`)?.closest('article');
        if (article) addFromArticle(article, `timeline-${idx}`);
      });
    }

    if (aggregate.size === 0 && doc !== document) {
      addFromArticle(doc.querySelector(`article a[href*="/status/${tweet.tweetId}"]`)?.closest('article'), 'fallback-doc');
    }

    if (aggregate.size === 0) {
      addFromArticle(doc, 'document');
    }

    return Array.from(aggregate.values());
  }

  function normalizeImageUrl(u) {
    try {
      const url = new URL(u, location.origin);
      if (!/pbs\.twimg\.com/.test(url.hostname)) return null;
      const pathname = url.pathname || '';
      const allowed = /\/media\//.test(pathname) || /\/tweet_video\//.test(pathname) || /\/amplify-video\//.test(pathname) || /\/ext_tw_video\//.test(pathname) || /\/card_img\//.test(pathname);
      if (!allowed) return null;
      url.searchParams.set('name', 'orig');
      if (!url.searchParams.has('format') && !/\.(jpg|png|webp)$/i.test(url.pathname)) {
        url.searchParams.set('format', 'jpg');
      }
      return url.toString();
    } catch {
      return null;
    }
  }

  function normalizeVideoUrl(u) {
    try {
      const url = new URL(u, location.origin);
      if (!/video\.twimg\.com$/i.test(url.hostname) && !/\.video\.twimg\.com$/i.test(url.hostname)) return null;
      if (!/\.mp4$/i.test(url.pathname)) return null;
      return url.toString();
    } catch {
      return null;
    }
  }

  function addFilenames(items) {
    const counter = new Map();
    return items.map(item => {
      const key = `${item.screenName}:${item.tweetId}`;
      const set = counter.get(key) || { next: 1, used: new Set() };
      const index = set.next;
      set.used.add(index);
      set.next += 1;
      counter.set(key, set);
      const ext = guessExt(item.type, item.url);
      const filename = `${item.screenName}_${item.tweetId}_${String(index).padStart(2, '0')}.${ext}`;
      return { ...item, filename };
    });
  }

  function guessExt(type, url) {
    if (type === 'mp4') return 'mp4';
    try {
      const u = new URL(url);
      const fmt = u.searchParams.get('format');
      if (fmt) return sanitizeExt(fmt);
      const match = u.pathname.match(/\.(jpg|jpeg|png|webp)$/i);
      if (match) return sanitizeExt(match[1]);
    } catch {
      // noop
    }
    return 'jpg';
  }

  function sanitizeExt(ext) {
    const lower = (ext || '').toLowerCase();
    return lower === 'jpeg' ? 'jpg' : lower;
  }

  async function downloadMediaBytes(item, onProgress) {
    if (typeof GM_xmlhttpRequest === 'function') {
      return downloadMediaBytesViaGm(item, onProgress);
    }
    return downloadMediaBytesViaFetch(item, onProgress);
  }

  function downloadMediaBytesViaGm(item, onProgress) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let req = null;
      const abort = () => {
        try { req?.abort(); } catch { /* noop */ }
      };
      activeDownloadAbort = abort;

      const finalize = (fn) => (value) => {
        if (settled) return;
        settled = true;
        if (activeDownloadAbort === abort) activeDownloadAbort = null;
        fn(value);
      };

      req = GM_xmlhttpRequest({
        method: 'GET',
        url: item.url,
        responseType: 'arraybuffer',
        onprogress: (event) => {
          if (stopFlag) {
            abort();
            return;
          }
          onProgress?.({ loaded: event.loaded || 0, total: event.total || 0 });
        },
        onload: finalize((resp) => {
          const status = Number(resp?.status || 0);
          if (status < 200 || status >= 300) {
            reject(new Error(`HTTP ${status || 'error'}`));
            return;
          }
          const response = resp?.response;
          if (!(response instanceof ArrayBuffer)) {
            reject(new Error('arraybuffer response is unavailable'));
            return;
          }
          resolve(new Uint8Array(response));
        }),
        onabort: finalize(() => reject(createAbortError())),
        onerror: finalize(() => reject(new Error('network error'))),
        ontimeout: finalize(() => reject(new Error('timeout'))),
      });
    });
  }

  async function downloadMediaBytesViaFetch(item, onProgress) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    activeDownloadAbort = abort;
    try {
      const resp = await fetch(item.url, {
        method: 'GET',
        mode: 'cors',
        credentials: 'omit',
        signal: controller.signal,
      });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      if (!resp.body) {
        const buffer = await resp.arrayBuffer();
        return new Uint8Array(buffer);
      }
      const total = Number(resp.headers.get('content-length') || 0);
      const reader = resp.body.getReader();
      const chunks = [];
      let loaded = 0;
      while (true) {
        if (stopFlag) controller.abort();
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.byteLength;
        onProgress?.({ loaded, total });
      }
      const merged = new Uint8Array(loaded);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return merged;
    } catch (err) {
      if (err?.name === 'AbortError') throw createAbortError();
      throw err;
    } finally {
      if (activeDownloadAbort === abort) activeDownloadAbort = null;
    }
  }

  async function buildStoredZip(entries, onProgress) {
    if (entries.length > ZIP_MAX_ENTRIES) {
      throw new Error('ZIP64 未対応のため、ファイル数が多すぎます');
    }

    const fileParts = [];
    const centralParts = [];
    let offset = 0;
    let centralSize = 0;

    for (let i = 0; i < entries.length; i++) {
      if (stopFlag) throw createAbortError();
      const entry = entries[i];
      onProgress?.({ index: i + 1, total: entries.length, filename: entry.filename });
      const nameBytes = utf8Encoder.encode(entry.filename);
      const bytes = entry.bytes instanceof Uint8Array ? entry.bytes : new Uint8Array(entry.bytes);
      const { dosDate, dosTime } = toDosDateTime(entry.modifiedAt);
      const crc = crc32(bytes);
      const localHeader = createLocalFileHeader(nameBytes, bytes.byteLength, crc, dosTime, dosDate);
      const centralHeader = createCentralDirectoryHeader(nameBytes, bytes.byteLength, crc, dosTime, dosDate, offset);
      const entrySize = localHeader.byteLength + nameBytes.byteLength + bytes.byteLength;

      if (offset + entrySize > ZIP_MAX_UINT32) {
        throw new Error('ZIP64 未対応のため、ZIP サイズが大きすぎます');
      }

      fileParts.push(localHeader, nameBytes, bytes);
      centralParts.push(centralHeader, nameBytes);
      offset += entrySize;
      centralSize += centralHeader.byteLength + nameBytes.byteLength;

      if ((i + 1) % 10 === 0) await sleep(0);
    }

    if (offset + centralSize > ZIP_MAX_UINT32) {
      throw new Error('ZIP64 未対応のため、ZIP サイズが大きすぎます');
    }

    const eocd = createEndOfCentralDirectory(entries.length, centralSize, offset);
    return new Blob([...fileParts, ...centralParts, eocd], { type: 'application/zip' });
  }

  function createLocalFileHeader(nameBytes, size, crc, dosTime, dosDate) {
    const header = new ArrayBuffer(30);
    const view = new DataView(header);
    view.setUint32(0, ZIP_LOCAL_FILE_HEADER_SIG, true);
    view.setUint16(4, ZIP_VERSION_NEEDED, true);
    view.setUint16(6, ZIP_UTF8_FLAG, true);
    view.setUint16(8, ZIP_STORE_METHOD, true);
    view.setUint16(10, dosTime, true);
    view.setUint16(12, dosDate, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, size, true);
    view.setUint32(22, size, true);
    view.setUint16(26, nameBytes.byteLength, true);
    view.setUint16(28, 0, true);
    return new Uint8Array(header);
  }

  function createCentralDirectoryHeader(nameBytes, size, crc, dosTime, dosDate, localHeaderOffset) {
    const header = new ArrayBuffer(46);
    const view = new DataView(header);
    view.setUint32(0, ZIP_CENTRAL_DIRECTORY_SIG, true);
    view.setUint16(4, ZIP_VERSION_NEEDED, true);
    view.setUint16(6, ZIP_VERSION_NEEDED, true);
    view.setUint16(8, ZIP_UTF8_FLAG, true);
    view.setUint16(10, ZIP_STORE_METHOD, true);
    view.setUint16(12, dosTime, true);
    view.setUint16(14, dosDate, true);
    view.setUint32(16, crc, true);
    view.setUint32(20, size, true);
    view.setUint32(24, size, true);
    view.setUint16(28, nameBytes.byteLength, true);
    view.setUint16(30, 0, true);
    view.setUint16(32, 0, true);
    view.setUint16(34, 0, true);
    view.setUint16(36, 0, true);
    view.setUint32(38, 0, true);
    view.setUint32(42, localHeaderOffset, true);
    return new Uint8Array(header);
  }

  function createEndOfCentralDirectory(entryCount, centralSize, centralOffset) {
    const footer = new ArrayBuffer(22);
    const view = new DataView(footer);
    view.setUint32(0, ZIP_END_OF_CENTRAL_DIRECTORY_SIG, true);
    view.setUint16(4, 0, true);
    view.setUint16(6, 0, true);
    view.setUint16(8, entryCount, true);
    view.setUint16(10, entryCount, true);
    view.setUint32(12, centralSize, true);
    view.setUint32(16, centralOffset, true);
    view.setUint16(20, 0, true);
    return new Uint8Array(footer);
  }

  function triggerBlobDownload(blob, filename) {
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
  }

  function buildArchiveFilename(items) {
    const first = items[0];
    const screenName = sanitizeArchiveSegment(first?.screenName || getScreenNameFromPath() || 'x_media');
    return `${screenName}_media_${formatTimestamp(new Date())}.zip`;
  }

  function sanitizeArchiveSegment(value) {
    return String(value || 'x_media').replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'x_media';
  }

  function getScreenNameFromPath() {
    const match = location.pathname.match(/^\/([^/]+)\/media\/?$/);
    return match ? match[1] : '';
  }

  function formatTimestamp(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hour = String(date.getHours()).padStart(2, '0');
    const minute = String(date.getMinutes()).padStart(2, '0');
    const second = String(date.getSeconds()).padStart(2, '0');
    return `${year}${month}${day}_${hour}${minute}${second}`;
  }

  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }
    const digits = value >= 10 || unitIndex === 0 ? 0 : 1;
    return `${value.toFixed(digits)} ${units[unitIndex]}`;
  }

  function createAbortError() {
    const err = new Error('download aborted');
    err.name = 'AbortError';
    return err;
  }

  function isAbortError(err) {
    return err?.name === 'AbortError';
  }

  function abortActiveDownload() {
    if (typeof activeDownloadAbort !== 'function') return;
    try { activeDownloadAbort(); } catch { /* noop */ }
    activeDownloadAbort = null;
  }

  function toDosDateTime(value) {
    const date = value ? new Date(value) : new Date();
    const year = Math.max(1980, date.getFullYear());
    const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    return { dosDate, dosTime };
  }

  const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let bit = 0; bit < 8; bit++) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[i] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  /* -------------------- Boot -------------------- */
  onUrlChange.start(() => {
    if (isProfileMediaPage()) waitForBody().then(createPanel);
    else removePanel();
  });
  function waitForBody() {
    if (document.body) return Promise.resolve();
    return new Promise((res) => {
      const mo = new MutationObserver(() => { if (document.body) { mo.disconnect(); res(); } });
      mo.observe(document.documentElement, { childList: true, subtree: true });
    });
  }
})();
