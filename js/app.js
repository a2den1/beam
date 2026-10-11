import { Relay } from './mqtt.js';
import * as P from './proto.js';
import { Session } from './session.js';
import { View, Gestures } from './touch.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const fmtId = (id) => String(id).replace(/(\d{3})(\d{3})(\d{3})/, '$1 $2 $3');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ic = (n) => Icons.svg(n);
const host = window.beam || null; // PC 앱(일렉트론) 안에서 열렸을 때만 있습니다
if (host) document.body.classList.add('is-host');
let hostStatus = null;

// ── 저장소 ────────────────────────────────────────────────────────
const LS = {
  get(k, d) { try { const v = localStorage.getItem('beam.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('beam.' + k, JSON.stringify(v)); } catch { /* 사생활 보호 모드·용량 초과 */ } },
};
let pcs = LS.get('pcs', []);
// IP·브로드캐스트 주소는 더 이상 받지도 저장하지도 않습니다. 예전 버전이 저장한 값도 지웁니다.
for (const p of pcs) { delete p.ip; delete p.bc; }
const savePcs = () => LS.set('pcs', pcs);
const findPc = (id) => pcs.find((p) => p.id === id);

function deviceName() {
  if (host?.hostName) return host.hostName;
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad|Macintosh.*Mobile/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  const m = /Android [\d.]+; ([^;)]+)/.exec(ua);
  if (m && m[1] !== 'K') return m[1].trim();
  if (/Android/.test(ua)) return 'Android';
  return '브라우저';
}

// ── 토스트 / 확인 대화상자 ─────────────────────────────────────────
let toastT;
function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), ms);
}

function ask({ title, body = '', actions, input = null }) {
  return new Promise((resolve) => {
    const el = $('#ask');
    $('#askTitle').textContent = title;
    const bodyEl = $('#askBody');
    bodyEl.textContent = body;
    let inp = null;
    if (input) {
      inp = document.createElement('input');
      inp.className = 'input';
      inp.value = input.value || '';
      inp.maxLength = 40;
      bodyEl.textContent = '';
      bodyEl.append(inp);
    }
    const box = $('#askActions');
    box.innerHTML = '';
    const done = (v) => { el.hidden = true; document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = (e) => {
      if (e.key === 'Escape') done(null);
      if (e.key === 'Enter' && inp) done(inp.value);
    };
    document.addEventListener('keydown', onKey);
    for (const a of actions) {
      const b = document.createElement('button');
      b.innerHTML = (a.icon ? ic(a.icon) : '') + `<span>${esc(a.label)}</span>`;
      if (a.kind) b.className = a.kind + '-a';
      b.addEventListener('click', () => done(inp ? (a.value ? inp.value : null) : a.value));
      box.append(b);
    }
    el.querySelector('.ask-scrim').onclick = () => done(null);
    el.hidden = false;
    if (inp) setTimeout(() => { inp.focus(); inp.select(); }, 60);
  });
}

// ── 중계 연결과 PC 상태 ─────────────────────────────────────────────
const relay = new Relay();
const presence = new Map(); // id -> { onAt, offAt, lastT }

relay.on((topic, msg) => {
  const m = /^beam1\/(\d{9})\/st$/.exec(topic);
  if (!m) return;
  const p = presence.get(m[1]) || {};
  const pc = findPc(m[1]);
  if (msg.on && msg.t) {
    p.onAt = Date.now();
    p.lastT = msg.t;
    if (pc) {
      let dirty = false;
      if (msg.name && !pc.custom && pc.name !== msg.name) { pc.name = msg.name; dirty = true; }
      if (msg.os && pc.os !== msg.os) { pc.os = msg.os; dirty = true; }
      if (dirty) savePcs();
    }
  } else if (msg.on === false) {
    // 브로커가 여럿이라 늦게 도착한 유언 메시지는 잠시 기다려 보고 판단합니다.
    p.offAt = Date.now();
    p.explicit = !!msg.i;
  }
  presence.set(m[1], p);
  renderHome();
});

function isOnline(id) {
  const p = presence.get(id);
  if (!p || !p.lastT) return false;
  if (Date.now() - p.lastT > 150000) return false; // PC 는 1분마다 신호를 보냅니다
  if (p.offAt && p.offAt > (p.onAt || 0) && (p.explicit || Date.now() - p.offAt > 70000)) return false;
  return true;
}

function watchPresence() { for (const pc of pcs) relay.subscribe(P.topicState(pc.id)); }
setInterval(renderHome, 15000);


// ── 페이지 ─────────────────────────────────────────────────────────
// 탭 전환: 선택 표시가 미끄러져 옮겨 가고, 본문은 아래 탭이면 오른쪽에서·위 탭이면 왼쪽에서 들어옵니다.
const ORDER = ['sessions', 'host', 'settings'];
let curPage = 'sessions';
const navPill = document.createElement('span');
navPill.className = 'nav-pill';
$('.nav').prepend(navPill);
function placePill(animate) {
  const on = $('.nav button.on');
  if (!on) return;
  navPill.style.transition = animate ? '' : 'none';
  navPill.style.transform = `translateY(${on.offsetTop}px)`;
  navPill.style.height = on.offsetHeight + 'px';
}
function go(page) {
  if (page === curPage) return;
  const dir = ORDER.indexOf(page) > ORDER.indexOf(curPage) ? 'in-next' : 'in-prev';
  curPage = page;
  $$('.nav button').forEach((b) => b.classList.toggle('on', b.dataset.page === page));
  placePill(true);
  $$('.page').forEach((el) => {
    const show = el.dataset.page === page;
    el.hidden = !show;
    el.classList.remove('in-next', 'in-prev');
    if (show) { void el.offsetWidth; el.classList.add(dir); }
  });
  $('.main').scrollTop = 0;
  if (hostStatus) renderHost(hostStatus, true);
}
requestAnimationFrame(() => placePill(false));
new ResizeObserver(() => placePill(false)).observe($('.nav'));
$$('.nav button').forEach((b) => b.addEventListener('click', () => go(b.dataset.page)));

// ── 세션 목록 ──────────────────────────────────────────────────────
let homeKey = '';
function thumbOf(id) { return LS.get('thumb.' + id, ''); }

function renderHome() {
  const list = pcs.slice().sort((a, b) => (b.last || 0) - (a.last || 0));
  const key = list.map((p) => p.id + p.name + isOnline(p.id) + (p.os || '') + (p.ip || '') + thumbOf(p.id).length).join();
  $('#empty').hidden = list.length > 0;
  const on = list.filter((p) => isOnline(p.id)).length;
  $('#count').textContent = list.length ? `${list.length}개${on ? ` · ${on}개 온라인` : ''}` : '';
  if (key === homeKey) return;
  const first = !homeKey;
  homeKey = key;
  $('#pcs').innerHTML = list.map((p, i) => {
    const th = thumbOf(p.id);
    const online = isOnline(p.id);
    const sub = [p.os || 'Windows', fmtId(p.id)].join(' · ');
    return `
    <div class="card ${online ? 'on' : ''}" data-id="${p.id}" role="button" tabindex="0" style="${first ? `animation-delay:${i * 0.05}s` : 'animation:none'}">
      <div class="thumb">
        ${th ? `<img src="${th}" alt="">` : ic('display')}
        <span class="go">${online ? '연결' : '오프라인'}</span>
      </div>
      <div class="meta">
        <div class="meta-t">
          <div class="name"><i class="dot ${online ? 'on' : ''}"></i><span>${esc(p.name || 'PC')}</span></div>
          <div class="sub">${esc(sub)}</div>
        </div>
        <button class="more" aria-label="더 보기">${ic('more')}</button>
      </div>
    </div>`;
  }).join('');
  $$('#pcs .card').forEach((el) => {
    const open = (e) => {
      const pc = findPc(el.dataset.id);
      if (e.target.closest('.more')) { e.stopPropagation(); pcMenu(pc); } else connect(pc);
    };
    el.addEventListener('click', open);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(e); });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); pcMenu(findPc(el.dataset.id)); });
  });
}

