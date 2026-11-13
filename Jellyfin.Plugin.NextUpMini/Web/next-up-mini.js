/* Next Up Mini for the Jellyfin web player (served by the Next Up Mini plugin).
   When an episode's end credits start, the video shrinks into a corner and a countdown
   starts the next episode. Enter = play now, Esc = keep watching the credits.
   Credits come from media segments (e.g. Intro Skipper), then chapters named like
   "Credits", then a fixed number of seconds before the end. */
(function () {
  'use strict';
  if (window.__nextUpMini) return;
  window.__nextUpMini = true;

  // Settings are filled in by the server from the plugin's Dashboard page.
  var CFG = Object.assign({
    enabled: true, countdown: 10, fallback: 30, chapters: true,
    width: 28, corner: 'right', hideBuiltIn: true
  }, /*NUM_CONFIG*/{});
  if (!CFG.enabled) return;

  var T = 10000000;   // Jellyfin ticks per second
  var CREDIT_CHAPTER = /\b(end\s*)?credits?\b|\boutro\b|\bend\s*titles?\b/i;
  var st = {};

  function log() { console.log.apply(console, ['[NextUpMini]'].concat([].slice.call(arguments))); }

  // Server root, including any base URL (the page lives at <root>/web/).
  function root() {
    var p = location.pathname, i = p.toLowerCase().lastIndexOf('/web/');
    return location.origin + (i >= 0 ? p.slice(0, i) : '');
  }

  function auth() {
    var a = window.ApiClient;
    try {
      if (a && a.accessToken && a.accessToken()) {
        return { token: a.accessToken(), user: a.getCurrentUserId(), dev: a.deviceId() };
      }
      var s = JSON.parse(localStorage.getItem('jellyfin_credentials')).Servers[0];
      return { token: s.AccessToken, user: s.UserId, dev: localStorage.getItem('_deviceId2') };
    } catch (e) { return null; }
  }

  function req(method, path) {
    var a = auth();
    if (!a) return Promise.reject(new Error('not signed in'));
    return fetch(root() + '/' + path, {
      method: method,
      headers: { Authorization: 'MediaBrowser Token="' + a.token + '"' }
    }).then(function (r) {
      if (!r.ok) throw new Error(method + ' ' + path + ' -> ' + r.status);
      return method === 'GET' ? r.json() : r;
    });
  }

  function init() {
    st = { id: null, sess: null, end: null, outro: null, next: null, offset: 0, busy: false,
           retry: Date.now() + 3000, shown: false, done: false, starting: false,
           overlay: null, video: null, timer: null, left: 0 };
  }

  // Latest credits start (in seconds) from media segments, ignoring anything in the first half.
  function fromSegments(items, half) {
    var best = null;
    (items || []).forEach(function (x) {
      var s0 = x.StartTicks / T;
      if (x.Type === 'Outro' && s0 > half && (best === null || s0 > best)) best = s0;
    });
    return best;
  }

  // Latest chapter in the second half whose name looks like credits.
  function fromChapters(chapters, half) {
    var best = null;
    (chapters || []).forEach(function (c) {
      var s0 = c.StartPositionTicks / T;
      if (c.Name && CREDIT_CHAPTER.test(c.Name) && s0 > half && (best === null || s0 > best)) best = s0;
    });
    return best;
  }

  function load(v) {
    var a = auth();
    if (!a) return;
    st.busy = true;
    req('GET', 'Sessions?deviceId=' + encodeURIComponent(a.dev)).then(function (list) {
      var me = list && list[0], it = me && me.NowPlayingItem;
      if (!it || it.Type !== 'Episode') { st.retry = Date.now() + 5000; return; }
      if (isFinite(v.duration) && it.RunTimeTicks && Math.abs(it.RunTimeTicks / T - v.duration) > 15) {
        st.retry = Date.now() + 2000; return;   // session still shows the previous episode
      }
      var info = { sess: me.Id, end: it.RunTimeTicks ? it.RunTimeTicks / T : null, outro: null, next: null };
      var pp = me.PlayState && me.PlayState.PositionTicks ? me.PlayState.PositionTicks / T : 0;
      info.offset = pp - v.currentTime > 30 ? pp - v.currentTime : 0;
      return Promise.all([
        req('GET', 'MediaSegments/' + it.Id + '?includeSegmentTypes=Outro').catch(function () { return null; }),
        req('GET', 'Shows/' + it.SeriesId + '/Episodes?userId=' + a.user + '&startItemId=' + it.Id + '&limit=2'),
        CFG.chapters ? req('GET', 'Items/' + it.Id + '?userId=' + a.user + '&fields=Chapters').catch(function () { return null; }) : null
      ]).then(function (r) {
        var half = (info.end || 0) / 2;
        info.outro = fromSegments(r[0] && r[0].Items, half);
        if (info.outro === null && r[2]) info.outro = fromChapters(r[2].Chapters, half);
        var eps = (r[1] && r[1].Items) || [];
        info.next = eps.length > 1 && eps[0].Id === it.Id ? eps[1] : null;
        info.id = it.Id;
        Object.assign(st, info);
        log('ready:', it.Name, '| credits at', info.outro, '| next:', info.next ? info.next.Name : 'none');
      });
    }).catch(function (e) {
      log('lookup failed', e);
      st.retry = Date.now() + 10000;
    }).then(function () { st.busy = false; });
  }

  function show(v) {
    st.shown = true; st.video = v; st.left = CFG.countdown;
    var n = st.next;
    var o = document.createElement('div');
    o.className = 'nm-overlay';
    o.innerHTML =
      '<div class="nm-card"><div class="nm-kicker">Up next</div><div class="nm-title"></div>' +
      '<div class="nm-sub"></div><img class="nm-img" alt=""></div>' +
      '<div class="nm-side"><div class="nm-ring"><svg width="120" height="120">' +
      '<circle cx="60" cy="60" r="52" stroke="rgba(255,255,255,.2)" stroke-width="6" fill="none"/>' +
      '<circle class="nm-arc" cx="60" cy="60" r="52" stroke="#00a4dc" stroke-width="6" fill="none" stroke-dasharray="326.7" stroke-dashoffset="0"/>' +
      '</svg><div class="nm-num"></div></div>' +
      '<button class="nm-btn nm-play">Play now</button><button class="nm-btn nm-stay">Watch credits</button></div>';
    o.querySelector('.nm-title').textContent = n.Name;
    o.querySelector('.nm-sub').textContent = 'S' + n.ParentIndexNumber + ':E' + n.IndexNumber + ' · ' + (n.SeriesName || '');
    var img = o.querySelector('.nm-img');
    img.onerror = function () { img.remove(); };
    img.src = root() + '/Items/' + n.Id + '/Images/Primary?fillWidth=640&quality=90';
    // Jellyfin's player controls (OSD) sit above the video and pause/play on any click, so the
    // buttons live in a page-level layer above the OSD. The dark backdrop stays next to the video,
    // underneath the mini player, so the shrunken credits remain visible.
    ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend'].forEach(function (t) {
      o.addEventListener(t, function (e) { e.stopPropagation(); });
    });
    o.querySelector('.nm-play').addEventListener('click', function (e) { e.preventDefault(); playNext(); });
    o.querySelector('.nm-stay').addEventListener('click', function (e) { e.preventDefault(); keepWatching(); });
    var bg = document.createElement('div');
    bg.className = 'nm-bg';
    v.parentNode.appendChild(bg);
    document.body.appendChild(o);
    st.overlay = o; st.bg = bg;
    requestAnimationFrame(function () { o.classList.add('nm-in'); bg.classList.add('nm-in'); v.classList.add('nm-mini'); });
    tick();
    st.timer = setInterval(tick, 1000);
  }

  function tick() {
    if (!st.overlay) return;
    if (st.video && st.video.paused) return;   // countdown waits while paused
    st.overlay.querySelector('.nm-num').textContent = st.left;
    st.overlay.querySelector('.nm-arc').style.strokeDashoffset = (326.7 * (1 - st.left / CFG.countdown)).toFixed(1);
    if (st.left <= 0) { playNext(); return; }
    st.left -= 1;
  }

  function hide() {
    clearInterval(st.timer);
    if (st.overlay) st.overlay.remove();
    if (st.bg) st.bg.remove();
    document.querySelectorAll('video.nm-mini').forEach(function (x) { x.classList.remove('nm-mini'); });
    st.overlay = null; st.bg = null; st.shown = false;
  }

  function keepWatching() { st.done = true; hide(); }

  function playNext() {
    if (!st.next || st.starting) return;
    st.starting = true; st.done = true; clearInterval(st.timer);
    // 1) Jellyfin's own Up Next "Start Now" button, 2) the player's next-episode button, 3) the API
    var b = document.querySelector('.upNextDialog .btnStartNow') || document.querySelector('.btnNextTrack');
    if (b) { log('starting next episode via', b.className.split(' ')[0]); b.click(); }
    else {
      req('POST', 'Sessions/' + st.sess + '/Playing?playCommand=PlayNow&itemIds=' + st.next.Id).catch(function (e) {
        log('could not start the next episode', e); hide();
      });
    }
    setTimeout(hide, 15000);   // safety net if the next episode never loads
  }

  var w = Math.max(15, Math.min(45, Number(CFG.width) || 28));
  var side = CFG.corner === 'left' ? 'left:3vw!important;right:auto!important;' : 'right:3vw!important;left:auto!important;';
  var css = document.createElement('style');
  css.textContent = [
    '.nm-bg{position:absolute;top:0;right:0;bottom:0;left:0;z-index:5;pointer-events:none;background:radial-gradient(ellipse at 30% 45%,rgba(28,28,28,.92),rgba(0,0,0,.98));opacity:0;transition:opacity .45s ease}',
    '.nm-bg.nm-in{opacity:1}',
    '.nm-overlay{position:fixed;top:0;right:0;bottom:0;left:0;z-index:2147483000;pointer-events:none;display:flex;align-items:center;gap:5vw;padding:0 7vw 12vh;box-sizing:border-box;color:#fff;opacity:0;transition:opacity .45s ease}',
    '.nm-card,.nm-side{pointer-events:auto}',
    CFG.corner === 'left' ? '.nm-overlay{flex-direction:row-reverse;justify-content:flex-end}' : '',
    '.nm-overlay.nm-in{opacity:1}',
    '.nm-card{width:38vw;max-width:640px}',
    '.nm-kicker{font-size:.95rem;letter-spacing:.18em;text-transform:uppercase;color:#00a4dc;margin-bottom:.5em}',
    '.nm-title{font-size:2.3rem;font-weight:600;line-height:1.15}',
    '.nm-sub{font-size:1.1rem;opacity:.7;margin-top:.35em}',
    '.nm-img{display:block;width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:8px;margin-top:1.1em;box-shadow:0 8px 28px rgba(0,0,0,.55)}',
    '.nm-side{display:flex;flex-direction:column;align-items:center;gap:.9em}',
    '.nm-ring{position:relative;width:120px;height:120px}',
    '.nm-ring svg{transform:rotate(-90deg)}',
    '.nm-arc{transition:stroke-dashoffset 1s linear}',
    '.nm-num{position:absolute;top:0;right:0;bottom:0;left:0;display:flex;align-items:center;justify-content:center;font-size:2.6rem;font-weight:600}',
    '.nm-btn{font:inherit;font-size:1rem;width:11em;padding:.7em 1em;border:0;border-radius:6px;cursor:pointer}',
    '.nm-play{background:#fff;color:#000;font-weight:600}',
    '.nm-stay{background:rgba(255,255,255,.14);color:#fff}',
    '.nm-btn:hover{filter:brightness(.88)}',
    CFG.hideBuiltIn ? 'body:has(.nm-overlay) .upNextDialog{visibility:hidden!important}' : '',
    'video.nm-mini{position:absolute!important;top:auto!important;' + side + 'bottom:5vh!important;width:' + w + 'vw!important;height:' + (w * 9 / 16).toFixed(2) + 'vw!important;z-index:6!important;background:#000;border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.75);transition:all .45s ease}'
  ].join('\n');
  document.head.appendChild(css);

  init();
  document.addEventListener('loadstart', function (e) {
    if (e.target instanceof HTMLVideoElement) { hide(); init(); }
  }, true);
  document.addEventListener('timeupdate', function (e) {
    var v = e.target;
    if (!(v instanceof HTMLVideoElement)) return;
    if (!st.id) { if (!st.busy && Date.now() > st.retry) load(v); return; }
    if (!st.next) return;
    var at = st.outro !== null ? st.outro : (CFG.fallback && st.end ? st.end - CFG.fallback : null);
    if (at === null) return;
    var pos = v.currentTime + st.offset;
    if (!st.shown && !st.done && pos >= at && (!st.end || pos < st.end - 2)) show(v);
    else if (st.shown && !st.starting && pos < at - 3) hide();   // seeked back before the credits
  }, true);
  document.addEventListener('keydown', function (e) {
    if (!st.shown) return;
    if (e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); playNext(); }
    else if (e.key === 'Escape' || e.key === 'Backspace') { e.preventDefault(); e.stopImmediatePropagation(); keepWatching(); }
  }, true);
  setInterval(function () { if (st.shown && st.video && !document.contains(st.video)) hide(); }, 2000);
  log('loaded', CFG);
})();
