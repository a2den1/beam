// PC 와 폰이 공유하는 인증 규칙입니다.
// 공개 브로커는 누구나 엿볼 수 있으므로, 처음 연결할 때는 비밀번호가 새지 않는 SPAKE2 로
// 세션 키를 만들고, 그다음부터는 등록된 기기 키로 HMAC 인증만 합니다.

export const PREFIX = 'beam1';
export const topicIn = (id) => `${PREFIX}/${id}/in`;
export const topicOut = (id, sid) => `${PREFIX}/${id}/out/${sid}`;
export const topicState = (id) => `${PREFIX}/${id}/st`;

const te = new TextEncoder();
const subtle = globalThis.crypto.subtle;

export function randomHex(bytes = 16) {
  const a = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomDigits(n) {
  const a = new Uint32Array(n);
  globalThis.crypto.getRandomValues(a);
  return [...a].map((v) => v % 10).join('');
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));

export async function sha256(text) {
  return hex(await subtle.digest('SHA-256', te.encode(text)));
}

async function hmacKey(keyHex) {
  return subtle.importKey('raw', unhex(keyHex), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

export async function hmac(keyHex, text) {
  return hex(await subtle.sign('HMAC', await hmacKey(keyHex), te.encode(text)));
}

// 길이가 같은 두 문자열을 시간차 없이 비교합니다.
export function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// ── SPAKE2 (RFC 3526 2048-bit MODP 그룹) ───────────────────────────
const P = BigInt('0x' +
  'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DD' +
  'EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED' +
  'EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F' +
  '83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B' +
  'E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA0510' +
  '15728E5A8AACAA68FFFFFFFFFFFFFFFF');
const Q = (P - 1n) / 2n;
const G = 4n; // 2^2, 위수 Q 인 부분군의 생성원

function modpow(b, e, m) {
  let r = 1n; b %= m;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    e >>= 1n; b = (b * b) % m;
  }
  return r;
}

function modinv(a, m) {
  let [r0, r1] = [a % m, m], [s0, s1] = [1n, 0n];
  while (r1) { const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [s0, s1] = [s1, s0 - q * s1]; }
  return ((s0 % m) + m) % m;
}

async function hashInt(label, bytes = 2) {
  let h = '';
  for (let i = 0; i < bytes * 8 + 2; i++) h += await sha256(`${label}|${i}`);
  return BigInt('0x' + h);
}

let consts = null;
async function constants() {
  if (!consts) {
    // 이산로그를 아무도 모르는 원소 M, N 을 해시에서 뽑아 제곱(부분군으로 보냄)합니다.
    const m = modpow((await hashInt('beam-spake2-M')) % P, 2n, P);
    const n = modpow((await hashInt('beam-spake2-N')) % P, 2n, P);
    consts = { M: m, N: n };
  }
  return consts;
}

async function pwScalar(hostId, password) {
  return BigInt('0x' + (await sha256(`beam-pw|${hostId}|${password}`))) % Q;
}

function randScalar() { return BigInt('0x' + randomHex(32)) % Q; }

function validElement(x) {
  return x > 1n && x < P - 1n && modpow(x, Q, P) === 1n;
}

// 폰(A)과 PC(B) 가 각각 만든 공개값을 교환해 같은 키를 얻습니다.
export async function spakeStart(role, hostId, password) {
  const { M, N } = await constants();
  const w = await pwScalar(hostId, password);
  const x = randScalar();
  const mask = modpow(role === 'A' ? M : N, w, P);
  const pub = (modpow(G, x, P) * mask) % P;
  return { role, hostId, w, x, pub: pub.toString(16) };
}

export async function spakeFinish(st, otherHex) {
  const { M, N } = await constants();
  const other = BigInt('0x' + otherHex);
  if (!validElement(other)) throw new Error('bad element');
  const unmask = modinv(modpow(st.role === 'A' ? N : M, st.w, P), P);
  const k = modpow((other * unmask) % P, st.x, P);
  const [a, b] = st.role === 'A' ? [st.pub, otherHex] : [otherHex, st.pub];
  return sha256(`beam-spake2|${st.hostId}|${a}|${b}|${k.toString(16)}`);
}

// ── 메시지 암호화 ───────────────────────────────────────────────────
// SDP·ICE 후보에는 공인/내부 IP 가 들어 있으므로 공개 브로커에는 암호문만 올립니다.
// AES-256-GCM(세션 키에서 파생)이라 내용 변조도 함께 막습니다. 메시지 종류·sid 는 AAD 로 묶습니다.
const SECRET_FIELDS = ['sdp', 'c', 'mid'];
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const aesKeys = new Map();
async function aesKey(key) {
  if (!aesKeys.has(key)) {
    const raw = unhex(await hmac(key, 'beam-aes-gcm'));
    aesKeys.set(key, await subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']));
    if (aesKeys.size > 64) aesKeys.delete(aesKeys.keys().next().value);
  }
  return aesKeys.get(key);
}

export async function sign(key, msg) {
  const secret = {};
  for (const f of SECRET_FIELDS) if (msg[f] != null) { secret[f] = msg[f]; delete msg[f]; }
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(`${msg.m}|${msg.sid}`) }, await aesKey(key), te.encode(JSON.stringify(secret))));
  msg.x = b64(iv) + '.' + b64(ct);
  return msg;
}

// 복호화에 성공하면 원래 필드를 msg 에 되살리고 true 를 돌려줍니다.
export async function verify(key, msg) {
  if (typeof msg.x !== 'string' || !msg.x.includes('.')) return false;
  try {
    const [iv, ct] = msg.x.split('.').map(unb64);
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: te.encode(`${msg.m}|${msg.sid}`) }, await aesKey(key), ct);
    const secret = JSON.parse(new TextDecoder().decode(pt));
    for (const f of SECRET_FIELDS) if (secret[f] != null) msg[f] = secret[f];
    return true;
  } catch { return false; }
}

// 등록된 기기로 다시 붙을 때 쓰는 세션 키
export function deviceSessionKey(devKey, hostId, sid, nv, nh) {
  return hmac(devKey, `beam-dev|${hostId}|${sid}|${nv}|${nh}`);
}

export const confirmTag = (key, who) => hmac(key, `confirm|${who}`);