async function pcMenu(pc) {
  const on = isOnline(pc.id);
  const actions = [{ label: on ? '연결' : '연결 시도', icon: 'display', value: 'connect' }];
  if (!on) actions.push({ label: '켜기', icon: 'sun', value: 'wake' });
  actions.push({ label: '이름 바꾸기', icon: 'pen', value: 'rename' });
  actions.push({ label: '삭제', icon: 'trash', value: 'remove', kind: 'danger' });
  const a = await ask({ title: pc.name || 'PC', body: fmtId(pc.id), actions });
  if (a === 'connect') connect(pc);
  if (a === 'wake') {
    const ok = await ask({ title: '장치의 전원을 원격으로 켜시겠습니까?', body: `${pc.name || fmtId(pc.id)}을(를) 켜는 신호를 보내요.`, actions: [{ label: '예, 켭니다', icon: 'sun', value: true, kind: 'primary' }, { label: '아니요', value: false }] });
    if (ok) wake(pc);
  }
  if (a === 'rename') {
    const name = await ask({ title: '이름 바꾸기', input: { value: pc.name }, actions: [{ label: '저장', value: true, kind: 'primary' }] });
    if (name && name.trim()) { pc.name = name.trim(); pc.custom = true; savePcs(); homeKey = ''; renderHome(); }
  }
  if (a === 'remove') {
    const ok = await ask({ title: '이 세션을 삭제할까요?', body: '다시 추가하려면 번호와 비밀번호가 필요해요.', actions: [{ label: '삭제', icon: 'trash', value: true, kind: 'danger' }, { label: '취소', value: false }] });
    if (ok) {
      pcs = pcs.filter((p) => p !== pc);
      savePcs();
      try { localStorage.removeItem('beam.thumb.' + pc.id); } catch { /* 무시 */ }
      relay.unsubscribe(P.topicState(pc.id));
      homeKey = '';
      renderHome();
    }
  }
}

// 꺼진 PC 는 스스로 신호를 받을 수 없으므로, 같은 집에서 켜져 있는 다른 PC 가 매직 패킷을 대신 보냅니다.
async function wake(pc) {
  if (!pc.mac) { toast('한 번 연결한 뒤부터 켤 수 있어요'); return; }
  const helpers = pcs.filter((h) => h !== pc && h.dev && isOnline(h.id));
  if (!helpers.length) {
    await ask({
      title: '깨워 줄 PC가 없어요',
      body: '같은 공유기에 연결된 다른 PC에서 Beam이 켜져 있어야 이 PC를 켤 수 있어요. 공유기의 원격 WOL 기능으로도 켤 수 있어요.',
      actions: [{ label: '확인', value: true, kind: 'primary' }],
    });
    return;
  }
  for (const h of helpers) {
    const sid = P.randomHex(12);
    const ts = Date.now();
    const topic = P.topicOut(h.id, sid);
    relay.subscribe(topic);
    const off = relay.on((t, m) => {
      if (t !== topic || m.m !== 'woke') return;
      off(); relay.unsubscribe(topic);
      toast(m.ok ? `${m.by}에서 켜는 신호를 보냈어요` : '켜는 신호를 보내지 못했어요');
    });
    setTimeout(() => { off(); relay.unsubscribe(topic); }, 15000);
    const tag = await P.hmac(h.key, `wake|${pc.mac}|${pc.bc || ''}|${ts}`);
    setTimeout(() => relay.send(P.topicIn(h.id), { m: 'wake', sid, dev: h.dev, ts, mac: pc.mac, bc: pc.bc || '', tag }), 300);
  }
  toast('켜는 중…');
}

// ── 세션 추가 ──────────────────────────────────────────────────────
const fId = $('#fId'), fPw = $('#fPw'), fName = $('#fName');
const digitsOf = (v) => v.replace(/\D/g, '');

function openAdd(id = '', err = '') {
  fId.value = id ? fmtId(id) : '';
  fPw.value = '';
  fName.value = findPc(id)?.custom ? findPc(id).name : '';
  $('#addErr').textContent = err;
  $('#add').hidden = false;
  syncAdd();
  setTimeout(() => (id ? fPw : fId).focus(), 60);
}
function closeAdd() { $('#add').hidden = true; }

function syncAdd() {
  const id = digitsOf(fId.value);
  const known = findPc(id);
  $('#pwFld').hidden = !!known?.dev;
  $('#addOk').disabled = id.length !== 9 || (!known?.dev && digitsOf(fPw.value).length !== 6);
}

// 칠 때마다 000 000 000 형태로 맞춥니다.
fId.addEventListener('input', () => {
  const d = digitsOf(fId.value).slice(0, 9);
  fId.value = d.replace(/(\d{3})(?=\d)/g, '$1 ');
  $('#addErr').textContent = '';
  syncAdd();
  if (d.length === 9 && !findPc(d)?.dev) fPw.focus();
});
fPw.addEventListener('input', () => {
  fPw.value = digitsOf(fPw.value).slice(0, 6);
  $('#addErr').textContent = '';
  syncAdd();
});
$('#addForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const id = digitsOf(fId.value);
  if (id.length !== 9) return;
  if (host && id === hostStatus?.id) { $('#addErr').textContent = '이 PC의 번호예요'; return; }
  const known = findPc(id);
  const name = fName.value.trim();
  if (known?.dev) {
    if (name) { known.name = name; known.custom = true; savePcs(); }
    closeAdd();
    return connect(known);
  }
  const pw = digitsOf(fPw.value);
  if (pw.length !== 6) return;
  const pc = known || { id, name: name || fmtId(id) };
  if (name) { pc.name = name; pc.custom = true; }
  closeAdd();
  connect(pc, pw);
});
$$('#add [data-close]').forEach((b) => b.addEventListener('click', closeAdd));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#add').hidden) closeAdd(); });
$('#addBtn').addEventListener('click', () => openAdd());

