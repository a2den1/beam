// 화면 배치(맞춤·확대·이동)와 터치 제스처를 마우스 조작으로 바꾸는 부분입니다.
//  트랙패드 모드: 한 손가락 이동=커서 이동, 탭=클릭, 길게 누른 뒤 이동=드래그,
//                두 손가락 탭=오른쪽 클릭, 두 손가락 이동=스크롤, 벌리기=확대, 세 손가락 탭=키보드
//  터치 모드: 누른 곳을 바로 클릭/드래그, 길게 누르기=오른쪽 클릭

export class View {
  constructor(stage, view, video) {
    this.stage = stage; this.view = view; this.video = video;
    this.vw = 16; this.vh = 9;
    this.z = 1; this.tx = 0; this.ty = 0;
    this.layout();
    new ResizeObserver(() => this.layout(true)).observe(stage);
  }

  setSource(w, h) {
    if (!w || !h || (w === this.vw && h === this.vh)) return;
    this.vw = w; this.vh = h;
    this.layout();
  }

  layout(keep) {
    const W = this.stage.clientWidth, H = this.stage.clientHeight;
    this.W = W; this.H = H;
    const fit = Math.min(W / this.vw, H / this.vh);
    this.dw = this.vw * fit; this.dh = this.vh * fit;
    this.view.style.width = this.dw + 'px';
    this.view.style.height = this.dh + 'px';
    if (!keep) this.z = 1;
    this.clamp();
    this.apply();
  }

  reset() { this.z = 1; this.clamp(); this.apply(true); }

  clamp() {
    const cw = this.dw * this.z, ch = this.dh * this.z;
    this.tx = cw <= this.W ? (this.W - cw) / 2 : Math.min(0, Math.max(this.W - cw, this.tx));
    this.ty = ch <= this.H ? (this.H - ch) / 2 : Math.min(0, Math.max(this.H - ch, this.ty));
  }

  apply(animate) {
    this.view.style.transition = animate ? 'transform .35s cubic-bezier(.32,.72,0,1)' : 'none';
    this.view.style.transform = `translate3d(${this.tx}px, ${this.ty}px, 0) scale(${this.z})`;
  }

  zoomAt(fx, fy, ratio) {
    const z = Math.min(5, Math.max(1, this.z * ratio));
    this.tx = fx - ((fx - this.tx) * z) / this.z;
    this.ty = fy - ((fy - this.ty) * z) / this.z;
    this.z = z;
    this.clamp();
    this.apply();
  }

  pan(dx, dy) { this.tx += dx; this.ty += dy; this.clamp(); this.apply(); }

  // 화면 좌표 → PC 화면 비율(0~1)
  toRemote(x, y) {
    return {
      x: Math.min(1, Math.max(0, (x - this.tx) / (this.dw * this.z))),
      y: Math.min(1, Math.max(0, (y - this.ty) / (this.dh * this.z))),
    };
  }

  // 손가락 1px 이 PC 화면에서 몇 px 인지
  get pxRatio() { return this.vw / (this.dw * this.z); }

  // 확대 중일 때 커서가 화면 밖으로 나가면 따라갑니다.
  follow(u, v) {
    if (this.z <= 1.01) return;
    const x = this.tx + u * this.dw * this.z, y = this.ty + v * this.dh * this.z;
    const mx = this.W * 0.18, my = this.H * 0.18;
    let dx = 0, dy = 0;
    if (x < mx) dx = mx - x; else if (x > this.W - mx) dx = this.W - mx - x;
    if (y < my) dy = my - y; else if (y > this.H - my) dy = this.H - my - y;
    if (dx || dy) this.pan(dx, dy);
  }
}

