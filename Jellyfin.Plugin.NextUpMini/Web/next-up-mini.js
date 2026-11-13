/* Next Up Mini for the Jellyfin web player (served by the Next Up Mini plugin).
   When an episode's end credits start, the video shrinks into a corner and a countdown
   starts the next episode. Enter = main action, Esc = keep watching the credits.
   Credits come from media segments (e.g. Intro Skipper), then chapters named like
   "Credits", then a fixed number of seconds before the end.
   - Optional (off by default): if the credits end well before the episode does, treat it as a
     scene after the credits: no countdown, and a "Skip to scene" button instead.
   - On the last episode of a series, it says so and offers to go back to the series.
   - If the user turned off "Play next episode automatically", there is no countdown. */
(function () {
  'use strict';
  if (window.__nextUpMini) return;
  window.__nextUpMini = true;

  // Settings are filled in by the server from the plugin's Dashboard page.
  var CFG = Object.assign({
    enabled: true, countdown: 10, fallback: 30, chapters: true, postCredits: false,
    width: 28, corner: 'right', hideBuiltIn: true
  }, /*NUM_CONFIG*/{});
  if (!CFG.enabled) return;

  var T = 10000000;          // Jellyfin ticks per second
  var STINGER_MIN = 25;      // seconds of video after the credits that count as a post-credits scene
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

  // What this tab itself is playing, read from the web player's own playback reports. Two tabs in
  // the same browser share one Jellyfin session, so the session alone can describe the other tab.
  var own = { item: null, pos: null, vt: 0, since: 0 };
  (function () {
    var f = window.fetch;
    if (!f) return;
    window.fetch = function (input, opts) {
      try {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        if (/\/Sessions\/Playing(\/Progress)?(\?|$)/i.test(url) && opts && typeof opts.body === 'string') {
          var b = JSON.parse(opts.body), v = st.el || document.querySelector('video');
          if (b && b.ItemId) {
            own.item = b.ItemId;
            own.pos = typeof b.PositionTicks === 'number' ? b.PositionTicks / T : null;
            own.vt = v ? v.currentTime : 0;
          }
        }
      } catch (e) { /* never get in the way of the player's own request */ }
      return f.apply(this, arguments);
    };
  })();

  function init() {
    st = { id: null, sess: null, end: null, outro: null, outroEnd: null, next: null, offset: 0,
           busy: false, retry: Date.now() + 3000, shown: false, done: false, starting: false,
           overlay: null, bg: null, video: null, el: null, src: null, timer: null, left: 0,
           autoplay: true, mode: 'next', seriesId: null, seriesName: '', newSeason: false };
  }

  // Latest credits segment (seconds) from media segments, ignoring anything in the first half.
  function fromSegments(items, half) {
    var best = null;
    (items || []).forEach(function (x) {
      var s0 = x.StartTicks / T;
      if (x.Type === 'Outro' && s0 > half && (best === null || s0 > best.start)) {
        best = { start: s0, end: x.EndTicks ? x.EndTicks / T : null };
      }
    });
    return best;
  }

  // Latest chapter in the second half whose name looks like credits; it ends where the next chapter starts.
  function fromChapters(chapters, half) {
    var list = (chapters || []).map(function (c) { return { name: c.Name, start: c.StartPositionTicks / T }; })
      .sort(function (a, b) { return a.start - b.start; });
    var best = null;
    list.forEach(function (c, i) {
      if (c.name && CREDIT_CHAPTER.test(c.name) && c.start > half && (best === null || c.start > best.start)) {
        best = { start: c.start, end: i + 1 < list.length ? list[i + 1].start : null };
      }
    });
    return best;
  }

  function load(v) {
    var a = auth();
    if (!a) return;
    st.busy = true;
    req('GET', 'Sessions?deviceId=' + encodeURIComponent(a.dev)).then(function (list) {
      var me = list && list[0], np = me && me.NowPlayingItem;
      // Give the player a few seconds to send its first report for the new video.
      if (!own.item && Date.now() - own.since < 12000) return null;
      if (np && (!own.item || np.Id === own.item)) {
        var pp = me.PlayState && me.PlayState.PositionTicks ? me.PlayState.PositionTicks / T : 0;
        return { it: np, sess: me.Id, pos: pp, vt: v.currentTime };
      }
      // The session is showing another tab's video (or nothing yet): look up this tab's item directly,
      // and don't send session commands, since they could reach the other tab.
      if (!own.item) return null;
      return req('GET', 'Items/' + own.item + '?userId=' + a.user).then(function (item) {
        return { it: item, sess: null, pos: own.pos || 0, vt: own.vt };
      });
    }).then(function (x) {
      var it = x && x.it;
      if (!it || it.Type !== 'Episode') { st.retry = Date.now() + 5000; return; }
      if (isFinite(v.duration) && it.RunTimeTicks && Math.abs(it.RunTimeTicks / T - v.duration) > 15) {
        st.retry = Date.now() + 2000; return;   // session still shows the previous episode
      }
      var info = { sess: x.sess, end: it.RunTimeTicks ? it.RunTimeTicks / T : null,
                   seriesId: it.SeriesId, seriesName: it.SeriesName || '' };
      info.offset = x.pos - x.vt > 30 ? x.pos - x.vt : 0;
      return Promise.all([
        req('GET', 'MediaSegments/' + it.Id + '?includeSegmentTypes=Outro').catch(function () { return null; }),
        req('GET', 'Shows/' + it.SeriesId + '/Episodes?userId=' + a.user + '&startItemId=' + it.Id + '&limit=2'),
        CFG.chapters ? req('GET', 'Items/' + it.Id + '?userId=' + a.user + '&fields=Chapters').catch(function () { return null; }) : null,
        req('GET', 'Users/' + a.user).catch(function () { return null; })
      ]).then(function (r) {
        var half = (info.end || 0) / 2;
        var credits = fromSegments(r[0] && r[0].Items, half);
        if (credits === null && r[2]) credits = fromChapters(r[2].Chapters, half);
        info.outro = credits ? credits.start : null;
        info.outroEnd = credits ? credits.end : null;
        var eps = (r[1] && r[1].Items) || [];
        info.next = eps.length > 1 && eps[0].Id === it.Id ? eps[1] : null;
        info.newSeason = !!(info.next && info.next.ParentIndexNumber !== it.ParentIndexNumber);
        var conf = r[3] && r[3].Configuration;
        info.autoplay = !(conf && conf.EnableNextEpisodeAutoPlay === false);
        var stinger = CFG.postCredits && info.outroEnd !== null && info.end && info.end - info.outroEnd > STINGER_MIN;
        info.mode = stinger ? 'stinger' : (info.next ? 'next' : 'finale');
        info.id = it.Id;
        info.el = v;
        info.src = v.currentSrc;
        Object.assign(st, info);
        log('ready:', it.Name, '| credits', info.outro, '-', info.outroEnd, '| mode:', info.mode,
            '| next:', info.next ? info.next.Name : 'none', '| autoplay:', info.autoplay);
      });
    }).catch(function (e) {
      log('lookup failed', e);
      st.retry = Date.now() + 10000;
    }).then(function () { st.busy = false; });
  }

  function button(cls, label, fn) {
    return '<button class="nm-btn ' + cls + '" data-act="' + fn + '">' + label + '</button>';
  }

  function show(v) {
    st.shown = true; st.video = v; st.left = CFG.countdown;
    var n = st.next;
    var countdown = st.mode === 'next' && st.autoplay;
    var o = document.createElement('div');
    o.className = 'nm-overlay';

    var buttons;
    if (st.mode === 'stinger') {
      buttons = button('nm-primary', 'Skip to scene', 'scene') +
                (n ? button('nm-secondary', 'Play next episode', 'next') : '') +
                button('nm-secondary', 'Watch credits', 'stay');
    } else if (st.mode === 'finale') {
      buttons = button('nm-primary', 'Back to series', 'series') + button('nm-secondary', 'Watch credits', 'stay');
    } else {
      buttons = button('nm-primary', 'Play now', 'next') + button('nm-secondary', 'Watch credits', 'stay');
    }

    o.innerHTML =
      '<div class="nm-card"><div class="nm-kicker"></div><div class="nm-title"></div>' +
      '<div class="nm-sub"></div><img class="nm-img" alt=""></div>' +
      '<div class="nm-side">' +
      (countdown ? '<div class="nm-ring"><svg width="120" height="120">' +
        '<circle cx="60" cy="60" r="52" stroke="rgba(255,255,255,.2)" stroke-width="6" fill="none"/>' +
        '<circle class="nm-arc" cx="60" cy="60" r="52" stroke="#00a4dc" stroke-width="6" fill="none" stroke-dasharray="326.7" stroke-dashoffset="0"/>' +
        '</svg><div class="nm-num"></div></div>' : '') +
      (st.mode === 'stinger' ? '<div class="nm-note">Scene after the credits</div>' : '') +
      buttons + '</div>';

    var kicker = o.querySelector('.nm-kicker'), title = o.querySelector('.nm-title'), sub = o.querySelector('.nm-sub');
    var imgId;
    if (n && st.mode !== 'finale') {
      kicker.textContent = st.newSeason ? 'Up next · Season ' + n.ParentIndexNumber : 'Up next';
      title.textContent = n.Name;
      sub.textContent = 'S' + n.ParentIndexNumber + ':E' + n.IndexNumber + ' · ' + (n.SeriesName || '');
      imgId = n.Id;
    } else {
      kicker.textContent = st.mode === 'stinger' ? 'Last episode' : 'Series complete';
      title.textContent = "You've finished " + (st.seriesName || 'this series');
      sub.textContent = 'That was the last episode in your library.';
      imgId = st.seriesId;
    }
    var img = o.querySelector('.nm-img');
    img.onerror = function () { img.remove(); };
    if (imgId) img.src = root() + '/Items/' + imgId + '/Images/Primary?fillWidth=640&quality=90'; else img.remove();

    // Jellyfin's player controls (OSD) sit above the video and pause/play on any click, so the
    // buttons live in a page-level layer above the OSD. The dark backdrop stays next to the video,
    // underneath the mini player, so the shrunken credits remain visible.
    ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend'].forEach(function (t) {
      o.addEventListener(t, function (e) { e.stopPropagation(); });
    });
    o.querySelectorAll('[data-act]').forEach(function (b) {
      b.addEventListener('click', function (e) { e.preventDefault(); act(b.getAttribute('data-act')); });
    });

    var bg = document.createElement('div');
    bg.className = 'nm-bg';
    v.parentNode.appendChild(bg);
    document.body.appendChild(o);
    st.overlay = o; st.bg = bg;
    requestAnimationFrame(function () { o.classList.add('nm-in'); bg.classList.add('nm-in'); v.classList.add('nm-mini'); });
    if (countdown) { tick(); st.timer = setInterval(tick, 1000); }
  }

  function act(name) {
    if (name === 'next') playNext();
    else if (name === 'scene') skipToScene();
    else if (name === 'series') backToSeries();
    else keepWatching();
  }

  // Enter does whatever the main (white) button does.
  function primaryAction() {
    act(st.mode === 'stinger' ? 'scene' : st.mode === 'finale' ? 'series' : 'next');
  }

  function tick() {
    if (!st.overlay) return;
    if (st.video && st.video.paused) return;   // countdown waits while paused
    var num = st.overlay.querySelector('.nm-num'), arc = st.overlay.querySelector('.nm-arc');
    if (!num || !arc) return;
    num.textContent = st.left;
    arc.style.strokeDashoffset = (326.7 * (1 - st.left / CFG.countdown)).toFixed(1);
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

  // Jump past the credits to the post-credits scene. The sessions API seek goes through Jellyfin's
  // own player, which also handles transcodes; setting the video time directly is the fallback.
  function skipToScene() {
    var target = st.outroEnd, v = st.video;
    st.done = true; hide();
    if (target === null) return;
    var direct = function () { if (v) v.currentTime = Math.max(0, target - st.offset + 0.5); };
    if (!st.sess) { direct(); return; }
    req('POST', 'Sessions/' + st.sess + '/Playing/Seek?seekPositionTicks=' + Math.round((target + 0.5) * T))
      .catch(function (e) { log('API seek failed, seeking the video directly', e); direct(); });
  }

  // Open the series page. Leaving the player stops playback in this tab only.
  function backToSeries() {
    var id = st.seriesId;
    st.done = true; hide();
    if (id) location.hash = '#/details?id=' + id;
    else history.back();
  }

  function playNext() {
    if (!st.next || st.starting) return;
    st.starting = true; st.done = true; clearInterval(st.timer);
    // 1) Jellyfin's own Up Next "Start Now" button, 2) the player's next-episode button, 3) the API
    var b = document.querySelector('.upNextDialog .btnStartNow') || document.querySelector('.btnNextTrack');
    if (b) { log('starting next episode via', b.className.split(' ')[0]); b.click(); }
    else if (!st.sess) { log('no next-episode button found'); hide(); }
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
    '.nm-note{font-size:.95rem;letter-spacing:.12em;text-transform:uppercase;color:#f5c542;margin-bottom:.2em}',
    '.nm-btn{font:inherit;font-size:1rem;width:12em;padding:.7em 1em;border:0;border-radius:6px;cursor:pointer}',
    '.nm-primary{background:#fff;color:#000;font-weight:600}',
    '.nm-secondary{background:rgba(255,255,255,.14);color:#fff}',
    '.nm-btn:hover{filter:brightness(.88)}',
    CFG.hideBuiltIn ? 'body:has(.nm-overlay) .upNextDialog{visibility:hidden!important}' : '',
    'video.nm-mini{position:absolute!important;top:auto!important;' + side + 'bottom:5vh!important;width:' + w + 'vw!important;height:' + (w * 9 / 16).toFixed(2) + 'vw!important;z-index:6!important;background:#000;border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.75);transition:all .45s ease}'
  ].join('\n');
  document.head.appendChild(css);

  init();
  document.addEventListener('loadstart', function (e) {
    if (e.target instanceof HTMLVideoElement) {
      hide(); init();
      own.item = null; own.since = Date.now();
    }
  }, true);
  document.addEventListener('timeupdate', function (e) {
    var v = e.target;
    if (!(v instanceof HTMLVideoElement)) return;
    // A different video element or source means new playback, even if 'loadstart' was missed
    // (for example when the same episode is started again).
    if (st.id && (v !== st.el || (st.src && v.currentSrc && v.currentSrc !== st.src))) { hide(); init(); }
    if (!st.id) { if (!st.busy && Date.now() > st.retry) load(v); return; }
    var at = st.outro !== null ? st.outro : (CFG.fallback && st.end ? st.end - CFG.fallback : null);
    if (at === null) return;
    var pos = v.currentTime + st.offset;
    // Post-credits scene reached: get out of the way so it plays full size.
    if (st.mode === 'stinger' && st.outroEnd !== null && pos >= st.outroEnd) {
      if (st.shown) keepWatching();
      return;
    }
    if (!st.shown && !st.done && pos >= at && (!st.end || pos < st.end - 2)) show(v);
    else if (st.shown && !st.starting && pos < at - 3) hide();   // seeked back before the credits
  }, true);
  document.addEventListener('keydown', function (e) {
    if (!st.shown) return;
    if (e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); primaryAction(); }
    else if (e.key === 'Escape' || e.key === 'Backspace') { e.preventDefault(); e.stopImmediatePropagation(); keepWatching(); }
  }, true);
  setInterval(function () { if (st.shown && st.video && !document.contains(st.video)) hide(); }, 2000);
  log('loaded', CFG);
})();