// ── 연결 ───────────────────────────────────────────────────────────
let session = null;
let current = null;    // 지금 연결한 PC
let retry = 0;
let inRemote = false;
let hostState = {};
let encFps = 0;

const ERR = {
  badpw: '비밀번호가 틀렸어요',
  unknown: '이 기기의 등록이 해제되었어요. 비밀번호를 다시 입력해 주세요',
  locked: '비밀번호를 여러 번 틀려서 10분 동안 잠겼어요',
  noreply: 'PC가 꺼져 있거나 Beam이 실행 중이 아니에요',
  nat: 'PC와 직접 연결하지 못했어요. 네트워크를 바꿔 다시 시도해 주세요',
  offline: '인터넷 연결을 확인해 주세요',
  busy: 'PC에 연결된 기기가 너무 많아요',
  bad: '연결 정보가 올바르지 않아요',
  paused: 'PC에서 원격 접속을 꺼 두었어요',
  denied: 'PC에서 연결을 거부했어요',
};

function connect(pc, password = null) {
  unlockAudio();
  errorShown = false;
  logLine(`연결 시도: ${pc.name || pc.id}${password ? ' (비밀번호)' : ' (등록 기기)'}`);
  badTimes = 0; badCount = 0; lastDecoded = -1;
  if (session) session.close();
  current = pc;
  if (host && pc.id === hostStatus?.id) { toast('이 PC에는 연결할 수 없어요'); return; }
  if (!inRemote) {
    $('#dial').hidden = false;
    $('#dialName').textContent = pc.name || fmtId(pc.id);
    $('#dialStep').textContent = '';
    const th = thumbOf(pc.id);
    $('#dialThumb').innerHTML = th ? `<img src="${th}" alt="">` : ic('display');
  }
  const s = session = new Session(relay, pc, { password, deviceName: deviceName() });
  s.addEventListener('step', (e) => {
    $('#dialStep').textContent = e.detail;
  });
  s.addEventListener('track', (e) => attachVideo(e.detail));
  s.addEventListener('hello', (e) => onHello(pc, e.detail));
  s.addEventListener('state', (e) => onState(e.detail));
  s.addEventListener('tick', (e) => { encFps = e.detail.encFps; hostState.enc = e.detail.enc; hostState.src = e.detail.src; setLocked(e.detail.locked); });
  s.addEventListener('cur', (e) => view?.follow(e.detail.x, e.detail.y));
  s.addEventListener('stats', (e) => onStats(e.detail));
  s.addEventListener('step', (e) => logLine(e.detail));
  s.addEventListener('connected', () => logLine(`연결됨 (${pc.name || pc.id})`));
  s.addEventListener('error', (e) => showError('PC에서 오류가 발생해 연결을 끊었어요', e.detail.msg, e.detail.log));
  s.addEventListener('powerack', (e) => {
    const n = { sleep: '절전', hibernate: '최대 절전', restart: '다시 시작', shutdown: '전원 끄기', logoff: '로그아웃' }[e.detail.a] || e.detail.a;
    toast(`${e.detail.delay}초 뒤 ${n}해요. PC 앞에서 취소할 수 있어요`, 3500);
  });
  s.addEventListener('bye', (e) => {
    if (e.detail.reason === 'idle') { toast('60분 동안 조작이 없어 연결을 끊었어요', 3500); hangup(); }
  });
  s.addEventListener('local', (e) => {
    if (e.detail.v) banner('PC 앞에서 사용 중이라 잠시 조작할 수 없어요');
    else if (bannerText.startsWith('PC 앞에서')) banner('');
  });
  s.addEventListener('clip', (e) => gotClip(e.detail.s));
  s.addEventListener('fdone', (e) => { if (e.detail.id === sending?.id) sending.done(e.detail.name); });
  s.addEventListener('connected', () => {
    retry = 0;
    setTimeout(() => session === s && s.send({ t: 'mute', v: !soundOn }), 500);
    $('#dial').hidden = true;
    banner('');
    enterRemote();
  });
  s.addEventListener('end', (e) => onEnd(pc, password, e.detail));
  s.start();
}

function onHello(pc, h) {
  if (h.paired) { pc.dev = h.paired.dev; pc.key = h.paired.key; }
  if (h.name && !pc.custom) pc.name = h.name;
  if (h.mac) pc.mac = h.mac;
  if (h.os) pc.os = h.os;
  pc.last = Date.now();
  if (!findPc(pc.id)) pcs.push(pc);
  savePcs();
  LS.set('last', pc.id);
  relay.subscribe(P.topicState(pc.id));
  $('#mName').textContent = pc.name;
  homeKey = '';
}

function onEnd(pc, password, { code, detail }) {
  if (session && session.closed) session = null;
  logLine(`연결 종료: ${code}${detail?.message ? ' ' + detail.message : ''}`);
  if (code === 'user' || errorShown) return;
  // 이미 화면을 보고 있었다면(통신 끊김) 기기 키로 조용히 다시 붙습니다.
  if (inRemote && pc.dev && ['lost', 'closed', 'nat', 'noreply', 'offline'].includes(code) && retry < 5) {
    retry++;
    banner('다시 연결하는 중');
    setTimeout(() => { if (inRemote && current === pc) connect(pc); }, Math.min(500 * retry, 4000));
    return;
  }
  $('#dial').hidden = true;
  exitRemote();
  if (code === 'unknown') { pc.dev = null; pc.key = null; savePcs(); openAdd(pc.id, ERR.unknown); return; }
  if (code === 'badpw') {
    openAdd(pc.id, ERR.badpw);
    const d = $('#add .dialog');
    d.classList.remove('shake'); void d.offsetWidth; d.classList.add('shake');
    return;
  }
  // 사용자가 고칠 수 있는 상황(비밀번호·거부·꺼짐 등)은 짧게 알리고, 나머지는 원인 로그를 보여 줍니다.
  if (['locked', 'paused', 'denied', 'busy', 'offline', 'noreply'].includes(code)) { toast(ERR[code], 3500); return; }
  showError(code === 'lost' || code === 'closed' ? '연결이 끊어졌어요' : '연결 중 오류가 발생했어요', ERR[code] || `오류 코드: ${code}`);
}

$('#dialCancel').addEventListener('click', () => {
  session?.close();
  session = null;
  $('#dial').hidden = true;
  exitRemote();
});

