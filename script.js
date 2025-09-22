// ==UserScript==
// @name         X Profile Media UI (Top-right Panel) - Solid AutoScroll & List
// @namespace    your-namespace
// @version      0.4.0
// @description  On x.com/<user>/media: robust auto-scroll (detects real scroller, with scrollIntoView fallback), then list filenames (IMG + MP4; no m3u8).
// @match        https://x.com/*
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

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
        <button id="xm-btn-collect" class="xm-btn">収集</button>
        <button id="xm-btn-download" class="xm-btn" disabled>ダウンロード</button>
        <button id="xm-btn-stop" class="xm-btn" style="display:none">停止</button>
      </div>
      <div class="xm-status" id="xm-status">mediaページ検出</div>
      <div class="xm-list" id="xm-list"><ul id="xm-ul"></ul></div>
    `;
    document.body.appendChild(panel);
    document.getElementById('xm-btn-collect').addEventListener('click', onClickCollect);
    document.getElementById('xm-btn-download').addEventListener('click', () => setStatus('ダウンロード（未実装）'));
    makeDraggable(panel);
  }
  function removePanel() { const el = document.getElementById(PANEL_ID); if (el) el.remove(); }
  function setStatus(text) { const s = document.getElementById('xm-status'); if (s) s.textContent = text; }
    function renderList(items) {
        const ul = document.getElementById('xm-ul'); if (!ul) return;
        ul.innerHTML = '';
        const frag = document.createDocumentFragment();

        for (const it of items) {
            const li = document.createElement('li');

            // 種別ラベル [IMG] / [MP4]
            const spanType = document.createElement('span');
            spanType.className = 'type';
            spanType.textContent = `[${it.type.toUpperCase()}]`;
            li.appendChild(spanType);

      // ファイル名をリンク化（新規タブで開く）
      const a = document.createElement('a');
      a.href = it.url;
      a.textContent = it.filename;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      // 長いURLでも見やすいように
      a.style.color = '#aee3ff';
      a.style.textDecoration = 'none';
      a.addEventListener('mouseenter', () => a.style.textDecoration = 'underline');
      a.addEventListener('mouseleave', () => a.style.textDecoration = 'none');

      li.appendChild(a);
      frag.appendChild(li);
  }

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

  /* -------------------- Collect flow -------------------- */
  let stopFlag = false;

  async function onClickCollect() {
    stopFlag = false;
    const btnCollect = document.getElementById('xm-btn-collect');
    const btnDownload = document.getElementById('xm-btn-download');
    const btnStop = document.getElementById('xm-btn-stop');
    btnCollect.disabled = true; btnDownload.disabled = true; btnStop.style.display = '';
    btnStop.onclick = () => { stopFlag = true; setStatus('停止要求…'); };

    try {
      // 1) 正しいスクロールコンテナを決定
      const scroller = detectScrollContainer();
      const scInfo = scroller === window ? '[window]' : describeEl(scroller);
      setStatus(`スクロール対象: ${scInfo}`);

      const collector = createCollector();

      // 2) 最後までスクロール
      await autoScrollToEnd(scroller, () => collector.addFromDom(document));

      if (stopFlag) { setStatus('停止しました'); return; }

      // 3) 全量収集→ファイル名生成→UI表示
      const finalStats = collector.addFromDom(document); // 終了直前の表示分も拾う
      setStatus(`全量収集中… (収集済: ${finalStats.total} 件)`);
      const itemsRaw = collector.getItems();
      const items = addFilenames(itemsRaw);
      renderList(items);
      setStatus(`収集完了: ${items.length} 件`);
      btnDownload.disabled = false;
    } catch (e) {
      console.error(e);
      setStatus('収集中にエラー: ' + (e?.message || e));
    } finally {
      btnStop.style.display = 'none';
      btnCollect.disabled = false;
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
      const lastMedia = findLastMediaNode();
      if (lastMedia) lastMedia.scrollIntoView({ block: 'end', inline: 'nearest', behavior: 'auto' });

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
    return { scrollHeight: sh, count: countMediaNodes(document) };
  }

  function findLastMediaNode() {
    const nodes = document.querySelectorAll(
      'img[src*="pbs.twimg.com/media/"], a[href*="video.twimg.com"][href*=".mp4"], source[src*="video.twimg.com"][src*=".mp4"]'
    );
    return nodes[nodes.length - 1] || null;
  }

  function countMediaNodes(root) {
    return root.querySelectorAll(
      'img[src*="pbs.twimg.com/media/"], a[href*="video.twimg.com"][href*=".mp4"], source[src*="video.twimg.com"][src*=".mp4"]'
    ).length;
  }

  /* -------------------- Sweep & filenames -------------------- */
    function sweepAllMedia(root) {
        const items = [];
        const seen = new Set();

        // メディアグリッドの各カード（= 各画像）を走査
        const cards = root.querySelectorAll('li[role="listitem"] a[href*="/status/"][href*="/photo/"]');
        cards.forEach(a => {
            const href = a.getAttribute('href') || '';
            const meta = parseTweetPhotoMetaFromHref(href); // screenName, tweetId, photoIndex

            // 画像URLは <img> の src または 背景画像 style から取得
            let imgUrl =
                a.querySelector('img[src*="pbs.twimg.com/media/"]')?.src ||
                extractBgUrl(a.querySelector('[style*="background-image"]')?.getAttribute('style'));

            if (!imgUrl) return; // 画像見つからないカードはスキップ

            imgUrl = normalizeImageUrl(imgUrl); // ?name=orig へ
            if (!imgUrl) return;

            // 重複排除（メディアID or 完整形URLで）
            if (seen.has(imgUrl)) return;
            seen.add(imgUrl);

            items.push({
                type: 'img',
                url: imgUrl,
                meta: {
                    screenName: meta.screenName,
                    tweetId: meta.tweetId,
                    // 同一ツイート内の順序は photoIndex で持てる（のちの②対応に使う）
                    photoIndex: meta.photoIndex
                }
            });
        });

        return items;
    }

  function createCollector() {
    const collected = new Map();
    return {
      addFromDom(root) {
        const snapshot = sweepAllMedia(root);
        let added = 0;
        for (const item of snapshot) {
          if (collected.has(item.url)) continue;
          collected.set(item.url, item);
          added++;
        }
        return { added, total: collected.size };
      },
      getItems() {
        return Array.from(collected.values());
      }
    };
  }
    // ▼ href="/<sn>/status/<id>/photo/<n>" からメタを抜く
    function parseTweetPhotoMetaFromHref(href) {
        // 例: /ysaito_human/status/1961381692951691766/photo/1
        const m = href.match(/^\/([^/]+)\/status\/(\d+)\/photo\/(\d+)/);
        if (!m) return { screenName: undefined, tweetId: undefined, photoIndex: undefined };
        return { screenName: m[1], tweetId: m[2], photoIndex: Number(m[3]) };
    }
    // ▼ background-image: url("...") からURLを取り出す
    function extractBgUrl(styleText) {
        if (!styleText) return null;
        const m = styleText.match(/background-image:\s*url\((['"]?)(.*?)\1\)/i);
        return m ? m[2] : null;
    }

  function normalizeImageUrl(u) {
    try {
      const url = new URL(u);
      if (!/pbs\.twimg\.com\/media\//.test(url.href)) return null;
      url.searchParams.set('name', 'orig');
      if (!url.searchParams.has('format') && !/\.(jpg|png|webp)$/i.test(url.pathname)) {
        url.searchParams.set('format', 'jpg');
      }
      return url.toString();
    } catch { return null; }
  }

  function pickMeta(el) {
    const article = el.closest('article');
    let tweetId, screenName;
    const a = article && article.querySelector('a[href*="/status/"]');
    if (a) {
      const m = a.getAttribute('href')?.match(/\/([^\/]+)\/status\/(\d+)/);
      if (m) { screenName = m[1]; tweetId = m[2]; }
    }
    return { tweetId, screenName };
  }

  function addFilenames(items) {
    // {screenName}_{tweetId}_{index}.{ext}
    const counter = new Map();
    return items.map(it => {
      const sn = it.meta?.screenName || 'unknown';
      const tid = it.meta?.tweetId || 'na';
      const key = `${sn}:${tid}`;
      const cur = (counter.get(key) || 0) + 1; counter.set(key, cur);
      const ext = guessExt(it);
      return { ...it, filename: `${sn}_${tid}_${String(cur).padStart(2,'0')}.${ext}` };
    });
  }
  function guessExt(it) {
    try {
      const u = new URL(it.url);
      if (it.type === 'mp4') return 'mp4';
      const fmt = u.searchParams.get('format'); if (fmt) return sanitizeExt(fmt);
      const m = u.pathname.match(/\.(jpg|jpeg|png|webp)$/i); if (m) return sanitizeExt(m[1]);
      return 'jpg';
    } catch { return it.type === 'mp4' ? 'mp4' : 'jpg'; }
  }
  const sanitizeExt = (e) => (e || '').toLowerCase() === 'jpeg' ? 'jpg' : (e || '').toLowerCase();
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
