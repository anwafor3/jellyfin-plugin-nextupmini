/* Next Up Mini for the Jellyfin web player (served by the Next Up Mini plugin).
   When an episode's end credits start, the video shrinks into a corner and a countdown
   starts the next episode. Enter = main action, Esc = keep watching the credits.
   Credits come from media segments (e.g. Intro Skipper), then chapters named like
   "Credits", then a fixed number of seconds before the end.
   - Optional (off by default): if the credits end well before the episode does, treat it as a
     scene after the credits: no countdown, and a "Skip to scene" button instead.
   - On the last episode of a series, it says so and offers to go back to the series.
   - If the user turned off "Play next episode automatically", there is no countdown.
   - Sleep timer (moon button in the player controls): pause after a set time or at the end of
     the episode (optional, on by default).
   - When paused, a panel shows the episode or movie and its cast; picking an actor lists what
     else they're in from your library (optional, on by default). */
(function () {
  'use strict';
  if (window.__nextUpMini) return;
  window.__nextUpMini = true;

  // Settings are filled in by the server from the plugin's Dashboard page.
  var CFG = Object.assign({
    enabled: true, countdown: 10, fallback: 30, chapters: true, postCredits: false,
    width: 28, corner: 'right', hideBuiltIn: true, pauseInfo: true, sleep: true
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
    hidePauseInfo();
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
      kicker.textContent = st.newSeason ? 'Up next \u00b7 Season ' + n.ParentIndexNumber : 'Up next';
      title.textContent = n.Name;
      sub.textContent = 'S' + n.ParentIndexNumber + ':E' + n.IndexNumber + ' \u00b7 ' + (n.SeriesName || '');
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

  // ---- Cast & info when paused (a simple take on Prime Video's X-Ray) ----
  // Shows the episode or movie, a short summary and its cast. Picking an actor lists what else
  // they're in from your library. Uses the cast Jellyfin already has (for example from TMDb);
  // it doesn't know who is on screen at that moment.
  var px = { el: null, timer: null, cache: {} };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; });
  }

  function img(id, tag, height) {
    return root() + '/Items/' + id + '/Images/Primary?fillHeight=' + height + '&quality=85' +
           (tag ? '&tag=' + encodeURIComponent(tag) : '');
  }

  function infoFor(id) {
    if (px.cache[id]) return Promise.resolve(px.cache[id]);
    var a = auth();
    if (!a) return Promise.reject(new Error('not signed in'));
    return req('GET', 'Items/' + id + '?userId=' + a.user + '&fields=People,Overview').then(function (it) {
      px.cache[id] = it;
      return it;
    });
  }

  function hidePauseInfo() {
    clearTimeout(px.timer);
    if (px.el) {
      var el = px.el;
      px.el = null;
      el.classList.remove('nm-in');
      setTimeout(function () { el.remove(); }, 300);
    }
  }

  function showPauseInfo(v) {
    var id = own.item || st.id;
    if (px.el || st.shown || !id || !v.paused || v.ended || !document.contains(v)) return;
    infoFor(id).then(function (it) {
      if (px.el || st.shown || !v.paused || (own.item || st.id) !== id) return;
      var cast = (it.People || []).filter(function (p) { return p.Type === 'Actor' || p.Type === 'GuestStar'; });
      if (!cast.length && !it.Overview) return;
      var p = document.createElement('div');
      p.className = 'nm-px';
      // Keep clicks inside the panel away from the player, which would otherwise resume playback.
      ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend'].forEach(function (t) {
        p.addEventListener(t, function (e) { e.stopPropagation(); });
      });
      document.body.appendChild(p);
      px.el = p;
      renderCast(p, it, cast);
      requestAnimationFrame(function () { p.classList.add('nm-in'); });
    }).catch(function (e) { log('pause info failed', e); });
  }

  function renderCast(p, it, cast) {
    var head = it.Type === 'Episode'
      ? '<div class="nm-px-kicker">' + esc(it.SeriesName) + '</div><div class="nm-px-title">' + esc(it.Name) + '</div>' +
        '<div class="nm-px-sub">Season ' + esc(it.ParentIndexNumber) + ' \u00b7 Episode ' + esc(it.IndexNumber) + '</div>'
      : '<div class="nm-px-title">' + esc(it.Name) + '</div>' +
        (it.ProductionYear ? '<div class="nm-px-sub">' + esc(it.ProductionYear) + '</div>' : '');
    var people = cast.slice(0, 16).map(function (c, i) {
      var face = c.PrimaryImageTag
        ? '<img class="nm-px-face" alt="" data-initial="' + esc((c.Name || '?').charAt(0)) + '" src="' + esc(img(c.Id, c.PrimaryImageTag, 120)) + '">'
        : '<span class="nm-px-face">' + esc((c.Name || '?').charAt(0)) + '</span>';
      var role = (c.Role || '') + (c.Type === 'GuestStar' ? (c.Role ? ' \u00b7 ' : '') + 'guest star' : '');
      return '<button class="nm-px-p" data-i="' + i + '">' + face + '<span><span class="nm-px-name">' + esc(c.Name) +
             '</span>' + (role ? '<span class="nm-px-role">' + esc(role) + '</span>' : '') + '</span></button>';
    }).join('');
    p.innerHTML = head +
      (it.Overview ? '<p class="nm-px-ov">' + esc(it.Overview) + '</p>' : '') +
      (people ? '<div class="nm-px-h">Cast</div><div class="nm-px-grid">' + people + '</div>' : '');
    p.querySelectorAll('img.nm-px-face').forEach(function (f) {
      f.onerror = function () {
        f.replaceWith(Object.assign(document.createElement('span'), { className: 'nm-px-face', textContent: f.getAttribute('data-initial') }));
      };
    });
    p.querySelectorAll('.nm-px-p').forEach(function (b) {
      b.addEventListener('click', function () { renderPerson(p, it, cast, cast[Number(b.getAttribute('data-i'))]); });
    });
  }

  // What else this actor is in from your library (titles only, so the episode keeps playing).
  function renderPerson(p, it, cast, person) {
    var a = auth();
    var skip = it.Type === 'Episode' ? it.SeriesId : it.Id;
    p.innerHTML = '<button class="nm-px-back">\u2039 Back to cast</button>' +
      '<div class="nm-px-title">' + esc(person.Name) + '</div>' +
      (person.Role ? '<div class="nm-px-sub">as ' + esc(person.Role) + '</div>' : '') +
      '<div class="nm-px-h">Also in your library</div><div class="nm-px-list">Loading\u2026</div>';
    p.querySelector('.nm-px-back').addEventListener('click', function () { renderCast(p, it, cast); });
    p.scrollTop = 0;
    req('GET', 'Items?userId=' + a.user + '&personIds=' + person.Id + '&recursive=true' +
        '&includeItemTypes=Movie,Series&sortBy=ProductionYear,SortName&sortOrder=Descending&limit=24')
      .then(function (r) {
        var list = p.querySelector('.nm-px-list');
        if (!list) return;
        var items = ((r && r.Items) || []).filter(function (x) { return x.Id !== skip; });
        list.innerHTML = items.length ? items.map(function (x) {
          var poster = x.ImageTags && x.ImageTags.Primary
            ? '<img alt="" src="' + esc(img(x.Id, x.ImageTags.Primary, 120)) + '">' : '<span></span>';
          return '<div class="nm-px-item">' + poster + '<span><span class="nm-px-name">' + esc(x.Name) + '</span>' +
                 '<span class="nm-px-role">' + (x.Type === 'Series' ? 'Series' : 'Movie') +
                 (x.ProductionYear ? ' \u00b7 ' + esc(x.ProductionYear) : '') + '</span></span></div>';
        }).join('') : '<div class="nm-px-role">Nothing else in your library.</div>';
        list.querySelectorAll('img').forEach(function (i) {
          i.onerror = function () { i.replaceWith(document.createElement('span')); };
        });
      })
      .catch(function () {
        var list = p.querySelector('.nm-px-list');
        if (list) list.textContent = 'Could not load.';
      });
  }


  // ---- Sleep timer ----
  // A moon button in the player controls. Pauses playback after a set time, or when the current
  // episode's credits start. The timer carries over when the next episode starts on its own and
  // is cleared when you leave the player.
  var sleep = { mode: null, until: 0, warned: false, timer: null, menu: null, toast: null };
  var MOON = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';

  function onPlayer() { return location.hash.indexOf('#/video') === 0; }

  function fmtLeft(ms) {
    var m = Math.ceil(ms / 60000);
    return m >= 60 ? Math.floor(m / 60) + 'h' + (m % 60 ? String(m % 60).padStart(2, '0') : '') : m + 'm';
  }

  function sleepLabel() {
    if (sleep.mode === 'episode') return 'Ep';
    if (sleep.mode === 'time') return fmtLeft(sleep.until - Date.now());
    return '';
  }

  function updateSleepButtons() {
    document.querySelectorAll('.nm-sleep-btn').forEach(function (b) {
      var l = b.querySelector('.nm-sleep-left');
      if (l) l.textContent = sleepLabel();
      b.classList.toggle('nm-sleep-on', !!sleep.mode);
      b.title = sleep.mode ? 'Sleep timer: ' + (sleep.mode === 'episode' ? 'end of episode' : sleepLabel() + ' left') : 'Sleep timer';
    });
  }

  function toast(html, buttons, keep) {
    if (sleep.toast) sleep.toast.remove();
    var t = document.createElement('div');
    t.className = 'nm-toast';
    t.innerHTML = '<span>' + html + '</span>' + (buttons || []).map(function (b, i) {
      return '<button data-i="' + i + '">' + esc(b[0]) + '</button>';
    }).join('');
    ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'dblclick'].forEach(function (ev) {
      t.addEventListener(ev, function (e) { e.stopPropagation(); });
    });
    t.querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () { buttons[Number(b.getAttribute('data-i'))][1](); t.remove(); });
    });
    document.body.appendChild(t);
    sleep.toast = t;
    requestAnimationFrame(function () { t.classList.add('nm-in'); });
    if (!keep) setTimeout(function () { if (sleep.toast === t) { t.remove(); sleep.toast = null; } }, 6000);
  }

  function setSleep(mode, minutes) {
    clearInterval(sleep.timer);
    sleep.mode = mode; sleep.warned = false;
    sleep.until = mode === 'time' ? Date.now() + minutes * 60000 : 0;
    if (mode === 'time') sleep.timer = setInterval(sleepTick, 1000);
    if (sleep.toast) { sleep.toast.remove(); sleep.toast = null; }
    updateSleepButtons();
    if (mode === 'time') toast('Sleep timer set: pausing in ' + fmtLeft(minutes * 60000) + '.');
    else if (mode === 'episode') toast('Sleep timer set: pausing at the end of this episode.');
    else toast('Sleep timer off.');
  }

  function sleepNow(v, msg) {
    clearInterval(sleep.timer);
    sleep.mode = null;
    updateSleepButtons();
    v = v || document.querySelector('video');
    if (v && !v.paused) v.pause();
    toast(msg || 'Sleep timer: paused.', [['OK', function () {}]], true);
  }

  function sleepTick() {
    if (sleep.mode !== 'time') return;
    var left = sleep.until - Date.now();
    updateSleepButtons();
    if (left <= 0) { sleepNow(null, 'Sleep timer: paused.'); return; }
    if (left <= 60000 && !sleep.warned) {
      sleep.warned = true;
      toast('Pausing in 1 minute.', [
        ['+15 min', function () { sleep.until += 15 * 60000; sleep.warned = false; updateSleepButtons(); }],
        ['Cancel timer', function () { setSleep(null); }]
      ], true);
    }
  }

  function closeSleepMenu() { if (sleep.menu) { sleep.menu.remove(); sleep.menu = null; } }

  function openSleepMenu(btn) {
    if (sleep.menu) { closeSleepMenu(); return; }
    var m = document.createElement('div');
    m.className = 'nm-sleep-menu';
    var opts = [['End of this episode', 'episode', 0], ['15 minutes', 'time', 15], ['30 minutes', 'time', 30],
                ['45 minutes', 'time', 45], ['1 hour', 'time', 60], ['1.5 hours', 'time', 90], ['2 hours', 'time', 120]];
    m.innerHTML = '<div class="nm-sleep-h">Sleep timer' + (sleep.mode ? ' \u00b7 ' + (sleep.mode === 'episode' ? 'end of episode' : sleepLabel() + ' left') : '') + '</div>' +
      opts.map(function (o, i) { return '<button data-i="' + i + '">' + o[0] + '</button>'; }).join('') +
      (sleep.mode ? '<button data-off="1" class="nm-sleep-off">Turn off</button>' : '');
    ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'dblclick'].forEach(function (ev) {
      m.addEventListener(ev, function (e) { e.stopPropagation(); });
    });
    m.querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () {
        if (b.getAttribute('data-off')) setSleep(null);
        else { var o = opts[Number(b.getAttribute('data-i'))]; setSleep(o[1], o[2]); }
        closeSleepMenu();
      });
    });
    document.body.appendChild(m);
    var r = btn.getBoundingClientRect();
    if (r.width && r.top > m.offsetHeight + 20) {
      // Above the moon button.
      m.style.left = Math.max(8, Math.min(window.innerWidth - m.offsetWidth - 8, r.left + r.width / 2 - m.offsetWidth / 2)) + 'px';
      m.style.bottom = (window.innerHeight - r.top + 10) + 'px';
    } else {
      // The controls are hidden or too close to the top: use the bottom-right corner.
      m.style.right = '2vw';
      m.style.bottom = '14vh';
    }
    sleep.menu = m;
  }

  // Add the moon button next to the player's settings button whenever the controls are (re)built.
  function addSleepButton() {
    if (!onPlayer()) return;
    var bar = document.querySelector('.videoOsdBottom .buttons.focuscontainer-x') ||
              (document.querySelector('.videoOsdBottom .btnVideoOsdSettings') || {}).parentElement;
    if (!bar || bar.querySelector('.nm-sleep-btn')) return;
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'paper-icon-button-light autoSize nm-sleep-btn';
    b.innerHTML = MOON + '<span class="nm-sleep-left"></span>';
    b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); openSleepMenu(b); });
    var before = bar.querySelector('.btnVideoOsdSettings');
    if (before) bar.insertBefore(b, before); else bar.appendChild(b);
    updateSleepButtons();
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
    '.nm-px{position:fixed;right:1vw;left:auto;top:auto;bottom:1.5vh;width:min(42vw,800px);max-height:44vh;overflow-y:auto;box-sizing:border-box;z-index:2147482000;padding:1.1em 1.4em;border-radius:8px;background:rgba(12,12,16,.55);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.6);box-shadow:0 10px 32px rgba(0,0,0,.35);opacity:0;transform:translateY(14px);transition:opacity .3s ease,transform .3s ease}',
    '.nm-px.nm-in{opacity:1;transform:none}',
    '.nm-px-kicker{font-size:.8rem;letter-spacing:.16em;text-transform:uppercase;color:#00a4dc}',
    '.nm-px-title{font-size:1.5rem;font-weight:600;line-height:1.2;margin-top:.15em}',
    '.nm-px-sub{font-size:.95rem;opacity:.65;margin-top:.2em}',
    '.nm-px-ov{font-size:.92rem;line-height:1.45;opacity:.85;margin:.6em 0 0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
    '.nm-px-h{font-size:.78rem;letter-spacing:.14em;text-transform:uppercase;opacity:.7;margin:.9em 0 .4em}',
    '.nm-px-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(165px,1fr));gap:.2em .5em}',
    '.nm-px-p,.nm-px-item{display:flex;align-items:center;gap:.65em;padding:.35em;border-radius:8px;text-align:left}',
    '.nm-px-p{background:none;border:0;color:inherit;font:inherit;cursor:pointer}',
    '.nm-px-p:hover,.nm-px-p:focus-visible{background:rgba(255,255,255,.1);outline:none}',
    '.nm-px-face{width:44px;height:44px;flex:none;border-radius:50%;object-fit:cover;background:#3a3a44;display:flex;align-items:center;justify-content:center;font-weight:600}',
    '.nm-px-name{display:block;font-size:.9rem;font-weight:600;line-height:1.25}',
    '.nm-px-role{display:block;font-size:.8rem;opacity:.6;line-height:1.25}',
    '.nm-px-item img,.nm-px-item>span:first-child:empty{width:36px;height:54px;flex:none;border-radius:4px;object-fit:cover;background:#3a3a44}',
    '.nm-px-back{background:none;border:0;color:#00a4dc;font:inherit;font-size:.9rem;padding:0 0 .6em;cursor:pointer}',
    '.nm-sleep-btn{display:inline-flex!important;align-items:center;gap:.15em;position:relative}',
    '.nm-sleep-btn.nm-sleep-on{color:#00a4dc}',
    '.nm-sleep-left{font-size:.75rem;font-weight:600;min-width:0}',
    '.nm-sleep-menu{position:fixed;z-index:2147483100;min-width:12em;padding:.5em;border-radius:8px;background:rgba(20,20,26,.96);color:#fff;box-shadow:0 10px 30px rgba(0,0,0,.6);display:flex;flex-direction:column}',
    '.nm-sleep-h{font-size:.75rem;letter-spacing:.12em;text-transform:uppercase;opacity:.65;padding:.35em .6em .5em}',
    '.nm-sleep-menu button{background:none;border:0;color:inherit;font:inherit;text-align:left;padding:.5em .7em;border-radius:6px;cursor:pointer}',
    '.nm-sleep-menu button:hover,.nm-sleep-menu button:focus-visible{background:rgba(255,255,255,.12);outline:none}',
    '.nm-sleep-off{color:#ff8a80!important}',
    '.nm-toast{position:fixed;left:50%;top:6vh;transform:translate(-50%,-10px);z-index:2147483100;display:flex;align-items:center;gap:.8em;padding:.7em 1em;border-radius:8px;background:rgba(20,20,26,.94);color:#fff;box-shadow:0 10px 30px rgba(0,0,0,.6);opacity:0;transition:opacity .25s,transform .25s}',
    '.nm-toast.nm-in{opacity:1;transform:translate(-50%,0)}',
    '.nm-toast button{background:rgba(255,255,255,.14);border:0;color:#fff;font:inherit;padding:.4em .8em;border-radius:6px;cursor:pointer}',
    '.nm-toast button:hover{filter:brightness(1.3)}',
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
    if (!st.shown && !st.done && pos >= at && (!st.end || pos < st.end - 2)) {
      if (sleep.mode === 'episode') { st.done = true; sleepNow(v, 'Sleep timer: paused at the end of the episode.'); }
      else show(v);
    }
    else if (st.shown && !st.starting && pos < at - 3) hide();   // seeked back before the credits
  }, true);
  if (CFG.sleep) {
    // The player rebuilds its controls for each video, so keep checking while on the player page.
    setInterval(addSleepButton, 1000);
    window.addEventListener('hashchange', function () {
      closeSleepMenu();
      if (!onPlayer() && sleep.mode) { clearInterval(sleep.timer); sleep.mode = null; updateSleepButtons(); }
    });
    document.addEventListener('click', function (e) {
      if (sleep.menu && !sleep.menu.contains(e.target) && !(e.target.closest && e.target.closest('.nm-sleep-btn'))) closeSleepMenu();
    }, true);
  }
  if (CFG.pauseInfo) {
    // Show the panel a moment after the user pauses in the full-screen player (not for quick pauses,
    // and not for background or trailer videos elsewhere in the web app).
    document.addEventListener('pause', function (e) {
      var v = e.target;
      if (!(v instanceof HTMLVideoElement) || location.hash.indexOf('#/video') !== 0) return;
      clearTimeout(px.timer);
      px.timer = setTimeout(function () { showPauseInfo(v); }, 1200);
    }, true);
    ['play', 'playing', 'loadstart', 'emptied'].forEach(function (t) {
      document.addEventListener(t, function (e) { if (e.target instanceof HTMLVideoElement) hidePauseInfo(); }, true);
    });
    window.addEventListener('hashchange', hidePauseInfo);
    document.addEventListener('keydown', function (e) {
      if (px.el && e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); hidePauseInfo(); }
    }, true);
  }
  document.addEventListener('keydown', function (e) {
    if (!st.shown) return;
    if (e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); primaryAction(); }
    else if (e.key === 'Escape' || e.key === 'Backspace') { e.preventDefault(); e.stopImmediatePropagation(); keepWatching(); }
  }, true);
  setInterval(function () { if (st.shown && st.video && !document.contains(st.video)) hide(); }, 2000);
  log('loaded', CFG);
})();