// ── 로그와 오류 모달 ─────────────────────────────────────────────────
const logBuf = [];
function logLine(msg) {
  const t = new Date().toLocaleTimeString('ko-KR', { hour12: false });
  logBuf.push(`[${t}] ${msg}`);
  if (logBuf.length > 200) logBuf.splice(0, logBuf.length - 200);
}
let errorShown = false;
function showError(title, msg, hostLog = '') {
  if (errorShown) return;
  errorShown = true;
  logLine(`오류: ${msg || title}`);
  // 오류가 나면 조작이 엉키지 않도록 즉시 연결을 끊습니다.
  const s = session;
  session = null;
  current = null;
  s?.close();
  $('#dial').hidden = true;
  exitRemote();
  $('#errTitle').textContent = title;
  $('#errMsg').textContent = msg || '';
  $('#errLog').textContent = (hostLog ? `── PC 로그 ──\n${hostLog}\n\n` : '') + `── 이 기기 로그 ──\n${logBuf.join('\n')}`;
  $('#err').hidden = false;
}
$('#errClose').addEventListener('click', () => { $('#err').hidden = true; errorShown = false; });
$('#errCopy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#errLog').textContent); toast('로그를 복사했어요'); } catch { toast('복사하지 못했어요'); }
});
// 앱 자체 오류도 연결 중이면 바로 끊고 보여 줍니다.
window.addEventListener('error', (e) => { if (session || inRemote) showError('앱에서 오류가 발생해 연결을 끊었어요', `${e.message} (${(e.filename || '').split('/').pop()}:${e.lineno})`); });
window.addEventListener('unhandledrejection', (e) => { if (session || inRemote) showError('앱에서 오류가 발생해 연결을 끊었어요', String(e.reason?.message || e.reason)); });

// ── 원격 화면 ──────────────────────────────────────────────────────
const video = $('#video');
let view = null;
let gestures = null;
let wakeLock = null;

function attachVideo(stream) {
  if (video.srcObject !== stream) video.srcObject = stream;
  video.play().catch(() => {});
  const a = stream.getAudioTracks()[0];
  if (a) attachAudio(a);
}

// ── 소리 ───────────────────────────────────────────────────────────
const audioEl = $('#audio');
let soundOn = LS.get('sound', true);
// iOS 는 사용자가 누른 순간에 한 번 재생해 둬야 나중에 소리가 납니다.
function unlockAudio() {
  try { audioEl.muted = true; audioEl.play().catch(() => {}); } catch { /* 무시 */ }
}
function attachAudio(track) {
  if (audioEl.srcObject?.getAudioTracks()[0] === track) return;
  audioEl.srcObject = new MediaStream([track]);
  applySound();
}
function applySound() {
  audioEl.muted = !soundOn;
  session?.send({ t: 'mute', v: !soundOn });
  if (soundOn && audioEl.srcObject) {
    audioEl.play().then(() => { if (bannerText === '눌러서 소리 켜기') banner(''); })
      .catch(() => banner('눌러서 소리 켜기'));
  }
  renderSound();
}
function renderSound() {
  $('#tSound .tsound-ic').innerHTML = ic(soundOn ? 'volume' : 'mute');
  $('#tSound .tsound-t').textContent = soundOn ? '소리 켜짐' : '소리 꺼짐';
  $('#tSound').classList.toggle('off', !soundOn);
}
// 자동 재생이 막혔을 때는 화면을 한 번 누르면 켜집니다.
$('#touch').addEventListener('pointerdown', () => {
  if (soundOn && audioEl.srcObject && audioEl.paused) audioEl.play().then(() => { if (bannerText === '눌러서 소리 켜기') banner(''); }).catch(() => {});
}, true);
$('#tSound').addEventListener('click', () => { soundOn = !soundOn; LS.set('sound', soundOn); applySound(); });
renderSound();

$('#tFull').addEventListener('click', () => {
  closeMenu();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen?.().catch(() => {});
});
const syncSize = () => view?.setSource(video.videoWidth, video.videoHeight);
video.addEventListener('loadedmetadata', syncSize);
video.addEventListener('resize', syncSize);

let modClick = null;
function gestureSend(m) {
  if (m.t === 'b' && m.d && mods.size && !modClick) {
    modClick = useMods();
    for (const c of modClick) key(c, true);
  }
  session?.send(m);
  if (m.t === 'b' && !m.d && modClick) {
    for (const c of modClick.reverse()) key(c, false);
    modClick = null;
  }
}

function enterRemote() {
  if (!view) {
    view = new View($('#stage'), $('#view'), video);
    gestures = new Gestures($('#touch'), view, gestureSend, { threeTap: toggleKb, activity: wakeHandle });
    gestures.mode = LS.get('mode', 'trackpad');
  }
  if (inRemote) return;
  inRemote = true;
  $('#remote').hidden = false;
  document.body.classList.add('remote-on');
  $('#mName').textContent = current?.name || '';
  syncSize();
  renderMode();
  wakeHandle();
  history.pushState({ remote: true }, '');
  const el = document.documentElement;
  if (!document.fullscreenElement && el.requestFullscreen && matchMedia('(pointer: coarse)').matches) {
    el.requestFullscreen({ navigationUI: 'hide' }).then(() => screen.orientation?.lock?.('landscape').catch(() => {})).catch(() => {});
  }
  navigator.wakeLock?.request('screen').then((l) => { wakeLock = l; }).catch(() => {});
  setTimeout(saveThumb, 3000);
}

function exitRemote() {
  if (!inRemote) return;
  saveThumb();
  inRemote = false;
  $('#remote').hidden = true;
  document.body.classList.remove('remote-on');
  $('#menu').hidden = true;
  hideKb();
  video.srcObject = null;
  audioEl.srcObject = null;
  setLocked(false);
  banner('');
  wakeLock?.release().catch(() => {});
  wakeLock = null;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  try { screen.orientation?.unlock?.(); } catch { /* 무시 */ }
  renderHome();
}

// 화면이 초록 단색이거나 디코딩이 안 되면 PC 에 알려 캡처·인코딩 방식을 바꾸게 합니다.
const probe = document.createElement('canvas');
probe.width = 32; probe.height = 18;
let badCount = 0, lastBad = 0, badTimes = 0, lastDecoded = -1;
function looksBroken() {
  if (!video.videoWidth) return false;
  try {
    const x = probe.getContext('2d', { willReadFrequently: true });
    x.drawImage(video, 0, 0, 32, 18);
    const d = x.getImageData(0, 0, 32, 18).data;
    let r = 0, g = 0, b = 0, n = d.length / 4, vr = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
    r /= n; g /= n; b /= n;
    for (let i = 0; i < d.length; i += 4) vr += Math.abs(d[i + 1] - g);
    // 디코더가 빈 데이터를 받으면 YUV(0,0,0) → 진한 초록 단색이 됩니다.
    return g > 60 && r < 25 && b < 25 && vr / n < 6;
  } catch { return false; }
}
async function checkHealth() {
  if (!inRemote || !session?.rtc) return;
  let v = null;
  (await session.rtc.getStats()).forEach((x) => { if (x.type === 'inbound-rtp' && x.kind === 'video') v = x; });
  const stuck = v && v.bytesReceived > 200000 && v.framesDecoded === lastDecoded;
  if (v) lastDecoded = v.framesDecoded;
  if (looksBroken() || stuck) badCount++; else badCount = 0;
  if (badCount >= 3 && Date.now() - lastBad > 8000 && badTimes < 3) {
    badCount = 0; lastBad = Date.now(); badTimes++;
    session.send({ t: 'bad' });
    logLine('화면이 깨져 보여 PC에 캡처 방식 변경을 요청');
    banner('화면 방식을 바꾸는 중');
    setTimeout(() => { if (bannerText === '화면 방식을 바꾸는 중') banner(''); }, 4000);
  }
}