export class Gestures {
  constructor(el, view, send, hooks = {}) {
    this.el = el; this.view = view; this.send = send; this.hooks = hooks;
    this.mode = 'trackpad';
    this.pts = new Map();
    this.g = null; // 진행 중인 제스처
    this.sens = 1.5;
    el.addEventListener('pointerdown', (e) => this.down(e));
    el.addEventListener('pointermove', (e) => this.move(e));
    el.addEventListener('pointerup', (e) => this.up(e));
    el.addEventListener('pointercancel', (e) => this.up(e, true));
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    this.mouseHeld = new Set();
    el.addEventListener('mousedown', (e) => this.mouseDown(e));
    window.addEventListener('mouseup', (e) => this.mouseUp(e));
    el.addEventListener('auxclick', (e) => e.preventDefault());
    // PC 마우스/휠로 테스트할 때를 위한 처리
    el.addEventListener('wheel', (e) => { e.preventDefault(); this.send({ t: 'w', dy: e.deltaY, dx: e.deltaX }); }, { passive: false });
  }

  buzz(ms = 8) { try { navigator.vibrate?.(ms); } catch { /* 무시 */ } }

  centroid() {
    let x = 0, y = 0;
    for (const p of this.pts.values()) { x += p.x; y += p.y; }
    const n = this.pts.size || 1;
    return { x: x / n, y: y / n };
  }

  spread() {
    const a = [...this.pts.values()];
    if (a.length < 2) return 0;
    return Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
  }

