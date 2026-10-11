// 듀오톤 아이콘: 옅은 면(.s) + 선(.p) 두 겹. <i data-i="이름"></i> 을 자동으로 바꿉니다.
(function () {
  const L = (d) => `<path class="p" d="${d}"/>`;
  const S = (d) => `<path class="s" d="${d}"/>`;
  const C = (cx, cy, r, cls = 's') => `<circle class="${cls}" cx="${cx}" cy="${cy}" r="${r}"/>`;
  const R = (x, y, w, h, r, cls = 's') => `<rect class="${cls}" x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}"/>`;

  const I = {
    display: R(3, 4, 18, 12, 2.5) + R(3, 4, 18, 12, 2.5, 'p') + L('M9 20h6M12 16v4'),
    plus: C(12, 12, 9) + L('M12 8v8M8 12h8'),
    gear: C(12, 12, 8.5) + C(12, 12, 3, 'p') + L('M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1'),
    trash: R(6, 7, 12, 14, 2.5) + L('M4 7h16M10 3.5h4M10 11v6M14 11v6M6 7l.8 11.5A2.5 2.5 0 0 0 9.3 21h5.4a2.5 2.5 0 0 0 2.5-2.5L18 7'),
    moon: S('M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z') + L('M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z'),
    bolt: S('M13 2L4 14h7l-1 8 10-13h-7z') + L('M13 2L4 14h7l-1 8 10-13h-7z'),
    power: C(12, 13, 8) + L('M12 3v8M7 6.5a8 8 0 1 0 10 0'),
    keyboard: R(2, 6, 20, 12, 2.5) + R(2, 6, 20, 12, 2.5, 'p') + L('M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7.5 14h9'),
    pointer: S('M5 3l14 7-6.2 1.8L10 18z') + L('M5 3l14 7-6.2 1.8L10 18zM13 12l5 6'),
    hand: C(9, 6.5, 4) + L('M9 6.5v9l-2-2a1.6 1.6 0 0 0-2.3 2.2L9 21h8l1.2-6a2 2 0 0 0-1.8-2.4L13 12V6.5a2 2 0 0 0-4 0'),
    expand: R(6, 6, 12, 12, 2) + L('M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5'),
    lock: R(5, 10, 14, 11, 2.5) + R(5, 10, 14, 11, 2.5, 'p') + L('M8 10V7a4 4 0 0 1 8 0v3M12 14v3'),
    rotate: C(12, 12, 8) + L('M20 12a8 8 0 1 1-2.3-5.6L20 8.5M20 3.5v5h-5'),
    sun: C(12, 12, 4.5) + C(12, 12, 4.5, 'p') + L('M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8'),
    pen: S('M4 20l1-4.5L15.5 5l3.5 3.5L8.5 19z') + L('M4 20l1-4.5L15.5 5l3.5 3.5L8.5 19zM13 7.5l3.5 3.5'),
    xmark: C(12, 12, 9) + L('M9 9l6 6M15 9l-6 6'),
    chevron: C(12, 12, 9) + L('M8 10.5l4 4 4-4'),
    more: C(12, 12, 9) + L('M8 12h.01M12 12h.01M16 12h.01'),
    mobile: R(6.5, 2, 11, 20, 3) + R(6.5, 2, 11, 20, 3, 'p') + L('M11 18h2'),
    house: S('M4 10l8-6 8 6v10H4z') + L('M4 10l8-6 8 6v10h-5v-6H9v6H4z'),
    route: C(6, 18, 3) + C(18, 6, 3) + L('M9 18h6a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6'),
    link: S('M9 15l6-6') + L('M10 6.5l1.5-1.5a4.2 4.2 0 0 1 6 6L16 12.5M8 11.5L6.5 13a4.2 4.2 0 0 0 6 6l1.5-1.5M9 15l6-6'),
    image: R(3, 5, 18, 14, 2.5) + L('M3 16l5-5 4 4 3-3 6 6') + C(16, 9, 1.6, 'p'),
    gauge: S('M3 16a9 9 0 0 1 18 0z') + L('M3 16a9 9 0 0 1 18 0M12 16l4-5'),
    back: S('M9 5h11v14H9l-6-7z') + L('M9 5h11v14H9l-6-7zM12.5 9.5l5 5M17.5 9.5l-5 5'),
    next: C(12, 12, 9) + L('M8 12h8M12.5 8l4 4-4 4'),
    left: L('M19 12H5M11 6l-6 6 6 6'),
    right: L('M5 12h14M13 6l6 6-6 6'),
    up: L('M12 19V5M6 11l6-6 6 6'),
    down: L('M12 5v14M6 13l6 6 6-6'),
    min: L('M6 12h12'),
    max: R(6, 6, 12, 12, 2, 'p'),
    close: L('M7 7l10 10M17 7L7 17'),
    copy: R(8, 8, 12, 12, 2.5) + L('M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2') + R(8, 8, 12, 12, 2.5, 'p'),
    volume: S('M4 9h4l5-4v14l-5-4H4z') + L('M4 9h4l5-4v14l-5-4H4zM16.5 9a4 4 0 0 1 0 6M19 6.5a7.5 7.5 0 0 1 0 11'),
    mute: S('M4 9h4l5-4v14l-5-4H4z') + L('M4 9h4l5-4v14l-5-4H4zM17 10l4 4M21 10l-4 4'),
    full: R(4, 5, 16, 14, 2) + L('M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4'),
    signal: S('M2 20h20V4z') + L('M7 20v-4M12 20v-8M17 20V8'),
  };

  function svg(name) {
    const body = I[name] || I.display;
    return `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
  }

  function hydrate(root = document) {
    root.querySelectorAll('i[data-i]').forEach((el) => {
      el.outerHTML = svg(el.dataset.i);
    });
  }

  globalThis.Icons = { svg, hydrate, names: Object.keys(I) };
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => hydrate());
    else hydrate();
  }
})();