// 세션 카드에 쓸 마지막 화면을 작게 저장해 둡니다(이 기기 안에만).
function saveThumb() {
  if (!current || !video.videoWidth) return;
  try {
    const c = document.createElement('canvas');
    c.width = 480; c.height = Math.round(480 * video.videoHeight / video.videoWidth);
    c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
    LS.set('thumb.' + current.id, c.toDataURL('image/jpeg', 0.7));
  } catch { /* 저장 공간 부족 */ }
}
setInterval(() => { if (inRemote) saveThumb(); }, 20000);

function hangup() {
  saveThumb();
  const s = session;
  session = null;
  current = null;
  s?.close();
  exitRemote();
}

window.addEventListener('popstate', () => {
  if (!inRemote) return;
  // 뒤로 가기: 메뉴를 열고 화면은 유지합니다.
  history.pushState({ remote: true }, '');
  if (!$('#menu').hidden) closeMenu(); else openMenu();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && inRemote) {
    navigator.wakeLock?.request('screen').then((l) => { wakeLock = l; }).catch(() => {});
    session?.send({ t: 'key' });
  }
});

let bannerText = '';
function banner(text) {
  bannerText = text;
  const b = $('#banner');
  b.textContent = text;
  b.hidden = !text;
}
let lockedShown = false;
function setLocked(v) {
  if (v === lockedShown) return;
  lockedShown = v;
  if (v) banner('PC가 잠겨 있어요');
  else if (bannerText === 'PC가 잠겨 있어요') banner('');
}

let idleT;
function wakeHandle() {
  $('#handle').classList.remove('idle');
  clearTimeout(idleT);
  idleT = setTimeout(() => $('#handle').classList.add('idle'), 2500);
}

// ── 메뉴 ───────────────────────────────────────────────────────────
function openMenu() { $('#menu').hidden = false; renderMenu(); }
function closeMenu() { $('#menu').hidden = true; }
$('#handle').addEventListener('click', openMenu);
$$('[data-closemenu]').forEach((b) => b.addEventListener('click', closeMenu));

function onState(st) {
  hostState = st;
  encFps = st.encFps ?? encFps;
  setLocked(!!st.locked);
  renderMenu();
}

function seg(sel, val) {
  const box = $(sel);
  let on = null;
  $$(`${sel} button`).forEach((b) => { const v = b.dataset.v === String(val); b.classList.toggle('on', v); if (v) on = b; });
  let pill = box.querySelector('.pill');
  if (!pill) { pill = document.createElement('span'); pill.className = 'pill'; box.prepend(pill); }
  pill.style.opacity = on ? 1 : 0;
  if (on) requestAnimationFrame(() => { pill.style.left = on.offsetLeft + 'px'; pill.style.width = on.offsetWidth + 'px'; });
}

function renderMenu() {
  const st = hostState;
  $('#tBlack').classList.toggle('on', !!st.blackout);
  seg('#segLevel', st.level || 'auto');
  seg('#segFps', st.fps || 120);
  const screens = st.screens || [];
  $('#screenField').hidden = screens.length < 2;
  if (screens.length > 1) {
    $('#segScreen').innerHTML = screens.map((s) => `<button data-v="${s.i}">${s.i + 1}${s.primary ? ' · 주' : ''}</button>`).join('');
    seg('#segScreen', st.screen);
  }
  $('#tKb').classList.toggle('on', kbOpen);
}

function renderMode() {
  const touch = gestures?.mode === 'touch';
  $('#tMode .tmode-ic').innerHTML = Icons.svg(touch ? 'hand' : 'pointer');
  $('#tMode .tmode-t').textContent = touch ? '터치 모드' : '트랙패드';
}

function onStats(s) {
  checkHealth();
  const parts = [];
  if (s.w) parts.push(`${s.w}×${s.h}`);
  parts.push(`${s.fps}fps`);
  if (s.rtt) parts.push(`${s.rtt}ms`);
  parts.push(`${s.mbps.toFixed(1)}Mbps`);
  if (s.route) parts.push(s.route);
  if (hostState.enc) parts.push(`${hostState.enc.replace('h264_', '').replace('lib', '').toUpperCase()}/${(hostState.src || 'dda').toUpperCase()}`);
  $('#mStats').textContent = parts.join(' · ');
}

$('#tKb').addEventListener('click', () => { closeMenu(); setTimeout(showKb, 50); });
$('#tMode').addEventListener('click', () => {
  gestures.mode = gestures.mode === 'touch' ? 'trackpad' : 'touch';
  LS.set('mode', gestures.mode);
  renderMode();
  toast(gestures.mode === 'touch' ? '누른 곳을 바로 클릭해요' : '손가락으로 커서를 움직여요', 1600);
});
$('#tBlack').addEventListener('click', () => {
  const v = !hostState.blackout;
  session?.send({ t: 'set', blackout: v });
  hostState.blackout = v;
  renderMenu();
  toast(v ? 'PC 모니터를 검게 가렸어요' : 'PC 모니터에 화면이 다시 보여요', 1800);
});
$('#tFit').addEventListener('click', () => { view?.reset(); closeMenu(); });
$('#segLevel').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  session?.send({ t: 'set', level: b.dataset.v }); hostState.level = b.dataset.v; renderMenu();
});
$('#segFps').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  session?.send({ t: 'set', fps: +b.dataset.v }); hostState.fps = +b.dataset.v; renderMenu();
});
$('#segScreen').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  session?.send({ t: 'set', screen: +b.dataset.v }); hostState.screen = +b.dataset.v; renderMenu();
});
$$('[data-combo]').forEach((b) => b.addEventListener('click', () => {
  session?.send({ t: 'combo', c: b.dataset.combo.split(',') });
  closeMenu();
}));

