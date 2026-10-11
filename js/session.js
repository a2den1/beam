// PC 한 대와의 연결: 신호(MQTT) → 인증 → WebRTC → 영상·조작 채널.
import * as P from './proto.js';

const ICE = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
];

export class Session extends EventTarget {
  constructor(relay, pc, { password = null, deviceName = '휴대폰' } = {}) {
    super();
    this.relay = relay;
    this.pc = pc; // { id, dev?, key? }
    this.password = password;
    this.deviceName = deviceName;
    this.sid = P.randomHex(12);
    this.key = null;
    this.rtc = null;
    this.dc = null;
    this.closed = false;
    this.pendingCands = [];
    this.stats = { fps: 0, rtt: 0, mbps: 0, route: '', w: 0, h: 0 };
    this.last = null;
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  async start() {
    const id = this.pc.id;
    this.topic = P.topicOut(id, this.sid);
    this.relay.subscribe(this.topic);
    this.off = this.relay.on((topic, msg) => {
      if (topic === this.topic && msg.sid === this.sid) this.onSignal(msg).catch((e) => this.fail('error', e));
    });
    this.emit('step', '중계 서버에 연결하는 중');
    if (!(await this.relay.ready(10000))) return this.fail('offline');
    // 구독이 브로커에 반영될 시간을 조금 줍니다.
    await new Promise((r) => setTimeout(r, 250));
    if (this.closed) return;

    this.nv = P.randomHex(16);
    const hello = { m: 'hello', sid: this.sid, nv: this.nv, name: this.deviceName };
    if (this.password == null && this.pc.dev) {
      hello.mode = 'dev';
      hello.dev = this.pc.dev;
    } else {
      hello.mode = 'pw';
      this.spake = await P.spakeStart('A', id, this.password);
      hello.X = this.spake.pub;
    }
    this.mode = hello.mode;
    this.emit('step', 'PC를 찾는 중');
    this.relay.send(P.topicIn(id), hello);
    // 브로커가 늦게 붙었거나 메시지가 빠졌을 때를 위해 한 번 더 보냅니다(중복은 i 로 걸러짐).
    // 중계 서버가 늦게 붙었거나 메시지가 빠졌을 때를 위해 몇 번 더 보냅니다(PC 는 같은 sid 를 한 번만 처리).
    let tries = 0;
    const again = () => {
      if (this.key || this.closed || ++tries > 4) return;
      this.relay.send(P.topicIn(id), { ...hello, i: undefined });
      this.resend = setTimeout(again, 2500);
    };
    this.resend = setTimeout(again, 2500);
    this.timer = setTimeout(() => { if (!this.rtc || this.rtc.connectionState !== 'connected') this.fail(this.key ? 'nat' : 'noreply'); }, 20000);
  }

  async onSignal(msg) {
    if (this.closed) return;
    if (msg.m === 'err') return this.fail(msg.code, msg);
    if (msg.m === 'wait') {
      // PC 앞에서 허락을 기다리는 동안은 시간 제한을 늘립니다.
      this.emit('step', 'PC에서 허락을 기다리는 중');
      clearTimeout(this.timer);
      this.timer = setTimeout(() => { if (!this.rtc || this.rtc.connectionState !== 'connected') this.fail('nat'); }, 50000);
      return;
    }

    if (msg.m === 'chal' && !this.key) {
      let key;
      if (this.mode === 'dev') key = await P.deviceSessionKey(this.pc.key, this.pc.id, this.sid, this.nv, String(msg.nh));
      else key = await P.spakeFinish(this.spake, String(msg.Y));
      // PC 도 같은 키를 갖고 있는지(= 진짜 내 PC 인지, 비밀번호가 맞는지) 확인합니다.
      if (!P.same(await P.confirmTag(key, 'host'), msg.tag)) {
        this.relay.send(P.topicIn(this.pc.id), { m: 'auth', sid: this.sid, tag: 'x' });
        return this.fail(this.mode === 'pw' ? 'badpw' : 'unknown');
      }
      this.key = key;
      clearTimeout(this.resend);
      this.emit('step', '화면을 여는 중');
      this.relay.send(P.topicIn(this.pc.id), { m: 'auth', sid: this.sid, tag: await P.confirmTag(key, 'viewer') });
      this.makeRtc();
      return;
    }

    if (!this.key || !(await P.verify(this.key, msg))) return;
    if (msg.m === 'offer') {
      await this.rtc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
      for (const c of this.pendingCands.splice(0)) this.rtc.addIceCandidate(c).catch(() => {});
      await this.rtc.setLocalDescription();
      const ans = await P.sign(this.key, { m: 'answer', sid: this.sid, sdp: this.rtc.localDescription.sdp });
      this.relay.send(P.topicIn(this.pc.id), ans);
    } else if (msg.m === 'cand') {
      const c = { candidate: msg.c, sdpMid: msg.mid };
      if (this.rtc.remoteDescription) this.rtc.addIceCandidate(c).catch(() => {});
      else this.pendingCands.push(c);
    }
  }

  makeRtc() {
    const rtc = this.rtc = new RTCPeerConnection({ iceServers: ICE, bundlePolicy: 'max-bundle' });
    rtc.onicecandidate = async (e) => {
      if (!e.candidate || !e.candidate.candidate) return;
      const m = await P.sign(this.key, { m: 'cand', sid: this.sid, c: e.candidate.candidate, mid: e.candidate.sdpMid || '' });
      this.relay.send(P.topicIn(this.pc.id), m);
    };
    rtc.ontrack = (e) => {
      const r = e.receiver;
      // 받은 프레임을 버퍼에 쌓지 않고 바로 그립니다.
      try { r.jitterBufferTarget = 0; } catch { /* 미지원 */ }
      try { r.playoutDelayHint = 0; } catch { /* 미지원 */ }
      this.receiver = r;
      this.emit('track', e.streams[0] || new MediaStream([e.track]));
    };
    rtc.ondatachannel = (e) => {
      const dc = this.dc = e.channel;
      dc.onopen = () => this.emit('open');
      dc.onmessage = (m) => { try { this.onControl(JSON.parse(m.data)); } catch { /* 무시 */ } };
      dc.onclose = () => this.fail('closed');
    };
    rtc.onconnectionstatechange = () => {
      const s = rtc.connectionState;
      if (s === 'connected') { clearTimeout(this.timer); this.emit('connected'); this.startStats(); }
      if (s === 'failed') this.fail('lost');
      if (s === 'disconnected') {
        clearTimeout(this.dcTimer);
        this.dcTimer = setTimeout(() => { if (rtc.connectionState === 'disconnected') this.fail('lost'); }, 4000);
      }
    };
  }

  onControl(m) {
    if (m.t === 'pong') { this.stats.rtt = Math.round(performance.now() - m.ts); return; }
    this.emit(m.t, m);
  }

  send(m) {
    const dc = this.dc;
    if (!dc || dc.readyState !== 'open') return false;
    // 느린 회선에서 이동 메시지가 쌓이면 버립니다(눌림/뗌·키는 항상 보냄).
    if ((m.t === 'r' || m.t === 'm') && dc.bufferedAmount > 64 * 1024) return false;
    dc.send(JSON.stringify(m));
    return true;
  }

  startStats() {
    clearInterval(this.statT);
    this.statT = setInterval(() => this.poll(), 1000);
  }

  async poll() {
    if (!this.rtc || this.closed) return;
    this.send({ t: 'ping', ts: performance.now() });
    const rep = await this.rtc.getStats();
    let inb = null, pair = null;
    const byId = new Map();
    rep.forEach((r) => {
      byId.set(r.id, r);
      if (r.type === 'inbound-rtp' && r.kind === 'video') inb = r;
      if (r.type === 'candidate-pair' && r.state === 'succeeded' && (r.nominated || r.selected)) pair = r;
    });
    if (!inb) return;
    const l = this.last || inb;
    const dt = Math.max(0.001, (inb.timestamp - l.timestamp) / 1000);
    const lost = Math.max(0, (inb.packetsLost || 0) - (l.packetsLost || 0));
    const recv = Math.max(0, (inb.packetsReceived || 0) - (l.packetsReceived || 0));
    const emitted = (inb.jitterBufferEmittedCount || 0) - (l.jitterBufferEmittedCount || 0);
    const jb = emitted > 0 ? ((inb.jitterBufferDelay - l.jitterBufferDelay) / emitted) * 1000 : 0;
    const dropped = (inb.framesDropped || 0) - (l.framesDropped || 0);
    const frames = (inb.framesDecoded || 0) - (l.framesDecoded || 0);
    this.stats.fps = Math.round(frames / dt);
    this.stats.mbps = (((inb.bytesReceived || 0) - (l.bytesReceived || 0)) * 8) / dt / 1e6;
    this.stats.w = inb.frameWidth || 0;
    this.stats.h = inb.frameHeight || 0;
    this.stats.jb = jb;
    if (pair) {
      const lc = byId.get(pair.localCandidateId);
      const rc = byId.get(pair.remoteCandidateId);
      this.stats.route = (lc?.candidateType === 'relay' || rc?.candidateType === 'relay') ? '중계'
        : (lc?.candidateType === 'host' && rc?.candidateType === 'host') ? '같은 네트워크' : '직접 연결';
    }
    if (this.last) this.send({ t: 'st', lost, recv, jb: Math.round(jb), dropped, fps: this.stats.fps, mbps: +this.stats.mbps.toFixed(2), w: this.stats.w, h: this.stats.h });
    this.last = inb;
    this.emit('stats', this.stats);
  }

  fail(code, detail) {
    if (this.closed) return;
    this.close(false);
    this.emit('end', { code, detail });
  }

  close(bye = true) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer); clearTimeout(this.resend); clearTimeout(this.dcTimer); clearInterval(this.statT);
    if (bye && this.key) P.sign(this.key, { m: 'bye', sid: this.sid }).then((m) => this.relay.send(P.topicIn(this.pc.id), m));
    try { this.dc?.close(); } catch { /* 무시 */ }
    try { this.rtc?.close(); } catch { /* 무시 */ }
    this.off?.();
    this.relay.unsubscribe(this.topic);
  }
}