  down(e) {
    e.preventDefault();
    if (e.pointerType === 'mouse') { this.el.setPointerCapture?.(e.pointerId); return; } // 버튼은 mousedown 에서
    this.el.setPointerCapture?.(e.pointerId);
    this.pts.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY });
    const n = this.pts.size;
    const now = performance.now();
    this.hooks.activity?.();

    if (n === 1) {
      this.g = { kind: 'one', t0: now, moved: false, drag: false, lx: e.clientX, ly: e.clientY, max: 1 };
      clearTimeout(this.holdT);
      if (this.mode === 'touch') {
        const r = this.view.toRemote(e.clientX, e.clientY);
        this.send({ t: 'm', ...r });
        this.holdT = setTimeout(() => {
          if (this.g?.kind === 'one' && !this.g.moved) { this.g.right = true; this.buzz(15); this.click(1); }
        }, 550);
      } else {
        this.holdT = setTimeout(() => {
          if (this.g?.kind === 'one' && !this.g.moved) { this.g.drag = true; this.buzz(15); this.send({ t: 'b', b: 0, d: 1 }); }
        }, 380);
      }
    } else {
      clearTimeout(this.holdT);
      if (this.g?.drag) { this.send({ t: 'b', b: 0, d: 0 }); }
      const c = this.centroid();
      this.g = { kind: 'multi', t0: this.g?.kind === 'multi' ? this.g.t0 : now, n, max: Math.max(n, this.g?.max || 0), cx: c.x, cy: c.y, d0: this.spread(), dl: this.spread(), mode: null, moved: false };
    }
  }

  move(e) {
    if (e.pointerType === 'mouse') return this.mouseMove(e);
    const p = this.pts.get(e.pointerId);
    if (!p) return;
    e.preventDefault();
    // 끊김 없이 부드럽게: 브라우저가 묶어 보낸 중간 좌표까지 씁니다.
    p.x = e.clientX; p.y = e.clientY;
    const g = this.g;
    if (!g) return;

    if (g.kind === 'one') {
      const dist = Math.hypot(p.x - p.sx, p.y - p.sy);
      if (!g.moved && dist > (this.mode === 'touch' ? 10 : 6)) {
        g.moved = true;
        clearTimeout(this.holdT);
        if (this.mode === 'touch' && !g.right) { g.drag = true; this.send({ t: 'b', b: 0, d: 1 }); }
      }
      if (this.mode === 'touch') {
        if (g.moved) this.send({ t: 'm', ...this.view.toRemote(p.x, p.y) });
      } else if (g.moved || g.drag) {
        const dx = p.x - g.lx, dy = p.y - g.ly;
        const dt = Math.max(1, e.timeStamp - (g.lt || e.timeStamp - 16));
        const speed = Math.hypot(dx, dy) / dt; // px/ms
        const accel = Math.min(3, 1 + speed * 0.9);
        const k = this.view.pxRatio * this.sens * accel;
        g.ax = (g.ax || 0) + dx * k; g.ay = (g.ay || 0) + dy * k;
        const ix = Math.trunc(g.ax), iy = Math.trunc(g.ay);
        if (ix || iy) { this.send({ t: 'r', dx: ix, dy: iy }); g.ax -= ix; g.ay -= iy; }
      }
      g.lx = p.x; g.ly = p.y; g.lt = e.timeStamp;
      return;
    }

    // 두 손가락 이상
    const c = this.centroid();
    const d = this.spread();
    const dx = c.x - g.cx, dy = c.y - g.cy;
    if (!g.mode) {
      const dd = Math.abs(d - g.d0);
      const dm = Math.hypot(c.x - (g.sx ?? (g.sx = g.cx)), c.y - (g.sy ?? (g.sy = g.cy)));
      if (dd > 24 && dd > dm * 1.2) g.mode = 'pinch';
      else if (dm > 10) g.mode = 'scroll';
      if (g.mode) g.moved = true;
    }
    if (g.mode === 'pinch' && g.n >= 2) {
      if (g.dl > 0 && d > 0) this.view.zoomAt(c.x, c.y, d / g.dl);
      this.view.pan(dx, dy);
    } else if (g.mode === 'scroll') {
      g.wx = (g.wx || 0) - dx * 3; g.wy = (g.wy || 0) - dy * 3;
      const ix = Math.trunc(g.wx), iy = Math.trunc(g.wy);
      if (ix || iy) { this.send({ t: 'w', dx: ix, dy: iy }); g.wx -= ix; g.wy -= iy; }
    }
    g.cx = c.x; g.cy = c.y; g.dl = d;
  }

  up(e, cancel) {
    if (e.pointerType === 'mouse') return;
    if (!this.pts.has(e.pointerId)) return;
    this.pts.delete(e.pointerId);
    const g = this.g;
    const now = performance.now();
    if (!g) return;

    if (g.kind === 'one') {
      clearTimeout(this.holdT);
      if (g.drag) this.send({ t: 'b', b: 0, d: 0 });
      else if (!cancel && !g.moved && !g.right && now - g.t0 < 300) this.click(0);
      this.g = null;
      return;
    }

    if (this.pts.size === 0) {
      if (!cancel && !g.moved && now - g.t0 < 300) {
        if (g.max === 2) this.click(1);
        else if (g.max >= 3) this.hooks.threeTap?.();
      }
      this.g = null;
    } else {
      // 남은 손가락으로 계속(다시 모으기)
      const c = this.centroid();
      g.cx = c.x; g.cy = c.y; g.n = this.pts.size; g.dl = this.spread();
    }
  }

  click(b) {
    this.buzz(6);
    this.send({ t: 'b', b, d: 1 });
    this.send({ t: 'b', b, d: 0 });
  }

  // 블루투스·USB 마우스(폰·태블릿·PC 브라우저): 절대 좌표로 그대로 조작합니다.
  // pointerdown 은 첫 버튼만 알려 주므로 버튼마다 오는 mousedown/mouseup 을 씁니다.
  static btn(e) { return [0, 2, 1, 3, 4][e.button] ?? -1; } // 왼·가운데·오른·뒤로·앞으로 → 0·2·1·3·4
  mouseDown(e) {
    if (e.sourceCapabilities?.firesTouchEvents) return; // 터치가 흉내 낸 마우스 이벤트
    e.preventDefault();
    const b = Gestures.btn(e);
    if (b < 0) return;
    this.send({ t: 'm', ...this.view.toRemote(e.clientX, e.clientY) });
    this.mouseHeld.add(b);
    this.send({ t: 'b', b, d: 1 });
  }
  mouseMove(e) {
    const now = performance.now();
    if (now - (this.lastMouse || 0) < 4) return;
    this.lastMouse = now;
    this.send({ t: 'm', ...this.view.toRemote(e.clientX, e.clientY) });
  }
  mouseUp(e) {
    const b = Gestures.btn(e);
    if (!this.mouseHeld.has(b)) return;
    e.preventDefault(); // 뒤로/앞으로 버튼이 브라우저 이동을 일으키지 않게
    this.mouseHeld.delete(b);
    this.send({ t: 'b', b, d: 0 });
  }
}