const POWER = {
  lock: { title: 'PC를 잠글까요?', label: '잠금', confirm: '장치를 원격으로 잠그시겠습니까?', yes: '예, 잠급니다', detail: '잠기면 PC 앞에서 로그인해야 다시 쓸 수 있어요.' },
  sleep: { title: 'PC를 절전 모드로 바꿀까요?', label: '절전', body: '켜려면 같은 집의 다른 PC나 공유기 WOL이 필요해요.', confirm: '장치를 원격으로 절전 모드로 전환하시겠습니까?', yes: '예, 절전합니다', detail: '10초 뒤 실행되고, PC 앞에서 Ctrl+Alt+Shift+X로 취소할 수 있어요.' },
  restart: { title: 'PC를 다시 시작할까요?', label: '다시 시작', body: '저장하지 않은 작업은 사라져요.', confirm: '장치를 원격으로 다시 시작하시겠습니까?', yes: '예, 다시 시작합니다', detail: '15초 뒤 실행되고, PC 앞에서 Ctrl+Alt+Shift+X로 취소할 수 있어요.' },
  shutdown: { title: 'PC를 끌까요?', label: '끄기', body: '저장하지 않은 작업은 사라져요.', confirm: '장치의 전원을 원격으로 종료하시겠습니까?', yes: '예, 전원을 끕니다', detail: '15초 뒤 꺼지고, PC 앞에서 Ctrl+Alt+Shift+X로 취소할 수 있어요. 다시 켜려면 같은 집의 다른 PC나 공유기 WOL이 필요해요.' },
};
$$('[data-power]').forEach((b) => b.addEventListener('click', async () => {
  const a = b.dataset.power;
  const p = POWER[a];
  const ok = await ask({ title: p.title, body: p.body || '', actions: [{ label: p.label, value: true, kind: a === 'lock' ? 'primary' : 'danger' }, { label: '취소', value: false }] });
  if (!ok) return;
  // 한 번 더 확인합니다. 잘못 눌러 PC 가 꺼지면 원격으로 다시 켜기 어렵습니다.
  const again = await ask({ title: p.confirm, body: p.detail, actions: [{ label: p.yes, value: true, kind: 'danger' }, { label: '아니요', value: false }] });
  if (!again) return;
  logLine(`전원 명령 보냄: ${a}`);
  session?.send({ t: 'power', a });
  if (a === 'lock') closeMenu();
}));
$('#hangup').addEventListener('click', hangup);

// ── 클립보드 · 파일 ──────────────────────────────────────────────────
$('#clipPush').addEventListener('click', async () => {
  closeMenu();
  let text = null;
  try { text = await navigator.clipboard.readText(); } catch { /* 권한 없음 → 직접 붙여넣기 */ }
  if (!text) text = await ask({ title: 'PC로 보낼 글', input: { value: '' }, actions: [{ label: '보내기', value: true, kind: 'primary' }] });
  if (!text) return;
  session?.send({ t: 'clip', s: text, paste: true });
  toast('PC에 붙여넣었어요');
});
$('#clipPull').addEventListener('click', () => { closeMenu(); session?.send({ t: 'clipget' }); });
async function gotClip(text) {
  if (!text) { toast('PC 클립보드가 비어 있어요'); return; }
  try { await navigator.clipboard.writeText(text); toast('PC 클립보드를 복사했어요'); return; } catch { /* 사용자 동작이 필요 */ }
  const ok = await ask({ title: 'PC 클립보드', body: text.length > 300 ? text.slice(0, 300) + '…' : text, actions: [{ label: '복사', icon: 'copy', value: true, kind: 'primary' }, { label: '닫기', value: false }] });
  if (ok) { try { await navigator.clipboard.writeText(text); toast('복사했어요'); } catch { toast('복사하지 못했어요'); } }
}

let sending = null;
const fileInput = document.createElement('input');
fileInput.type = 'file';
fileInput.multiple = true;
$('#fileSend').addEventListener('click', () => { closeMenu(); fileInput.click(); });
fileInput.addEventListener('change', async () => {
  const files = [...fileInput.files];
  fileInput.value = '';
  for (const f of files) { if (!(await sendFile(f))) break; }
});
// 데이터 채널로 48KB 씩 보냅니다. 버퍼가 쌓이면 기다려서 화면 조작이 밀리지 않게 합니다.
async function sendFile(file) {
  const s = session;
  if (!s?.dc || s.dc.readyState !== 'open') return false;
  const id = P.randomHex(6);
  const CH = 48 * 1024;
  const finished = new Promise((res) => { sending = { id, done: res }; });
  s.send({ t: 'fstart', id, name: file.name, size: file.size });
  for (let o = 0; o < file.size; o += CH) {
    if (session !== s || s.closed) { banner(''); return false; }
    while (s.dc.bufferedAmount > 1024 * 1024) await new Promise((r) => setTimeout(r, 15));
    const buf = new Uint8Array(await file.slice(o, o + CH).arrayBuffer());
    let bin = '';
    for (let k = 0; k < buf.length; k += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(k, k + 0x8000));
    s.send({ t: 'fchunk', id, d: btoa(bin) });
    banner(`${file.name} · ${Math.min(100, Math.round(((o + CH) / file.size) * 100))}%`);
  }
  s.send({ t: 'fend', id });
  const name = await Promise.race([finished, new Promise((r) => setTimeout(() => r(null), 30000))]);
  banner('');
  toast(name ? `PC 다운로드\\Beam 에 ${name} 저장했어요` : '파일 전송을 확인하지 못했어요', 3000);
  return !!name;
}

// ── 키보드 ─────────────────────────────────────────────────────────
const kb = $('#kb');
const SENT = '​​'; // 비어 있을 때도 지우기 키를 받기 위한 보이지 않는 글자
let kbOpen = false;
let comp = '';
const mods = new Set();

function showKb() {
  kbOpen = true;
  kb.value = SENT;
  kb.focus();
  kb.setSelectionRange(SENT.length, SENT.length);
  $('#keysbar').hidden = false;
  placeBars();
}
function hideKb() {
  kbOpen = false;
  kb.blur();
  $('#keysbar').hidden = true;
  $('#fkeys').hidden = true;
  mods.clear();
  lockedMods.clear();
  renderMods();
}
function toggleKb() { if (kbOpen) hideKb(); else showKb(); }

function placeBars() {
  const vv = window.visualViewport;
  const off = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
  $('#keysbar').style.bottom = off + 'px';
  $('#fkeys').style.bottom = (off + 54) + 'px';
}
window.visualViewport?.addEventListener('resize', placeBars);
window.visualViewport?.addEventListener('scroll', placeBars);

function key(code, down) { session?.send({ t: 'k', c: code, d: down ? 1 : 0 }); }
function tap(code) { key(code, true); key(code, false); }

function charCode(ch) {
  if (/^[a-z]$/i.test(ch)) return 'Key' + ch.toUpperCase();
  if (/^\d$/.test(ch)) return 'Digit' + ch;
  return { ' ': 'Space', '-': 'Minus', '=': 'Equal', '[': 'BracketLeft', ']': 'BracketRight', ';': 'Semicolon', "'": 'Quote', ',': 'Comma', '.': 'Period', '/': 'Slash', '\\': 'Backslash', '`': 'Backquote' }[ch];
}

