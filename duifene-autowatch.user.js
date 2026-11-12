// ==UserScript==
// @name         对分易 / SPOC 视频：自动观看 + 倍速伪装 + 进度上报录制回放
// @namespace    https://local/duifene-watch
// @version      1.2.0
// @description  自动播放、自动静音、防暂停、防失焦、倍速对外伪装成 1x；录制并回放学习进度上报请求；一键导出视频直链供转写总结
// @author       lead
// @match        *://*.duifene.com/*
// @match        *://duifene.com/*
// @match        *://*.yuketang.cn/*
// @match        *://*.chaoxing.com/*
// @match        *://*.zhihuishu.com/*
// @match        *://*.icourse163.org/*
// @match        *://*.xuetangx.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

// 如果你的播放器在【跨域 iframe】里（面板不出现），在脚本头部 @match 区加一行：
//     @match        *://*/*
// 然后在 Tampermonkey 设置里把「注入 iframe」打开（默认就是开的）。

(function () {
  'use strict';
  if (window.__DFE_WATCH__) return;
  window.__DFE_WATCH__ = true;

  // ───────────────────────── 配置 ─────────────────────────
  const CFG = {
    mode: 'fast',        // 'fast' 激进 | 'safe' 保守 | 'off' 全关
    rate: 8,             // 激进模式的真实倍率（对外永远报 1x）
    safeRate: 2,         // 保守模式的倍率（如实上报，最不容易被记异常）
    fakeRate: 1,         // 对外读取到的倍率，永远是 1
    mute: true,          // 自动静音（不影响进度）
    keepAlive: true,     // 防暂停 / 防失焦 / 定时拉回播放
    autoNext: true,      // 播完自动点「下一个」
    quizGuard: true,     // 弹题 / 防挂机检测告警
    pollMs: 600,
  };
  const LS_CFG = 'dfe_cfg_v1', LS_REP = 'dfe_reports_v1';
  try { Object.assign(CFG, JSON.parse(localStorage.getItem(LS_CFG) || '{}')); } catch (e) {}
  const saveCfg = () => { try { localStorage.setItem(LS_CFG, JSON.stringify(CFG)); } catch (e) {} };

  const LOG = [];
  const log = (...a) => {
    const s = a.map(x => (typeof x === 'object' ? safeStr(x) : String(x))).join(' ');
    LOG.push(new Date().toLocaleTimeString() + '  ' + s);
    if (LOG.length > 400) LOG.shift();
    if (ui.logBox) { ui.logBox.textContent = LOG.slice(-60).join('\n'); ui.logBox.scrollTop = 1e9; }
    try { console.log('%c[DFE]', 'color:#0af', s); } catch (e) {}
  };
  const safeStr = o => { try { return JSON.stringify(o); } catch (e) { return String(o); } };

  // ───────────────────── 1. 倍速伪装（核心） ─────────────────────
  // 页面读 playbackRate 永远拿到 1；写 playbackRate 会被抬到 CFG.rate。
  const realRateSet = new WeakMap();
  try {
    const proto = HTMLMediaElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'playbackRate');
    if (desc && desc.get && desc.set) {
      Object.defineProperty(proto, 'playbackRate', {
        configurable: true,
        enumerable: desc.enumerable,
        get() {
          if (CFG.mode === 'off' || CFG.mode === 'safe') return desc.get.call(this);
          return CFG.fakeRate;
        },
        set(v) {
          const real = (CFG.mode === 'off' || CFG.mode === 'safe')
            ? v
            : Math.max(CFG.rate, Number(v) || 1);
          realRateSet.set(this, real);
          try { desc.set.call(this, real); } catch (e) {}
        },
      });
    }
    // defaultPlaybackRate 同样处理
    const d2 = Object.getOwnPropertyDescriptor(proto, 'defaultPlaybackRate');
    if (d2 && d2.get && d2.set) {
      Object.defineProperty(proto, 'defaultPlaybackRate', {
        configurable: true, enumerable: d2.enumerable,
        get() { return (CFG.mode === 'fast') ? CFG.fakeRate : d2.get.call(this); },
        set(v) { try { d2.set.call(this, (CFG.mode === 'fast') ? Math.max(CFG.rate, Number(v) || 1) : v); } catch (e) {} },
      });
    }
  } catch (e) { log('倍速补丁失败', e.message); }

  // 有些播放器直接读 <video> 的 playbackRate 也是上面这个 getter，已覆盖。
  // 少数走 requestAnimationFrame 采样 currentTime 推算倍率 → 见下方 reportRewrite。

  // ───────────────────── 2. 焦点 / 可见性伪装 ─────────────────────
  try {
    const MINE = Symbol('dfe');
    const BLOCKED = ['visibilitychange', 'webkitvisibilitychange', 'blur', 'pagehide', 'mouseleave', 'freeze'];
    const rawAdd = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, fn, opt) {
      try {
        if (CFG.keepAlive && BLOCKED.includes(type) && !(fn && fn[MINE]) &&
            (this === document || this === window || this === document.documentElement)) {
          return; // 页面注册的“离开页面就暂停”监听，直接不注册
        }
      } catch (e) {}
      return rawAdd.call(this, type, fn, opt);
    };
    const addMine = (t, fn, o) => { fn[MINE] = true; return rawAdd.call(window, t, fn, o); };
    for (const [obj, prop, val] of [
      [Document.prototype, 'hidden', false],
      [Document.prototype, 'visibilityState', 'visible'],
      [Document.prototype, 'webkitHidden', false],
      [Document.prototype, 'webkitVisibilityState', 'visible'],
    ]) {
      try { Object.defineProperty(obj, prop, { configurable: true, get() { return val; } }); } catch (e) {}
    }
    // 定时补一次 focus，防播放器自己判断 hasFocus()
    addMine('__dfe_tick', () => {});
    setInterval(() => {
      if (!CFG.keepAlive) return;
      try { window.dispatchEvent(new Event('focus')); } catch (e) {}
    }, 4000);
  } catch (e) { log('焦点补丁失败', e.message); }

  // ───────────────────── 3. 视频接管 ─────────────────────
  let video = null, lastSrc = '';
  const videos = () => Array.from(document.querySelectorAll('video'));
  const wantRate = () => Math.max(1, CFG.mode === 'safe' ? CFG.safeRate : CFG.rate);

  function pickVideo() {
    const vs = videos().filter(v => v.duration && isFinite(v.duration) && v.duration > 0);
    if (!vs.length) return null;
    if (video && vs.includes(video)) return video;      // 认住当前这个，别乱切
    return vs.sort((a, b) => (b.duration || 0) - (a.duration || 0))[0];
  }

  function takeover(v, why) {
    if (!v) { log('没有找到 <video>'); return; }
    video = v;
    if (why) log('接管:', why);
    try { if (CFG.mute) v.muted = true; v.volume = 0; } catch (e) {}
    try {
      if (CFG.mode === 'fast' || CFG.mode === 'safe') {
        v.playbackRate = wantRate(); // 激进：落到 8x（对外仍报 1x）；保守：落到 2x（如实报）
      }
    } catch (e) { log('设倍率失败', e.message); }
    try { v.play().catch(() => {}); } catch (e) {}
    const src = v.currentSrc || v.src || '';
    if (src && src !== lastSrc) { lastSrc = src; log('视频源:', src.slice(0, 120)); }
  }

  // 定时巡检
  setInterval(() => {
    if (CFG.mode === 'off') return;
    const v = pickVideo();
    if (!v) return;
    if (v !== video) { takeover(v, '检测到新视频'); return; }
    const curSrc = v.currentSrc || v.src || '';
    if (curSrc && curSrc !== lastSrc) {   // 同一个 video 元素换了片源（播放列表常见）
      lastSrc = curSrc;
      log('视频源切换:', curSrc.slice(0, 120));
      try { v.playbackRate = wantRate(); } catch (e) {}
    }
    if (CFG.keepAlive) {
      if (v.paused && !v.ended && v.currentTime < (v.duration || 1e9) - 1.2) {
        try { v.play().catch(() => {}); } catch (e) {}
      }
      if (CFG.mode !== 'off' && (realRateSet.get(v) || 1) < wantRate() - 0.01) {
        try { v.playbackRate = wantRate(); } catch (e) {}
      }
      if (!v.muted && CFG.mute) { try { v.muted = true; } catch (e) {} }
    }
    if (CFG.autoNext && v.ended) nextVideo();
    updateHud();
  }, CFG.pollMs);

  // pause 拦截
  document.addEventListener('pause', e => {
    const v = e.target;
    if (!CFG.keepAlive || CFG.mode === 'off' || v.tagName !== 'VIDEO') return;
    if (v.ended) return;
    if (v.currentTime >= (v.duration || 0) - 0.8) return;
    setTimeout(() => { try { v.play().catch(() => {}); } catch (er) {} }, 80);
  }, true);

  // 播完自动下一个
  function nextVideo() {
    if (nextVideo._lock && Date.now() - nextVideo._lock < 6000) return;
    const pats = /^(下一(个|节|集|章|讲|课)|继续学习|继续观看|下一部分|next)$/i;
    const nodes = Array.from(document.querySelectorAll('a,button,div[role=button],li,span'));
    const hit = nodes.find(n => {
      const t = (n.textContent || '').trim();
      return t && t.length < 12 && pats.test(t) && n.offsetParent !== null;
    });
    if (hit) {
      nextVideo._lock = Date.now();
      log('播完，点击:', (hit.textContent || '').trim());
      try { hit.click(); } catch (e) {}
      setTimeout(() => { const v = pickVideo(); if (v) takeover(v, '切下一节'); }, 2500);
    } else {
      log('播完，但没找到「下一个」按钮 —— 手动切一下，脚本会自己接管');
    }
  }

  // ───────────────────── 4. 上报请求录制 ─────────────────────
  const REPORTS = (() => { try { return JSON.parse(localStorage.getItem(LS_REP) || '[]'); } catch (e) { return []; } })();
  const persistRep = () => { try { localStorage.setItem(LS_REP, JSON.stringify(REPORTS.slice(-400))); } catch (e) {} };

  const URL_HINT = /(progress|study|learn|learnlog|record|watch|playlog|log|time|heartbeat|report|stat|point|video|course|res|stu)/i;
  const BODY_HINT = /(progress|position|currenttime|current_time|studytime|study_time|playtime|play_time|seconds|duration|played|seek|rate|speed|percent|finish|completed)/i;

  function isReport(url, body) {
    const u = String(url || '');
    if (u.startsWith('data:') || u.startsWith('blob:')) return false;
    if (/\.(png|jpe?g|gif|css|woff2?|svg|ico|map)(\?|$)/i.test(u)) return false;
    if (URL_HINT.test(u)) return true;
    const b = typeof body === 'string' ? body : '';
    return BODY_HINT.test(b);
  }

  function rec(method, url, body, headers) {
    if (CFG.mode === 'off') return;
    if (window.__DFE_REPLAY) return;   // 回放打点时不要再录自己的请求
    if (!isReport(url, body)) return;
    REPORTS.push({
      t: Date.now(), method: (method || 'GET').toUpperCase(),
      url: String(url), body: typeof body === 'string' ? body.slice(0, 4000) : '',
      headers: headers || {},
    });
    if (REPORTS.length > 400) REPORTS.shift();
    persistRep();
    if (REPORTS.length % 5 === 0) log('已录制上报请求', REPORTS.length, '条');
  }

  // XHR
  (function hookXHR() {
    const XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send, XH = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.open = function (m, u) {
      this.__dfe = { m, u: u && u.toString(), h: {} };
      return XO.apply(this, arguments);
    };
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
      try { if (this.__dfe) this.__dfe.h[k] = v; } catch (e) {}
      return XH.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (b) {
      try { if (this.__dfe) rec(this.__dfe.m, this.__dfe.u, typeof b === 'string' ? b : '', this.__dfe.h); } catch (e) {}
      return XS.apply(this, arguments);
    };
  })();

  // fetch
  (function hookFetch() {
    const F = window.fetch;
    if (!F) return;
    window.fetch = function (input, init) {
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const m = (init && init.method) || (input && input.method) || 'GET';
        const b = init && typeof init.body === 'string' ? init.body : '';
        rec(m, url, b, init && init.headers);
      } catch (e) {}
      return F.apply(this, arguments);
    };
  })();

  // 发报告（回放用）
  function fire(rep, body, i) {
    return new Promise(res => {
      try {
        const x = new XMLHttpRequest();
        x.open(rep.method, rep.url, true);
        let hasCT = false;
        for (const k in (rep.headers || {})) {
          if (/^content-type$/i.test(k)) hasCT = true;
          try { x.setRequestHeader(k, rep.headers[k]); } catch (e) {}
        }
        if (body && !hasCT) { try { x.setRequestHeader('Content-Type', /^[[{]/.test(body) ? 'application/json' : 'application/x-www-form-urlencoded'); } catch (e) {} }
        x.onloadend = () => res({ ok: x.status, text: (x.responseText || '').slice(0, 200) });
        x.onerror = () => res({ ok: 0, text: 'net error' });
        x.send(body || null);
      } catch (e) { res({ ok: -1, text: e.message }); }
      setTimeout(() => res({ ok: -2, text: 'timeout' }), 8000);
    });
  }

  // ───────────────────── 5. 报文改写：position 打点 ─────────────────────
  const POS_KEY = /(^|_)(pos|position|pt|current|cur|now|seek|progress|played|playtime|play_?time|study_?time|studytime|learn_?time|watch_?time|second|sec|time|elapsed|offset)($|_)/i;
  const DUR_KEY = /(^|_)(duration|total|length|full|all_?time|videotime|video_?time)($|_)/i;
  const RATE_KEY = /(^|_)(rate|speed|play_?speed|playrate|multiplier|倍速)($|_)/i;
  // 从报文里抠「第一个像播放位置的字段」，用来判断平台用秒还是毫秒
  const FIELD_PROBE = /"?([A-Za-z_]*(?:pos|position|playtime|play_time|studytime|study_time|progress|played|currenttime|current_time))"?\s*[:=]\s*"?(-?\d+(?:\.\d+)?)/i;

  function walkMutate(obj, fn) {
    if (obj === null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(x => walkMutate(x, fn));
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (v !== null && typeof v === 'object') obj[k] = walkMutate(v, fn);
      else {
        const r = fn(k, v);
        if (r !== undefined) obj[k] = r;
      }
    }
    return obj;
  }

  function mutateBody(body, ctx) {
    if (!body) return body;
    const s = body.trim();
    // JSON
    if (/^[[{]/.test(s)) {
      try {
        const o = JSON.parse(s);
        walkMutate(o, (k, v) => {
          if (RATE_KEY.test(k)) return 1;
          if (DUR_KEY.test(k) && ctx.duration) return Math.round(ctx.duration * 1000) > 1e6 ? ctx.duration * 1000 : ctx.duration;
          if (POS_KEY.test(k)) {
            const num = typeof v === 'number' ? v : parseFloat(v);
            if (isFinite(num)) return typeof v === 'number' ? ctx.pos : String(ctx.pos);
          }
          return undefined;
        });
        return JSON.stringify(o);
      } catch (e) {}
    }
    // form-urlencoded
    if (/=/.test(s) && !/[<>]/.test(s)) {
      const parts = s.split('&').map(kv => {
        const i = kv.indexOf('='); if (i < 0) return kv;
        const k = decodeURIComponent(kv.slice(0, i)), v = kv.slice(i + 1);
        if (RATE_KEY.test(k)) return k + '=' + 1;
        if (POS_KEY.test(k)) return k + '=' + ctx.pos;
        if (DUR_KEY.test(k) && ctx.duration) return k + '=' + ctx.duration;
        return kv;
      });
      return parts.join('&');
    }
    return body;
  }

  // 回放：把录到的上报按「正常速度」的节奏重发一遍，位置走完 0→duration
  async function replay(opts) {
    opts = Object.assign({ steps: 20, gapMs: 1200, duration: null, startPos: 0, dryRun: false }, opts || {});
    const list = REPORTS.filter(r => r.method && r.url);
    if (!list.length) { log('没有录到上报请求：先正常播放 1 分钟，再点「回放打点」'); return; }
    const dur = opts.duration || (video && video.duration) || 0;
    log('开始回放：模板', list.length, '条，时长', dur, 's，步数', opts.steps, '步');

    // 只保留“看起来像进度上报”的模板（body 里有位置字段，或 URL 命中进度关键词）
    const tpl = list.filter(r => (r.body && POS_KEY.test(r.body)) || /progress|study|learn|record|watch|playlog|heartbeat/i.test(r.url));
    const use = tpl.length ? tpl : list.slice(-3);
    log('使用模板', use.length, '条', opts.dryRun ? '(演练，不发送)' : '');

    let sent = 0, ok = 0;
    // 毫秒/秒自动判别：拿模板里第一个位置字段的量级和总时长比一下
    for (const r of use) {
      const m = (r.body || '').match(FIELD_PROBE);
      if (m) {
        const v = Math.abs(parseFloat(m[2]));
        r.__scale = (dur && v > dur * 3) ? 1000 : 1;
        log('模板', r.url.slice(0, 60), '位置字段量级', v, '→ 判定单位', r.__scale === 1000 ? '毫秒' : '秒');
        break;
      }
    }
    window.__DFE_REPLAY = true;
    try {
      for (let i = 1; i <= opts.steps; i++) {
        for (const r of use) {
          const raw = dur ? Math.round((dur * i) / opts.steps) : Math.round(opts.startPos + i * 30);
          const pos = raw * (r.__scale || 1);
          const body = mutateBody(r.body, { pos, duration: dur ? dur * (r.__scale || 1) : 0 });
          if (opts.dryRun) { log('[dry]', r.method, r.url.slice(0, 90), body.slice(0, 160)); sent++; continue; }
          const res = await fire(r, body, i);
          sent++;
          if (res.ok >= 200 && res.ok < 400) ok++;
          else log('✗', res.ok, r.url.slice(0, 80), res.text.slice(0, 120));
          await new Promise(z => setTimeout(z, 120));
        }
        log(`打点 ${i}/${opts.steps}  位置 ${dur ? Math.round((dur * i) / opts.steps) : '?'}s  成功 ${ok}/${sent}`);
        if (i < opts.steps) await new Promise(z => setTimeout(z, opts.gapMs));
      }
    } finally { window.__DFE_REPLAY = false; }
    log('回放结束，成功', ok, '/', sent);
  }

  // ───────────────────── 6. 弹题 / 防挂机告警 ─────────────────────
  const QUIZ_RE = /(弹题|随堂测|请作答|请回答|检测到|请勿离开|离开页面|挂机|防挂|人脸|验证码|继续播放请|确认在线)/;
  function beep(times) {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = beep._c || (beep._c = new AC());
      for (let i = 0; i < (times || 3); i++) {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'square'; o.frequency.value = 880;
        g.gain.value = 0.08;
        o.connect(g); g.connect(ctx.destination);
        o.start(ctx.currentTime + i * 0.35);
        o.stop(ctx.currentTime + i * 0.25 + i * 0.35);
      }
    } catch (e) {}
  }
  let quizHitAt = 0;
  function scanQuiz() {
    if (!CFG.quizGuard) return;
    const txt = document.body ? document.body.innerText : '';
    if (!txt) return;
    const m = txt.match(QUIZ_RE);
    if (m && Date.now() - quizHitAt > 20000) {
      quizHitAt = Date.now();
      log('⚠️ 检测到可能的弹题/防挂机检查：', m[0]);
      beep(4);
      document.title = '⚠️ 需要人工确认 — ' + document.title.replace(/^⚠️[^—]*—\s*/, '');
      ui.alert && ui.alert(m[0]);
    }
  }
  setInterval(scanQuiz, 3000);

  // ───────────────────── 7. 视频直链收集（转写用） ─────────────────────
  function mediaList() {
    const out = new Set();
    document.querySelectorAll('video').forEach(v => {
      if (v.currentSrc) out.add(v.currentSrc);
      if (v.src) out.add(v.src);
      v.querySelectorAll('source').forEach(s => s.src && out.add(s.src));
    });
    try {
      performance.getEntriesByType('resource').forEach(e => {
        if (/\.(m3u8|mp4|flv|f4v|ts)(\?|$)/i.test(e.name) && !/[?&](range|start)=/i.test(e.name)) out.add(e.name);
      });
    } catch (e) {}
    // 常见播放器实例
    ['player', 'aliplayer', 'tcplayer', 'polyvPlayer', 'dp', 'dplayer'].forEach(k => {
      try {
        const p = window[k];
        const u = p && (p.url || (p.config && p.config.url) || (p.options && p.options.video && p.options.video.url));
        if (typeof u === 'string' && u) out.add(u);
      } catch (e) {}
    });
    return Array.from(out).filter(u => u && (/^https?:/i.test(u) || /\.(m3u8|mp4|flv|ts)(\?|$)/i.test(u)));
  }

  // ───────────────────── 8. 面板 ─────────────────────
  const ui = {};
  function buildUI() {
    if (document.getElementById('dfe-panel')) return;
    const wrap = document.createElement('div');
    wrap.id = 'dfe-panel';
    wrap.innerHTML = `
<style>
#dfe-panel{position:fixed;right:14px;bottom:14px;width:320px;z-index:2147483647;font:12px/1.5 -apple-system,'Segoe UI',system-ui,sans-serif;color:#e8eef6}
#dfe-panel .box{background:#12161c;border:1px solid #2a3442;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.45);overflow:hidden}
#dfe-panel .hd{display:flex;align-items:center;gap:6px;padding:7px 10px;background:#1a2230;cursor:pointer;user-select:none}
#dfe-panel .hd b{font-size:12px;letter-spacing:.5px;color:#7fd1ff}
#dfe-panel .hd .dot{width:7px;height:7px;border-radius:50%;background:#31d07a;box-shadow:0 0 8px #31d07a}
#dfe-panel .bd{padding:9px 10px;display:grid;gap:7px}
#dfe-panel .row{display:flex;gap:6px;align-items:center}
#dfe-panel input[type=number]{width:52px;background:#0c1016;border:1px solid #2a3442;color:#e8eef6;border-radius:6px;padding:2px 5px}
#dfe-panel button{flex:1;background:#22303f;border:1px solid #33465c;color:#dbe8f5;border-radius:6px;padding:5px 6px;cursor:pointer;font-size:11.5px}
#dfe-panel button:hover{background:#2c3f54}
#dfe-panel button.pri{background:#1b6e46;border-color:#2a9c66}
#dfe-panel button.warn{background:#6e3a1b;border-color:#9c5f2a}
#dfe-panel .hud{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:#8fa6bd;display:flex;justify-content:space-between}
#dfe-panel .bar{height:4px;background:#0c1016;border-radius:3px;overflow:hidden}
#dfe-panel .bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,#31d07a,#7fd1ff)}
#dfe-panel pre{margin:0;max-height:96px;overflow:auto;background:#0a0e13;border:1px solid #1d2632;border-radius:6px;padding:5px;font-size:10.5px;color:#8fa6bd;white-space:pre-wrap}
#dfe-panel .fold{display:none}
#dfe-panel .alert{color:#ffb84d;font-size:11px;min-height:0}
</style>
<div class="box">
  <div class="hd"><span class="dot"></span><b>DFE 自动观看</b><span style="margin-left:auto;color:#5c748c">v1.2</span></div>
  <div class="bd">
    <div class="hud"><span id="dfe-t">--:-- / --:--</span><span id="dfe-r">1x</span></div>
    <div class="bar"><i id="dfe-p"></i></div>
    <div class="row">
      <span style="color:#8fa6bd">倍率</span>
      <input id="dfe-rate" type="number" step="0.5" min="1" max="16">
      <button id="dfe-apply" class="pri">应用</button>
      <button id="dfe-mode">激进</button>
    </div>
    <div class="row">
      <button id="dfe-take">接管播放</button>
      <button id="dfe-rep">上报记录 <span id="dfe-repn">0</span></button>
    </div>
    <div class="row">
      <button id="dfe-replay" class="warn">回放打点</button>
      <button id="dfe-dump">导出记录</button>
    </div>
    <div class="row">
      <button id="dfe-media">复制视频直链</button>
      <button id="dfe-clear">清空</button>
    </div>
    <div class="alert" id="dfe-alert"></div>
    <pre id="dfe-log"></pre>
  </div>
</div>`;
    document.documentElement.appendChild(wrap);

    const $ = s => wrap.querySelector(s);
    ui.logBox = $('#dfe-log');
    ui.alert = t => { $('#dfe-alert').textContent = '⚠️ ' + t + '（请人工确认）'; };
    ui.hudT = $('#dfe-t'); ui.hudR = $('#dfe-r'); ui.bar = $('#dfe-p');
    ui.repN = $('#dfe-repn');
    ui.logBox.textContent = LOG.slice(-60).join('\n');

    $('#dfe-rate').value = CFG.rate;
    $('#dfe-mode').textContent = CFG.mode === 'fast' ? '激进' : CFG.mode === 'safe' ? '保守' : '关闭';

    wrap.querySelector('.hd').onclick = () => wrap.querySelector('.bd').classList.toggle('fold');

    $('#dfe-apply').onclick = () => {
      CFG.rate = Math.min(16, Math.max(1, parseFloat($('#dfe-rate').value) || 8));
      CFG.mode = 'fast'; $('#dfe-mode').textContent = '激进'; saveCfg();
      const v = pickVideo(); if (v) takeover(v, '应用倍率 ' + CFG.rate);
      log('倍率设为', CFG.rate, '（对外仍显示 1x）');
    };
    $('#dfe-mode').onclick = () => {
      CFG.mode = CFG.mode === 'fast' ? 'safe' : CFG.mode === 'safe' ? 'off' : 'fast';
      $('#dfe-mode').textContent = CFG.mode === 'fast' ? '激进' : CFG.mode === 'safe' ? '保守' : '关闭';
      saveCfg(); log('模式:', CFG.mode);
      if (CFG.mode !== 'off') { const v = pickVideo(); if (v) takeover(v, '切模式'); }
    };
    $('#dfe-take').onclick = () => { const v = pickVideo(); takeover(v, '手动'); };
    $('#dfe-media').onclick = () => {
      const list = mediaList();
      const txt = list.join('\n');
      log('媒体候选:\n' + (txt || '(空，先把视频播一下)'));
      try { navigator.clipboard.writeText(txt); log('已复制到剪贴板:', list.length, '条'); } catch (e) {}
    };
    $('#dfe-rep').onclick = () => {
      log('上报记录共', REPORTS.length, '条');
      REPORTS.slice(-10).forEach(r => log('·', r.method, r.url.slice(0, 90), (r.body || '').slice(0, 100)));
    };
    $('#dfe-dump').onclick = () => {
      const blob = new Blob([JSON.stringify(REPORTS, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'dfe-reports-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
      a.click();
      try { navigator.clipboard.writeText(JSON.stringify(REPORTS, null, 2)); } catch (e) {}
      log('已导出并复制', REPORTS.length, '条');
    };
    $('#dfe-clear').onclick = () => { REPORTS.length = 0; persistRep(); log('记录已清空'); };
    $('#dfe-replay').onclick = async () => {
      const dur = (video && video.duration) || parseFloat(prompt('视频总时长（秒）？', '600')) || 600;
      const steps = parseInt(prompt('打点步数（越大越像匀速，默认 20）', '20') || '20', 10);
      const gap = parseInt(prompt('每步间隔毫秒（默认 1500）', '1500') || '1500', 10);
      const dry = (prompt('先演练一次？输入 y 只看不改，输入 n 直接发送', 'y') || 'y').toLowerCase() === 'y';
      await replay({ duration: dur, steps, gapMs: gap, dryRun: dry });
    };

    let hideTimer = null;
    wrap.addEventListener('mouseenter', () => { hideTimer && clearTimeout(hideTimer); wrap.querySelector('.bd').classList.remove('fold'); });
    wrap.addEventListener('mouseleave', () => { hideTimer = setTimeout(() => wrap.querySelector('.bd').classList.add('fold'), 1500); });
    setTimeout(() => wrap.querySelector('.bd').classList.add('fold'), 4000);
  }

  const fmt = s => {
    s = Math.max(0, Math.floor(s || 0));
    const m = Math.floor(s / 60), r = s % 60;
    return (m < 10 ? '0' : '') + m + ':' + (r < 10 ? '0' : '') + r;
  };
  function updateHud() {
    if (!ui.hudT) return;
    const v = video || pickVideo();
    if (!v) { ui.hudT.textContent = '未找到视频'; return; }
    ui.hudT.textContent = fmt(v.currentTime) + ' / ' + fmt(v.duration);
    ui.hudR.textContent = (v.paused ? '⏸ ' : '▶ ') + '1x (real ' + CFG.rate + 'x)';
    ui.bar.style.width = (v.duration ? (v.currentTime / v.duration) * 100 : 0).toFixed(1) + '%';
    if (ui.repN) ui.repN.textContent = REPORTS.length;
  }

  // ───────────────────── 启动 ─────────────────────
  const boot = () => {
    buildUI();
    log('脚本已就绪；模式', CFG.mode, '倍率', CFG.rate, '（对外 1x）');
    try { const v = pickVideo(); if (v) takeover(v, '初始'); } catch (e) {}
    updateHud();
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else boot();
  setTimeout(boot, 2500); // 部分 SPA 首屏很晚

  // 控制台快捷入口
  window.DFE = {
    cfg: CFG, reports: REPORTS, media: mediaList, replay,
    take: () => takeover(pickVideo(), 'console'),
    setRate: r => { CFG.rate = r; CFG.mode = 'fast'; saveCfg(); takeover(pickVideo(), 'console'); },
    stop: () => { CFG.mode = 'off'; const v = pickVideo(); if (v) { v.pause(); } },
    log: () => LOG.join('\n'),
  };
})();
