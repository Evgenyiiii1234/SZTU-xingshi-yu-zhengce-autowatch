/**
 * 用户脚本冒烟测试：用 jsdom 造一个假页面把 duifene-autowatch.user.js 跑起来，
 * 检查 1) 加载不抛异常 2) 面板注入 3) 倍速伪装生效 4) 上报录制/回放报文改写正确。
 *
 *   node tests/smoke_user_script.js
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const code = fs.readFileSync(path.join(ROOT, 'duifene-autowatch.user.js'), 'utf8');

// 预埋几条“平台上报请求”，用于验证回放改写
const seeded = [
  {
    t: Date.now(), method: 'POST',
    url: 'https://www.duifene.com/_Video/UpdateProgress.ashx',
    body: JSON.stringify({ stuId: 1001, vid: 88, position: 12, duration: 600, rate: 1, state: 1 }),
    headers: { 'Content-Type': 'application/json' },
  },
  {
    t: Date.now(), method: 'POST',
    url: 'https://www.duifene.com/_Video/heartbeat',
    body: 'vid=88&stuId=1001&playTime=12&studyTime=12&totalTime=600',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  },
];

const dom = new JSDOM(
  `<!doctype html><html><head><title>课程视频</title></head>
   <body><div id="wrap"><video id="v" src="https://cdn.test/a.m3u8" controls></video></div></body></html>`,
  {
    url: 'https://www.duifene.com/_FileManage/PC/StFileManage.aspx',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  }
);
const { window } = dom;
const errors = [];
window.addEventListener('error', e => errors.push('window.error: ' + e.message));

// jsdom 的 video 不会真的播放，补几个假属性让脚本走得通
const v = window.document.querySelector('video');
Object.defineProperty(v, 'duration', { value: 600, configurable: true });
Object.defineProperty(v, 'currentTime', { value: 0, writable: true, configurable: true });
v.play = function () { this.paused = false; return Promise.resolve(); };
v.pause = function () { this.paused = true; };

window.localStorage.setItem('dfe_reports_v1', JSON.stringify(seeded));

let fatal = null;
try {
  window.eval(code);
} catch (e) {
  fatal = e;
}

const ok = [], bad = [];
const check = (name, cond, extra = '') => (cond ? ok : bad).push(name + (extra ? ' → ' + extra : ''));

check('脚本加载无异常', !fatal, fatal && fatal.stack.split('\n').slice(0, 3).join(' | '));
check('暴露 window.DFE', !!window.DFE);
check('面板已注入 #dfe-panel', !!window.document.getElementById('dfe-panel'));
check('读到预埋的上报记录', (window.DFE && window.DFE.reports.length === 2),
  window.DFE && String(window.DFE.reports.length));

// 倍速伪装
try {
  v.playbackRate = 2;
  check('页面读 playbackRate 得到 1（伪装成功）', v.playbackRate === 1, 'got ' + v.playbackRate);
} catch (e) {
  check('倍速伪装', false, e.message);
}

// media() 能捞到 src
try {
  const list = window.DFE.media();
  check('media() 捞出视频源', list.some(u => u.includes('a.m3u8')), JSON.stringify(list));
} catch (e) {
  check('media()', false, e.message);
}

// 回放报文改写（dryRun，只打日志不发请求）
(async () => {
  try {
    await window.DFE.replay({ duration: 600, steps: 2, gapMs: 10, dryRun: true });
    const log = window.DFE.log();
    const jsonOk = log.includes('"position":300') && log.includes('"duration":600') && log.includes('"rate":1');
    const formOk = log.includes('playTime=300') && log.includes('totalTime=600') && log.includes('studyTime=300');
    check('JSON 报文位置改写成 300', jsonOk);
    check('表单报文位置改写成 300', formOk);
  } catch (e) {
    check('回放演练', false, e.message);
  }

  console.log('\n通过 ' + ok.length + ' 项：');
  ok.forEach(s => console.log('  ✓ ' + s));
  if (bad.length) {
    console.log('失败 ' + bad.length + ' 项：');
    bad.forEach(s => console.log('  ✗ ' + s));
  }
  if (errors.length) {
    console.log('页面级错误：');
    errors.forEach(s => console.log('  ! ' + s));
  }
  try { window.close(); } catch (e) {}
  process.exit(bad.length ? 1 : 0);
})();