function typeText(text) {
  if (!text) return;
  if (mods.size) {
    // Ctrl/Alt/Win 이 켜져 있으면 단축키로 보냅니다.
    for (const ch of text) {
      const c = charCode(ch.toLowerCase());
      if (c) session?.send({ t: 'combo', c: [...mods, c] });
    }
    useMods();
    return;
  }
  session?.send({ t: 'txt', s: text });
}

function backspaces(n) { for (let i = 0; i < n; i++) tap('Backspace'); }

function resetKb() {
  if (comp) return;
  if (kb.value !== SENT) { kb.value = SENT; kb.setSelectionRange(SENT.length, SENT.length); }
}

kb.addEventListener('beforeinput', (e) => {
  if (e.isComposing || comp) return;
  if (e.inputType === 'deleteContentBackward') { e.preventDefault(); tap('Backspace'); resetKb(); }
  else if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') { e.preventDefault(); tap('Enter'); resetKb(); }
});
kb.addEventListener('input', (e) => {
  if (e.isComposing || comp) return;
  if (e.inputType === 'insertText' && e.data) typeText(e.data);
  else if (e.inputType === 'deleteContentBackward') tap('Backspace');
  else if (e.inputType === 'insertLineBreak') tap('Enter');
  resetKb();
});
// 한글처럼 조합되는 입력: 조합 중인 글자를 지웠다 다시 써서 PC 에도 실시간으로 보입니다.
function compTo(next) {
  let p = 0;
  while (p < comp.length && p < next.length && comp[p] === next[p]) p++;
  backspaces([...comp.slice(p)].length);
  const add = next.slice(p);
  if (add) session?.send({ t: 'txt', s: add });
  comp = next;
}
kb.addEventListener('compositionstart', () => { comp = ''; });
kb.addEventListener('compositionupdate', (e) => { if (!mods.size) compTo(e.data || ''); });
kb.addEventListener('compositionend', (e) => {
  if (mods.size) { typeText(e.data || ''); comp = ''; }
  else { compTo(e.data || ''); comp = ''; }
  setTimeout(resetKb, 0);
});
// 하드웨어(블루투스·USB) 키보드: 실제 키 누름/뗌을 그대로 보내 PC 의 한글 입력기·단축키·길게 누르기가 그대로 동작합니다.
// 가상 키보드는 keyCode 229 나 빈 code 로 오므로 아래 입력 이벤트 경로로 처리됩니다.
const hwHeld = new Set();
const isHardwareKey = (e) => !e.isComposing && e.keyCode !== 229 && !!e.code && e.code !== 'Unidentified' && e.key !== 'Unidentified';
function hwDown(e) {
  if (!isHardwareKey(e)) return false;
  e.preventDefault();
  if (mods.size && !e.repeat && !/^(Control|Alt|Shift|Meta)/.test(e.code)) {
    session?.send({ t: 'combo', c: [...useMods(), e.code] });
    return true;
  }
  hwHeld.add(e.code);
  key(e.code, true);
  return true;
}
function hwUp(e) {
  if (!hwHeld.has(e.code)) return false;
  e.preventDefault();
  hwHeld.delete(e.code);
  key(e.code, false);
  return true;
}
kb.addEventListener('keydown', hwDown);
kb.addEventListener('keyup', hwUp);
kb.addEventListener('blur', () => { if (kbOpen) setTimeout(() => { if (kbOpen && document.activeElement !== kb) hideKb(); }, 150); });

const lockedMods = new Set();
const modTapAt = {};
function renderMods() {
  $$('#keysbar [data-mod]').forEach((b) => {
    b.classList.toggle('on', mods.has(b.dataset.mod));
    b.classList.toggle('lock', lockedMods.has(b.dataset.mod));
  });
}
// 지금 켜진 보조키를 돌려주고, 잠그지 않은 것은 끕니다.
function useMods() {
  const list = [...mods];
  for (const m of list) if (!lockedMods.has(m)) mods.delete(m);
  renderMods();
  return list;
}
function tapMod(m) {
  const now = Date.now();
  if (lockedMods.has(m)) { lockedMods.delete(m); mods.delete(m); }
  else if (mods.has(m) && now - (modTapAt[m] || 0) < 400) lockedMods.add(m);
  else if (mods.has(m)) mods.delete(m);
  else mods.add(m);
  modTapAt[m] = now;
  renderMods();
}
// 막대의 버튼을 눌러도 키보드가 닫히지 않게 포커스를 뺏지 않습니다.
$('#keysbar').addEventListener('pointerdown', (e) => e.preventDefault());
$('#fkeys').addEventListener('pointerdown', (e) => e.preventDefault());
$('#keysbar').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.mod) { tapMod(b.dataset.mod); return; }
  if (b.hasAttribute('data-hidekb')) return hideKb();
  if (b.hasAttribute('data-fkeys')) { $('#fkeys').hidden = !$('#fkeys').hidden; placeBars(); return; }
  if (b.dataset.key) {
    if (mods.size) { session?.send({ t: 'combo', c: [...useMods(), b.dataset.key] }); }
    else tap(b.dataset.key);
  }
});
$('#fkeys').innerHTML = Array.from({ length: 12 }, (_, i) => `<button data-key="F${i + 1}">F${i + 1}</button>`).join('');
$('#fkeys').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (mods.size) { session?.send({ t: 'combo', c: [...useMods(), b.dataset.key] }); }
  else tap(b.dataset.key);
});

// ── 시작 ───────────────────────────────────────────────────────────
watchPresence();
renderHome();

const hashId = (location.hash.match(/(\d{9})/) || [])[1];
if (hashId) {
  history.replaceState(null, '', location.pathname + location.search);
  const known = findPc(hashId);
  if (known?.dev) connect(known); else openAdd(hashId);
}

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// 디버그/자동 점검용
window.__beam = { relay, get session() { return session; }, pcs: () => pcs, connect, openAdd };

// ── PC 키보드로 조작(PC·태블릿 브라우저, PC 앱) ──────────────────────
const held = new Set();
function remoteKeysActive() {
  return inRemote && $('#menu').hidden && $('#ask').hidden && document.activeElement !== kb;
}
window.addEventListener('keydown', (e) => {
  if (!remoteKeysActive()) return;
  if (hwDown(e)) held.add(e.code);
});
window.addEventListener('keyup', (e) => {
  if (document.activeElement === kb) return;
  if (hwUp(e)) held.delete(e.code);
});
window.addEventListener('blur', () => {
  for (const c of new Set([...held, ...hwHeld])) session?.send({ t: 'k', c, d: 0 });
  held.clear();
  hwHeld.clear();
});

// ── 이 PC (PC 앱에서만) ─────────────────────────────────────────────
let liveKey = null;
let devKey = null;
let lastPw = '';
let qrFor = '';

