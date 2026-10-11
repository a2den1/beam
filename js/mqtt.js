// 공개 MQTT 브로커 여러 곳에 동시에 붙어서 메시지를 주고받는 아주 작은 클라이언트입니다.
// 브라우저와 Node(일렉트론 메인) 양쪽에서 그대로 씁니다. QoS 0 만 씁니다.

export const BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
];

const te = new TextEncoder();
const td = new TextDecoder();

function u16(n) { return [(n >> 8) & 255, n & 255]; }
function str(s) { const b = te.encode(s); return [...u16(b.length), ...b]; }
function varlen(n) {
  const out = [];
  do { let d = n % 128; n = Math.floor(n / 128); if (n > 0) d |= 128; out.push(d); } while (n > 0);
  return out;
}
function packet(head, body) {
  const len = varlen(body.length);
  const out = new Uint8Array(1 + len.length + body.length);
  out[0] = head; out.set(len, 1); out.set(body, 1 + len.length);
  return out;
}
function concat(parts) {
  let n = 0; for (const p of parts) n += p.length;
  const out = new Uint8Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

class Link {
  constructor(url, owner) {
    this.url = url; this.owner = owner; this.ws = null; this.up = false;
    this.buf = new Uint8Array(0); this.pid = 1; this.retry = 500; this.closed = false;
    this.open();
  }

  open() {
    if (this.closed) return;
    let ws;
    try { ws = new WebSocket(this.url, ['mqtt']); } catch { return this.later(); }
    this.ws = ws; ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      const o = this.owner;
      let flags = 2; // clean session
      const body = [...str('MQTT'), 4];
      const payload = [...str(o.clientId)];
      if (o.will) {
        flags |= 4 | 32; // will flag + will retain, QoS 0
        payload.push(...str(o.will.topic), ...str(o.will.message));
      }
      body.push(flags, ...u16(30), ...payload);
      ws.send(packet(0x10, body));
    };
    ws.onmessage = (e) => this.feed(new Uint8Array(e.data));
    ws.onclose = ws.onerror = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.up) { this.up = false; this.owner.changed(); }
      clearInterval(this.ping);
      this.later();
    };
  }

  later() {
    if (this.closed) return;
    clearTimeout(this.rt);
    this.rt = setTimeout(() => this.open(), this.retry);
    this.retry = Math.min(this.retry * 2, 15000);
  }

  feed(chunk) {
    this.buf = this.buf.length ? concat([this.buf, chunk]) : chunk;
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      let len = 0, mul = 1, i = 1;
      for (;;) {
        if (i >= b.length) return;
        const d = b[i++]; len += (d & 127) * mul; mul *= 128;
        if (!(d & 128)) break;
      }
      if (b.length < i + len) return;
      this.handle(b[0], b.subarray(i, i + len));
      this.buf = b.subarray(i + len);
    }
  }

  handle(head, body) {
    const type = head >> 4;
    if (type === 2) { // CONNACK
      if (body[1] !== 0) { this.ws?.close(); return; }
      this.up = true; this.retry = 500;
      for (const t of this.owner.topics) this.subscribe(t);
      for (const [t, m] of this.owner.retained) this.publish(t, m, true);
      clearInterval(this.ping);
      this.ping = setInterval(() => this.send(new Uint8Array([0xc0, 0])), 20000);
      this.owner.changed();
    } else if (type === 3) { // PUBLISH (QoS 0)
      const tl = (body[0] << 8) | body[1];
      const topic = td.decode(body.subarray(2, 2 + tl));
      let o = 2 + tl;
      if ((head >> 1) & 3) o += 2;
      this.owner.deliver(topic, td.decode(body.subarray(o)));
    }
  }

  send(bytes) {
    if (this.ws && this.ws.readyState === 1) { try { this.ws.send(bytes); return true; } catch { /* 끊긴 직후 */ } }
    return false;
  }

  subscribe(topic) {
    if (!this.up) return;
    this.pid = (this.pid % 65000) + 1;
    this.send(packet(0x82, [...u16(this.pid), ...str(topic), 0]));
  }

  unsubscribe(topic) {
    if (!this.up) return;
    this.pid = (this.pid % 65000) + 1;
    this.send(packet(0xa2, [...u16(this.pid), ...str(topic)]));
  }

  publish(topic, message, retain = false) {
    if (!this.up) return false;
    return this.send(packet(0x30 | (retain ? 1 : 0), [...str(topic), ...te.encode(message)]));
  }

  close() {
    this.closed = true; clearTimeout(this.rt); clearInterval(this.ping);
    if (this.ws) { try { this.send(new Uint8Array([0xe0, 0])); this.ws.close(); } catch { /* 무시 */ } }
    this.ws = null; this.up = false;
  }
}

// 같은 메시지가 브로커 수만큼 들어오므로 JSON 의 `i` 로 중복을 걸러 냅니다.
export class Relay {
  constructor({ will = null, brokers = BROKERS } = {}) {
    this.clientId = 'bm' + Math.random().toString(36).slice(2, 12);
    this.will = will;
    this.topics = new Set();
    this.retained = new Map();
    this.handlers = new Set();
    this.seen = new Map();
    this.onchange = null;
    this.links = brokers.map((u) => new Link(u, this));
    this.gc = setInterval(() => {
      const old = Date.now() - 120000;
      for (const [k, t] of this.seen) if (t < old) this.seen.delete(k);
    }, 30000);
  }

  get online() { return this.links.filter((l) => l.up).length; }

  changed() { this.onchange?.(this.online); }

  subscribe(topic) {
    if (this.topics.has(topic)) return;
    this.topics.add(topic);
    for (const l of this.links) l.subscribe(topic);
  }

  unsubscribe(topic) {
    if (!this.topics.delete(topic)) return;
    for (const l of this.links) l.unsubscribe(topic);
  }

  on(fn) { this.handlers.add(fn); return () => this.handlers.delete(fn); }

  deliver(topic, text) {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.i) {
      if (this.seen.has(msg.i)) return;
      this.seen.set(msg.i, Date.now());
    }
    for (const fn of this.handlers) { try { fn(topic, msg); } catch (e) { console.error(e); } }
  }

  send(topic, msg, { retain = false } = {}) {
    msg.i ||= Math.random().toString(36).slice(2, 14);
    this.seen.set(msg.i, Date.now());
    const text = JSON.stringify(msg);
    if (retain) this.retained.set(topic, text);
    let ok = 0;
    for (const l of this.links) if (l.publish(topic, text, retain)) ok++;
    return ok;
  }

  // 연결된 브로커가 하나라도 생길 때까지 기다립니다.
  ready(timeout = 8000) {
    if (this.online) return Promise.resolve(true);
    return new Promise((res) => {
      const prev = this.onchange;
      const t = setTimeout(() => { this.onchange = prev; res(false); }, timeout);
      this.onchange = (n) => {
        prev?.(n);
        if (n) { clearTimeout(t); this.onchange = prev; res(true); }
      };
    });
  }

  close() {
    clearInterval(this.gc);
    for (const l of this.links) l.close();
  }
}