const ago = (t) => {
  if (!t) return '';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return '방금 전';
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
};
const dur = (t) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h) return `${h}시간 ${m}분`;
  return m ? `${m}분 ${s % 60}초` : `${s}초`;
};
const routeName = (r) => (r.includes('relay') ? '중계' : r.startsWith('host/host') ? '같은 네트워크' : r ? '직접 연결' : '연결 중');

function renderHost(s, force) {
  if (!s) return;
  if (force) { liveKey = null; devKey = null; }
  $('#hId').textContent = fmtId(s.id);
  $('#hPw').textContent = s.password.replace(/(\d{3})(\d{3})/, '$1 $2');
  if (lastPw && lastPw !== s.password) { const el = $('#hPw'); el.classList.remove('flip'); void el.offsetWidth; el.classList.add('flip'); }
  lastPw = s.password;
  $('#hostName').textContent = s.name;
  if (s.qr && qrFor !== s.url) { $('#qr').innerHTML = s.qr; qrFor = s.url; }
  $('#url').textContent = s.url ? s.url.split('#')[0].replace(/^https:\/\//, '') : '';
  $('#blackSw').classList.toggle('on', !!s.blackout);
  $('#allowSw').classList.toggle('on', !!s.settings.allowRemote);
  $('#removeAll').hidden = !s.devices.length;

  const n = s.viewers.length;
  $('#liveBadge').hidden = !n;
  $('#liveBadge').textContent = n;
  const lk = s.viewers.map((v) => v.sid).join();
  if (lk !== liveKey) {
    liveKey = lk;
    $('#live').innerHTML = s.viewers.map((v, i) => `
      <div class="row live" data-sid="${v.sid}" style="animation-delay:${i * 0.04}s">
        ${ic('mobile')}
        <div class="row-t"><div class="row-n">${esc(v.name)}</div><div class="row-s" data-f="sub"></div></div>
        <button class="tbtn red">끊기</button>
      </div>`).join('');
    $$('#live .row').forEach((el) => el.querySelector('button').addEventListener('click', () => host.disconnect(el.dataset.sid)));
  }
  for (const el of $$('#live .row')) {
    const v = s.viewers.find((x) => x.sid === el.dataset.sid);
    if (!v) continue;
    const bits = [routeName(v.route)];
    if (v.st) bits.push(`${v.st.fps}fps`, `${v.st.mbps.toFixed(1)}Mbps`);
    if (v.rtt > 0) bits.push(`${v.rtt}ms`);
    bits.push(dur(v.since));
    el.querySelector('[data-f="sub"]').textContent = bits.join(' · ');
  }

  const live = new Set(s.viewers.map((v) => v.name));
  const dk = s.devices.map((d) => d.dev + d.last + d.name + live.has(d.name)).join();
  if (dk !== devKey) {
    devKey = dk;
    $('#devices').innerHTML = s.devices.slice().sort((a, b) => (b.last || 0) - (a.last || 0)).map((d, i) => `
      <div class="row" data-dev="${d.dev}" style="animation-delay:${i * 0.04}s">
        ${ic('mobile')}
        <div class="row-t"><div class="row-n">${esc(d.name)}</div><div class="row-s">${live.has(d.name) ? '연결 중' : `마지막 연결 ${ago(d.last)}`}</div></div>
        <button class="tbtn red">등록 해제</button>
      </div>`).join('');
    $$('#devices .row').forEach((el) => el.querySelector('button').addEventListener('click', async () => {
      const ok = await ask({ title: '이 기기의 등록을 해제할까요?', body: '다시 연결하려면 비밀번호가 필요해요.', actions: [{ label: '등록 해제', icon: 'trash', value: true, kind: 'danger' }, { label: '취소', value: false }] });
      if (ok) host.removeDevice(el.dataset.dev);
    }));
  }

  const facts = [['인코더', s.encoder ? s.encoder.replace('h264_', '').toUpperCase() + (n ? ` · ${s.encFps}fps` : '') : '대기 중']];
  facts.push(['공유기 포트', s.upnp?.ok ? '열림' : s.settings.upnp ? '닫힘' : '사용 안 함']);
  if (s.lockedUntil > Date.now()) facts.push(['비밀번호 입력', `${Math.ceil((s.lockedUntil - Date.now()) / 60000)}분 잠김`]);
  const fk = JSON.stringify(facts);
  if ($('#facts').dataset.k !== fk) {
    $('#facts').dataset.k = fk;
    $('#facts').innerHTML = facts.map(([k, v]) => `<div class="fact"><div class="k">${k}</div><div class="v">${esc(v)}</div></div>`).join('');
  }

  // 설정
  $$('[data-set]').forEach((row) => row.querySelector('.sw').classList.toggle('on', !!s.settings[row.dataset.set]));
  seg('#hLevel', s.settings.level);
  seg('#hFps', s.settings.fps);
  if (document.activeElement !== $('#name')) $('#name').value = s.name;
}

if (host) {
  $$('[data-win]').forEach((b) => b.addEventListener('click', () => host.win(b.dataset.win)));
  $('.drag').addEventListener('dblclick', () => host.win('max'));
  $('#copyId').addEventListener('click', () => { host.copy(hostStatus.id); toast('번호를 복사했어요'); });
  $('#copyPw').addEventListener('click', () => { host.copy(hostStatus.password); toast('비밀번호를 복사했어요'); });
  $('#newPw').addEventListener('click', async () => { await host.newPassword(); toast('새 비밀번호로 바꿨어요'); });
  $('#blackRow').addEventListener('click', (e) => { e.preventDefault(); host.blackout(!hostStatus.blackout); });
  $('#allowRow').addEventListener('click', (e) => { e.preventDefault(); host.setting('allowRemote', !hostStatus.settings.allowRemote); });
  $('#removeAll').addEventListener('click', async () => {
    const ok = await ask({ title: '등록된 기기를 모두 해제할까요?', body: '연결 중인 기기도 끊기고, 다시 연결하려면 모두 비밀번호가 필요해요.', actions: [{ label: '모두 해제', icon: 'trash', value: true, kind: 'danger' }, { label: '취소', value: false }] });
    if (ok) { await host.removeAllDevices(); await host.newPassword(); toast('모두 해제하고 비밀번호도 바꿨어요'); }
  });
  $('#url').addEventListener('click', () => { host.copy(hostStatus.url.split('#')[0]); toast('주소를 복사했어요'); });
  $$('[data-set]').forEach((row) => row.addEventListener('click', (e) => { e.preventDefault(); host.setting(row.dataset.set, !hostStatus.settings[row.dataset.set]); }));
  $('#hLevel').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) host.setting('level', b.dataset.v); });
  $('#hFps').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) host.setting('fps', +b.dataset.v); });
  $('#name').addEventListener('change', () => { host.rename($('#name').value.trim()); toast('이름을 바꿨어요'); });
  $('#name').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
  const take = (s) => { hostStatus = s; renderHost(s); };
  host.onStatus(take);
  host.status().then(take);
}
