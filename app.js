/* Tack — an open-source sticky-note board. No build step, no account, no limits. */
'use strict';
(() => {
  // ---------- constants ----------
  const FONT = 'Helvetica, Arial, sans-serif';
  const INK = '#e6e8ee';        // default line & text color on the dark board
  const NOTE_INK = '#1f2328';   // text on light sticky notes
  const BG = '#16181d';         // board background (also used for exports)
  const ACCENT = '#6b84ff';
  const STICKY_COLORS = ['#fff59d', '#ffd59a', '#ffb8cb', '#dcc6f2', '#b8dcff', '#c2ecc8', '#e4e6ea', '#ffffff'];
  const SHAPE_FILL = '#262a33';
  const SHAPE_FILLS = [SHAPE_FILL, ...STICKY_COLORS.slice(0, 7), 'none'];
  const INK_COLORS = ['#e6e8ee', '#ff6b70', '#ffa057', '#4cc38a', '#6ea8ff', '#b994f5', '#8b8d98'];
  const TEXT_SIZES = [['S', 16], ['M', 24], ['L', 36], ['XL', 56]];
  const STICKY_SIZES = [['S', 140], ['M', 200], ['L', 300]];
  const NORM = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };
  const OPP = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' };
  const LABEL_WRAP = 204;
  const ZMIN = 0.05, ZMAX = 8;
  const CDN = {
    jspdf: 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
    svg2pdf: 'https://cdn.jsdelivr.net/npm/svg2pdf.js@2.2.3/dist/svg2pdf.umd.min.js',
    lucide: 'https://cdn.jsdelivr.net/npm/lucide@0.460.0/dist/umd/lucide.min.js',
  };

  const $ = s => document.querySelector(s);
  const svg = $('#canvas'), world = $('#world'), overlay = $('#overlay');
  const editor = $('#editor'), ctxEl = $('#ctx');
  const dotPattern = $('#dots'), dot = $('#dot'), grid = $('#grid');

  const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
  const n = v => Math.round(v * 100) / 100;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const esc = s => String(s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------- storage ----------
  const INDEX_KEY = 'tack:index', LAST_KEY = 'tack:last';
  const boardKey = id => 'tack:board:' + id;
  const store = {
    get(k, fallback) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { console.warn(e); return false; } },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };

  // ---------- state ----------
  let board = null, items = [], byId = new Map();
  const view = { x: 0, y: 0, z: 1 };
  const S = {
    sel: new Set(), tool: 'select', drag: null, editing: null, hover: null,
    spaceDown: false, lastSticky: STICKY_COLORS[0], lastStickySize: 200, pointer: { x: 0, y: 0 },
  };
  let undoStack = [], redoStack = [], snapshot = '[]';

  const reindex = () => { byId = new Map(items.map(i => [i.id, i])); };
  const selected = () => [...S.sel].map(id => byId.get(id)).filter(Boolean);

  // ---------- shapes ----------
  // Default size, text padding (fraction of w/h) and, for slanted sides, how far the left/right
  // connection points sit inside the bounding box.
  const SHAPES = {
    rect: { label: 'Rectangle', w: 240, h: 140, pad: [0, 0] },
    ellipse: { label: 'Ellipse', w: 220, h: 150, pad: [0.16, 0.16] },
    diamond: { label: 'Diamond', w: 220, h: 160, pad: [0.26, 0.26] },
    triangle: { label: 'Triangle', w: 220, h: 180, pad: [0.27, 0.3], inset: 0.25 },
    hexagon: { label: 'Hexagon', w: 230, h: 150, pad: [0.2, 0.12] },
    parallelogram: { label: 'Parallelogram', w: 250, h: 130, pad: [0.2, 0.1], inset: 0.1 },
    cylinder: { label: 'Cylinder', w: 170, h: 190, pad: [0.1, 0.2] },
  };

  // Outline of a shape as one or two SVG paths: [body, extra stroke-only detail].
  function shapePaths(kind, x, y, w, h) {
    const cx = x + w / 2, cy = y + h / 2, P = (...a) => a.map(n).join(' ');
    switch (kind) {
      case 'diamond': return [`M${P(cx, y)}L${P(x + w, cy)}L${P(cx, y + h)}L${P(x, cy)}Z`];
      case 'triangle': return [`M${P(cx, y)}L${P(x + w, y + h)}L${P(x, y + h)}Z`];
      case 'hexagon': { const i = Math.min(w * 0.22, h * 0.5); return [`M${P(x + i, y)}L${P(x + w - i, y)}L${P(x + w, cy)}L${P(x + w - i, y + h)}L${P(x + i, y + h)}L${P(x, cy)}Z`]; }
      case 'parallelogram': { const k = w * 0.2; return [`M${P(x + k, y)}L${P(x + w, y)}L${P(x + w - k, y + h)}L${P(x, y + h)}Z`]; }
      case 'cylinder': {
        const rx = w / 2, ry = Math.min(h * 0.12, w * 0.25);
        return [
          `M${P(x, y + ry)}A${P(rx, ry)} 0 0 1 ${P(x + w, y + ry)}L${P(x + w, y + h - ry)}A${P(rx, ry)} 0 0 1 ${P(x, y + h - ry)}Z`,
          `M${P(x, y + ry)}A${P(rx, ry)} 0 0 0 ${P(x + w, y + ry)}`,
        ];
      }
      case 'ellipse': return [`M${P(x, cy)}A${P(w / 2, h / 2)} 0 1 1 ${P(x + w, cy)}A${P(w / 2, h / 2)} 0 1 1 ${P(x, cy)}Z`];
      default: { const r = Math.min(8, w / 4, h / 4); return [`M${P(x + r, y)}H${n(x + w - r)}A${P(r, r)} 0 0 1 ${P(x + w, y + r)}V${n(y + h - r)}A${P(r, r)} 0 0 1 ${P(x + w - r, y + h)}H${n(x + r)}A${P(r, r)} 0 0 1 ${P(x, y + h - r)}V${n(y + r)}A${P(r, r)} 0 0 1 ${P(x + r, y)}Z`]; }
    }
  }

  const shapeIcon = kind => `<svg viewBox="0 0 24 24">${shapePaths(kind, 3.5, 5, 17, 14).map(d => `<path d="${d}"/>`).join('')}</svg>`;

  // ---------- icons ----------
  // Icons come from Lucide (ISC license). The full set loads on demand; each placed icon stores
  // its own outline, so boards keep rendering offline. Only plain drawing elements are allowed through.
  const ICON_TAGS = new Set(['path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse']);
  const ICON_ATTRS = new Set(['d', 'cx', 'cy', 'r', 'x', 'y', 'width', 'height', 'rx', 'ry', 'x1', 'y1', 'x2', 'y2', 'points']);
  function iconNodes(raw) {
    const list = Array.isArray(raw) && raw[0] === 'svg' ? raw[2] : raw;
    return (Array.isArray(list) ? list : [])
      .filter(e => Array.isArray(e) && ICON_TAGS.has(e[0]) && e[1] && typeof e[1] === 'object')
      .map(([tag, attrs]) => [tag, Object.fromEntries(Object.entries(attrs).filter(([k, v]) => ICON_ATTRS.has(k) && /^[\d\s.,\-a-zA-Z]*$/.test(String(v))))]);
  }
  const iconMarkup = nodes => iconNodes(nodes).map(([tag, a]) => `<${tag} ${Object.entries(a).map(([k, v]) => `${k}="${v}"`).join(' ')}/>`).join('');

  // ---------- images ----------
  // Image files live in IndexedDB (localStorage is far too small); board items only hold a key.
  const imageDB = (() => {
    let dbp;
    // If the database somehow exists without its image store, reopen at the next version to add it.
    const openDB = version => new Promise((res, rej) => {
      const r = indexedDB.open('tack', version);
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('images')) r.result.createObjectStore('images'); };
      r.onsuccess = () => {
        const db = r.result;
        db.onversionchange = () => { db.close(); dbp = null; }; // let other tabs upgrade
        if (db.objectStoreNames.contains('images')) return res(db);
        const next = db.version + 1;
        db.close();
        openDB(next).then(res, rej);
      };
      r.onerror = () => rej(r.error);
    });
    // Don't let a stuck database hang the app (another tab can block an upgrade).
    const open = () => dbp ||= Promise.race([
      openDB(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Image storage is busy')), 8000)),
    ]).catch(err => { dbp = null; throw err; });
    const run = async (mode, fn) => {
      const db = await open();
      return new Promise((res, rej) => {
        const t = db.transaction('images', mode);
        const req = fn(t.objectStore('images'));
        t.oncomplete = () => res(req.result);
        t.onerror = () => rej(t.error);
      });
    };
    return { put: (k, blob) => run('readwrite', st => st.put(blob, k)), get: k => run('readonly', st => st.get(k)) };
  })();

  const images = new Map(); // key -> { blob, url } once loaded, or a pending promise
  function loadImage(key) {
    if (images.has(key)) return images.get(key);
    const pending = imageDB.get(key).then(blob => blob || fetchRemoteImage(key)).then(blob => {
      const entry = blob ? { blob, url: URL.createObjectURL(blob) } : { missing: true };
      images.set(key, entry);
      render();
      return entry;
    }).catch(err => { console.error(err); images.set(key, { missing: true }); render(); });
    images.set(key, pending);
    return pending;
  }
  const imageEntry = key => { const e = images.get(key); return e && !(e instanceof Promise) ? e : null; };

  const blobToDataURL = blob => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });

  // Embedded copies of every image in `list`, for exports. PDFs only take PNG/JPEG, so other
  // formats are converted when `pdfSafe` is set.
  async function imageDataURLs(list, pdfSafe = false) {
    const map = new Map();
    for (const it of list) {
      if (it.type !== 'image' || map.has(it.img)) continue;
      const e = await loadImage(it.img);
      if (!e || !e.blob) continue;
      if (pdfSafe && !/^image\/(png|jpeg)$/.test(e.blob.type)) {
        const img = await decodeImage(e.blob);
        const cv = document.createElement('canvas');
        cv.width = img.naturalWidth || img.width || 600; cv.height = img.naturalHeight || img.height || 400;
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        map.set(it.img, cv.toDataURL('image/png'));
      } else map.set(it.img, await blobToDataURL(e.blob));
    }
    return map;
  }

  const MAX_IMAGE = 2400;
  // Decode an image for its size (and for drawing when downscaling). createImageBitmap also works in
  // background tabs; SVGs need an <img> element instead.
  async function decodeImage(src) {
    try { return await createImageBitmap(src); } catch {}
    const url = URL.createObjectURL(src);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally { URL.revokeObjectURL(url); }
  }

  async function prepareImage(file) {
    const img = await decodeImage(file);
    let w = img.naturalWidth || img.width || 600, h = img.naturalHeight || img.height || 400;
    if (Math.max(w, h) <= MAX_IMAGE || /gif|svg/.test(file.type)) return { blob: file, w, h };
    const k = MAX_IMAGE / Math.max(w, h);
    w = Math.round(w * k); h = Math.round(h * k);
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    cv.getContext('2d').drawImage(img, 0, 0, w, h);
    const type = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    const blob = await new Promise(r => cv.toBlob(r, type, 0.9));
    return { blob: blob || file, w, h };
  }

  async function insertImageFiles(files, p) {
    const list = [...files].filter(f => f.type.startsWith('image/'));
    if (!list.length) return false;
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    const ids = [];
    let off = 0;
    for (const f of list) {
      try {
        const { blob, w, h } = await prepareImage(f);
        const key = uid();
        await imageDB.put(key, blob);
        images.set(key, { blob, url: URL.createObjectURL(blob) });
        const k = Math.min(1, 480 / Math.max(w, h));
        const it = { id: uid(), type: 'image', img: key, w: Math.round(w * k), h: Math.round(h * k) };
        it.x = Math.round(p.x - it.w / 2 + off);
        it.y = Math.round(p.y - it.h / 2 + off);
        items.push(it);
        byId.set(it.id, it);
        ids.push(it.id);
        off += 32;
      } catch (err) {
        console.error(err);
        toast(`Couldn’t add ${f.name || 'that image'}`);
      }
    }
    if (ids.length) { S.sel = new Set(ids); setTool('select'); commit(); }
    return true;
  }

  const viewCenter = () => ({ x: (innerWidth / 2 - view.x) / view.z, y: (innerHeight / 2 - view.y) / view.z });

  // ---------- text layout ----------
  const measure = document.createElement('canvas').getContext('2d');
  const widthCache = new Map();
  function tw(s, size) {
    s = s.replace(LINK_MARKS, '');
    if (s.includes(BOLD_START)) {
      // bold runs never span a space (see boldify), so each piece is measured on its own
      let total = 0;
      s.split(BOLD_START).forEach((part, i) => {
        const [b, rest = ''] = i ? part.split(BOLD_END) : ['', part];
        total += rawWidth(b, true) + rawWidth(rest.replace(BOLD_END, ''), false);
      });
      return total * size / 100;
    }
    return rawWidth(s.replace(BOLD_END, ''), false) * size / 100;
  }
  function rawWidth(s, bold) {
    if (!s) return 0;
    const key = (bold ? '\u0002' : '') + s;
    let w = widthCache.get(key);
    if (w === undefined) {
      if (widthCache.size > 50000) widthCache.clear();
      measure.font = `${bold ? 'bold ' : ''}100px ${FONT}`;
      w = measure.measureText(s).width;
      widthCache.set(key, w);
    }
    return w;
  }

  function wrapText(text, maxW, size) {
    const lines = [];
    for (const para of String(text).split('\n')) {
      let line = '';
      for (const word of para.split(' ')) {
        const cand = line ? line + ' ' + word : word;
        if (tw(cand, size) <= maxW) { line = cand; continue; }
        if (line) lines.push(line);
        let w = word;
        if (w.length > 1 && tw(w, size) > maxW) lines.broken = true;
        while (w.length > 1 && tw(w, size) > maxW) {
          let i = w.length - 1;
          while (i > 1 && tw(w.slice(0, i), size) > maxW) i--;
          lines.push(w.slice(0, i));
          w = w.slice(i);
        }
        line = w;
      }
      lines.push(line);
    }
    return lines;
  }

  // Links: URLs are shown shortened (and kept as one word when wrapping). The shortened text is
  // wrapped in private-use marker characters so rendering knows which parts are links.
  const LINK_RE = /\b(?:https?:\/\/|www\.)[^\s<>"]+/gi;
  const LINK_START = '\uE000', LINK_END = '\uE001', LINK_MARKS = /[\uE000\uE001]/g;
  // Bold: **like this**. Each bolded word is wrapped in its own markers.
  const BOLD_START = '\uE002', BOLD_END = '\uE003';
  const boldify = text => text.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, (_, inner) =>
    inner.split(/(\s+)/).map(w => (w && !/^\s+$/.test(w) ? BOLD_START + w + BOLD_END : w)).join(''));
  function linkify(text) {
    const links = [];
    const display = text.replace(LINK_RE, m => {
      const url = m.replace(/[.,;:!?)\]'"]+$/, '');
      links.push(/^https?:/i.test(url) ? url : 'https://' + url);
      let short = url.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '');
      if (short.length > 32) short = short.slice(0, 30) + '…';
      return LINK_START + short + LINK_END + m.slice(url.length);
    });
    return { display, links };
  }

  const layoutCache = new Map();
  function layout(it) {
    const text = it.type === 'connector' ? (it.label || '') : (it.text || '');
    const key = [it.type, it.shape, it.w, it.h, it.fontSize, text].join('\u0001');
    let L = layoutCache.get(key);
    if (L) return L;
    if (layoutCache.size > 4000) layoutCache.clear();
    const { display: linked, links } = linkify(text);
    const display = boldify(linked);
    if (it.type === 'text') {
      const size = it.fontSize || 24, pad = 4, lh = size * 1.3;
      L = { size, lh, pad, align: 'start', lines: wrapText(display, Math.max(10, it.w - pad * 2), size) };
    } else if (it.type === 'connector') {
      const size = 14, lh = 18;
      const lines = wrapText(display, LABEL_WRAP, size);
      L = { size, lh, pad: 8, align: 'middle', lines, width: Math.max(...lines.map(l => tw(l, size))) };
    } else {
      const base = Math.max(8, Math.min(it.w, it.h) * 0.08);
      const [fx, fy] = (it.type === 'shape' && SHAPES[it.shape]?.pad) || [0, 0];
      const padX = Math.max(base, it.w * fx), padY = Math.max(base, it.h * fy);
      const iw = Math.max(10, it.w - padX * 2), ih = Math.max(10, it.h - padY * 2);
      const max = it.type === 'sticky'
        ? clamp(Math.round(Math.min(it.w, it.h) * 0.15), 10, 96)
        : clamp(Math.round(Math.min(it.w, it.h) * 0.13), 10, 48);
      // Shrink until the text fits, and a bit further (to 60% of the starting size) to avoid
      // splitting a long word or link across lines.
      let size = max, lines;
      for (;;) {
        lines = wrapText(display, iw, size);
        if ((lines.length * size * 1.25 <= ih && (!lines.broken || size <= max * 0.6)) || size <= 6) break;
        size -= size > 24 ? 2 : 1;
      }
      L = { size, lh: size * 1.25, pad: padX, align: 'middle', lines };
    }
    L.links = links;
    layoutCache.set(key, L);
    return L;
  }

  function syncTextHeight(it) {
    if (it.type !== 'text') return;
    const L = layout(it);
    it.h = Math.max(1, L.lines.length) * L.lh + L.pad * 2;
  }

  // ---------- geometry ----------
  const center = it => ({ x: it.x + it.w / 2, y: it.y + it.h / 2 });
  const unit = (dx, dy) => { const l = Math.hypot(dx, dy) || 1; return { x: dx / l, y: dy / l }; };

  function sideToward(it, to) {
    const c = center(it), dx = (to.x - c.x) / it.w, dy = (to.y - c.y) / it.h;
    return Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'right' : 'left') : (dy >= 0 ? 'bottom' : 'top');
  }

  function sidePt(it, side, out = 0) {
    const c = center(it), [nx, ny] = NORM[side];
    const inset = nx && it.type === 'shape' ? (SHAPES[it.shape]?.inset || 0) * it.w : 0;
    return { x: c.x + nx * (it.w / 2 - inset + out), y: c.y + ny * (it.h / 2 + out) };
  }

  function polyMid(pts) {
    let total = 0;
    for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    let half = total / 2;
    for (let i = 1; i < pts.length; i++) {
      const seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      if (seg >= half && seg > 0) {
        const t = half / seg;
        return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t };
      }
      half -= seg;
    }
    return pts[0];
  }

  // Direction pointing *into* the tip at the end (or start) of a polyline.
  function tipDir(pts, atEnd) {
    const P = atEnd ? pts : [...pts].reverse();
    for (let i = P.length - 1; i > 0; i--) {
      const dx = P[i].x - P[i - 1].x, dy = P[i].y - P[i - 1].y;
      if (Math.hypot(dx, dy) > 0.01) return unit(dx, dy);
    }
    return { x: 1, y: 0 };
  }

  // Right-angle route from p1 (leaving along n1) to p2 (arriving against n2).
  function orthoRoute(p1, n1, p2, n2, bend = null) {
    const G = 24;
    const q1 = { x: p1.x + n1[0] * G, y: p1.y + n1[1] * G };
    const q2 = { x: p2.x + n2[0] * G, y: p2.y + n2[1] * G };
    const h1 = !n1[1], h2 = !n2[1];
    let pts;
    if (h1 && h2) {
      if ((q2.x - q1.x) * n1[0] >= 0 && (q1.x - q2.x) * n2[0] >= 0) {
        const mx = bend ?? (p1.x + p2.x) / 2;
        pts = [p1, { x: mx, y: p1.y }, { x: mx, y: p2.y }, p2];
      } else {
        const my = (p1.y + p2.y) / 2;
        pts = [p1, q1, { x: q1.x, y: my }, { x: q2.x, y: my }, q2, p2];
      }
    } else if (!h1 && !h2) {
      if ((q2.y - q1.y) * n1[1] >= 0 && (q1.y - q2.y) * n2[1] >= 0) {
        const my = bend ?? (p1.y + p2.y) / 2;
        pts = [p1, { x: p1.x, y: my }, { x: p2.x, y: my }, p2];
      } else {
        const mx = (p1.x + p2.x) / 2;
        pts = [p1, q1, { x: mx, y: q1.y }, { x: mx, y: q2.y }, q2, p2];
      }
    } else if (h1) {
      const k = { x: p2.x, y: p1.y };
      pts = (k.x - p1.x) * n1[0] >= 0 && (k.y - p2.y) * n2[1] >= 0
        ? [p1, k, p2] : [p1, q1, { x: q1.x, y: q2.y }, q2, p2];
    } else {
      const k = { x: p1.x, y: p2.y };
      pts = (k.y - p1.y) * n1[1] >= 0 && (k.x - p2.x) * n2[0] >= 0
        ? [p1, k, p2] : [p1, q1, { x: q2.x, y: q1.y }, q2, p2];
    }
    // drop duplicate and collinear points
    pts = pts.filter((p, i) => !i || Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) > 0.01);
    return pts.filter((p, i) => {
      if (!i || i === pts.length - 1) return true;
      const a = pts[i - 1], b = pts[i + 1];
      return !((Math.abs(a.x - p.x) < 0.01 && Math.abs(b.x - p.x) < 0.01) || (Math.abs(a.y - p.y) < 0.01 && Math.abs(b.y - p.y) < 0.01));
    });
  }

  // Resolve which side each end of a connector leaves from. Ends attached to an item keep the
  // side chosen when the line was drawn; older lines without one fall back to facing each other.
  function connEnds(c) {
    const A = c.from.id ? byId.get(c.from.id) : null;
    const B = c.to.id ? byId.get(c.to.id) : null;
    if ((c.from.id && !A) || (c.to.id && !B)) return null;
    const aRef = A ? center(A) : c.from, bRef = B ? center(B) : c.to;
    let s1 = A ? (c.from.side || sideToward(A, bRef)) : null;
    let s2 = B ? (c.to.side || sideToward(B, aRef)) : null;
    if (!s1 && !s2) {
      const dx = bRef.x - aRef.x, dy = bRef.y - aRef.y;
      s1 = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'right' : 'left') : (dy >= 0 ? 'bottom' : 'top');
      s2 = OPP[s1];
    } else if (!s1) s1 = OPP[s2];
    else if (!s2) s2 = OPP[s1];
    return {
      s1, s2,
      p1: A ? sidePt(A, s1) : { x: aRef.x, y: aRef.y },
      p2: B ? sidePt(B, s2) : { x: bRef.x, y: bRef.y },
    };
  }

  // Side of `target` to attach to when a line is dropped at p: the edge under the pointer,
  // or the side facing the other end when dropped near the middle.
  function pickSide(target, p, otherPt) {
    const c = center(target);
    if (Math.abs(p.x - c.x) < target.w * 0.25 && Math.abs(p.y - c.y) < target.h * 0.25) return sideToward(target, otherPt);
    return sideToward(target, p);
  }

  // Lines saved before sides were stored: pin each attached end to the side it uses right now,
  // so it never jumps to another side when notes are rearranged.
  function lockSides(list) {
    let changed = false;
    for (const c of list) {
      if (c.type !== 'connector') continue;
      const e = connEnds(c);
      if (!e) continue;
      if (c.from.id && !c.from.side) { c.from.side = e.s1; changed = true; }
      if (c.to.id && !c.to.side) { c.to.side = e.s2; changed = true; }
    }
    return changed;
  }

  function endPoint(c, end) {
    const e = connEnds(c);
    if (e) return end === 'from' ? e.p1 : e.p2;
    const q = c[end];
    return q.id ? center(byId.get(q.id)) : q;
  }

  // Offset that would make connectors between moving and fixed items perfectly straight.
  function straightSnap(moving, tol) {
    let bx = null, by = null;
    for (const c of items) {
      if (c.type !== 'connector') continue;
      const fm = !!(c.from.id && moving.has(c.from.id)), tm = !!(c.to.id && moving.has(c.to.id));
      if (fm === tm) continue;
      const e = connEnds(c);
      if (!e) continue;
      const [pm, sm, po, so] = fm ? [e.p1, e.s1, e.p2, e.s2] : [e.p2, e.s2, e.p1, e.s1];
      const hm = !NORM[sm][1];
      if (hm !== !NORM[so][1]) continue;
      if (hm) { const dy = po.y - pm.y; if (Math.abs(dy) < tol && (by === null || Math.abs(dy) < Math.abs(by))) by = dy; }
      else { const dx = po.x - pm.x; if (Math.abs(dx) < tol && (bx === null || Math.abs(dx) < Math.abs(bx))) bx = dx; }
    }
    return { dx: bx || 0, dy: by || 0 };
  }

  // Lines leaving the same side of the same item share a trunk. Make them all turn at one spot
  // so they branch cleanly: at the corner of a branch that turns straight into its target, if
  // every other branch can turn there too, otherwise halfway to the nearest target.
  // Results that stay valid until the current event or frame finishes. Cleared automatically.
  let memo = null;
  function taskMemo() {
    if (!memo) {
      memo = { bends: new Map(), geoms: new Map(), budget: performance.now() + 14 };
      queueMicrotask(() => { memo = null; });
    }
    return memo;
  }

  function sharedBend(id, side) {
    const mm = taskMemo(), mk = id + '|' + side;
    if (mm.bends.has(mk)) return mm.bends.get(mk);
    const v = computeSharedBend(id, side);
    mm.bends.set(mk, v);
    return v;
  }

  function computeSharedBend(id, side) {
    const G = 24, n = NORM[side], ax = n[1] ? 'y' : 'x', k = n[1] || n[0];
    let P = null, direct = Infinity, corner = Infinity, count = 0;
    for (const c of items) {
      if (c.type !== 'connector') continue;
      let mine, other;
      if (c.from.id === id || c.to.id === id) {
        const e = connEnds(c);
        if (!e) continue;
        if (c.from.id === id && e.s1 === side) { mine = e.p1; other = [e.p2, e.s2]; }
        else if (c.to.id === id && e.s2 === side) { mine = e.p2; other = [e.p1, e.s1]; }
      }
      if (!mine) continue;
      count++;
      P = mine;
      const [O, so] = other;
      const dist = (O[ax] - mine[ax]) * k;
      const sameAxis = !NORM[so][1] === !n[1];
      if (sameAxis && so === OPP[side] && dist >= 2 * G) direct = Math.min(direct, dist);
      else if (!sameAxis && dist >= 0) {
        const no = NORM[so], cross = ax === 'x' ? 'y' : 'x';
        if ((mine[cross] - O[cross]) * (no[1] || no[0]) >= 0) corner = Math.min(corner, dist);
      }
    }
    if (count < 2 || direct === Infinity) return null;
    const d = corner <= direct - G && corner >= G ? corner : direct / 2;
    return P[ax] + k * d;
  }

  // ---- routing around items
  // Lines take their simple shape when it's clear. If that would cross any item (including
  // the two it connects), they're routed around everything instead: a shortest path with
  // few turns over a grid built from the items' edges, keeping a margin from each item.
  const nodeBoxes = () => items.filter(i => i.type !== 'connector');

  // Does any segment of `pts` pass through the inside of an item? (Touching an edge is fine.)
  function routeBlocked(pts, A, B) {
    for (const o of nodeBoxes()) {
      const m = o === A || o === B ? 0 : 6;
      const x0 = o.x - m, y0 = o.y - m, x1 = o.x + o.w + m, y1 = o.y + o.h + m;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        if (Math.abs(a.y - b.y) < 0.01) {
          if (a.y > y0 + 0.01 && a.y < y1 - 0.01 && Math.max(Math.min(a.x, b.x), x0) < Math.min(Math.max(a.x, b.x), x1) - 0.01) return true;
        } else if (a.x > x0 + 0.01 && a.x < x1 - 0.01 && Math.max(Math.min(a.y, b.y), y0) < Math.min(Math.max(a.y, b.y), y1) - 0.01) return true;
      }
    }
    return false;
  }

  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const dirIndex = ([dx, dy]) => DIRS.findIndex(d => d[0] === dx && d[1] === dy);

  function routeAround(p1, n1, p2, n2, margin, reach) {
    const s = { x: p1.x + n1[0] * margin, y: p1.y + n1[1] * margin };
    const t = { x: p2.x + n2[0] * margin, y: p2.y + n2[1] * margin };
    const win = { x0: Math.min(s.x, t.x) - reach, y0: Math.min(s.y, t.y) - reach, x1: Math.max(s.x, t.x) + reach, y1: Math.max(s.y, t.y) + reach };
    const m = margin - 1;
    const obs = nodeBoxes()
      .map(o => ({ x0: o.x - m, y0: o.y - m, x1: o.x + o.w + m, y1: o.y + o.h + m }))
      .filter(o => o.x1 > win.x0 && o.x0 < win.x1 && o.y1 > win.y0 && o.y0 < win.y1);
    const inside = (x, y) => obs.some(o => x > o.x0 + 0.01 && x < o.x1 - 0.01 && y > o.y0 + 0.01 && y < o.y1 - 0.01);
    if (inside(s.x, s.y) || inside(t.x, t.y)) return null;

    const uniq = a => [...new Set(a.map(v => Math.round(v * 100) / 100))].sort((a, b) => a - b);
    const xs = uniq([s.x, t.x, (s.x + t.x) / 2, win.x0, win.x1, ...obs.flatMap(o => [o.x0, o.x1])]);
    const ys = uniq([s.y, t.y, (s.y + t.y) / 2, win.y0, win.y1, ...obs.flatMap(o => [o.y0, o.y1])]);
    const W = xs.length, H = ys.length;
    const ix = v => xs.indexOf(Math.round(v * 100) / 100), iy = v => ys.indexOf(Math.round(v * 100) / 100);
    const si = ix(s.x), sj = iy(s.y), ti = ix(t.x), tj = iy(t.y);
    // Mark grid points and grid edges that fall inside an item (so each step is a lookup).
    const nodeBad = new Uint8Array(W * H), hBad = new Uint8Array(W * H), vBad = new Uint8Array(W * H);
    const lo = (arr, v) => { let a = 0, b = arr.length; while (a < b) { const m2 = (a + b) >> 1; if (arr[m2] <= v + 0.01) a = m2 + 1; else b = m2; } return a; };
    const hi = (arr, v) => { let a = 0, b = arr.length; while (a < b) { const m2 = (a + b) >> 1; if (arr[m2] < v - 0.01) a = m2 + 1; else b = m2; } return a - 1; };
    for (const o of obs) {
      const ia = lo(xs, o.x0), ib = hi(xs, o.x1), ja = lo(ys, o.y0), jb = hi(ys, o.y1);
      for (let j = ja; j <= jb; j++) for (let i = ia; i <= ib; i++) nodeBad[j * W + i] = 1;
      // horizontal edge i→i+1 on row j is inside if both ends are within [x0, x1] and the row is strictly inside
      const ea = lo(xs, o.x0 - 0.02) - 1, eb = hi(xs, o.x1 + 0.02);
      for (let j = ja; j <= jb; j++) for (let i = Math.max(0, ea); i < eb; i++) if (xs[i] >= o.x0 - 0.01 && xs[i + 1] <= o.x1 + 0.01) hBad[j * W + i] = 1;
      const fa = lo(ys, o.y0 - 0.02) - 1, fb = hi(ys, o.y1 + 0.02);
      for (let i = ia; i <= ib; i++) for (let j = Math.max(0, fa); j < fb; j++) if (ys[j] >= o.y0 - 0.01 && ys[j + 1] <= o.y1 + 0.01) vBad[j * W + i] = 1;
    }
    const stepBad = (i, j, ni, nj) => nodeBad[nj * W + ni] ||
      (nj === j ? hBad[j * W + Math.min(i, ni)] : vBad[Math.min(j, nj) * W + i]);
    const BEND = 40;
    const startDir = dirIndex(n1), endDir = dirIndex([-n2[0], -n2[1]]);

    // A* over (grid node, heading). Small binary heap keyed on estimated cost.
    const heap = [], push = (f, st) => {
      heap.push([f, st]);
      for (let i = heap.length - 1; i > 0;) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; }
    }, pop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        for (let i = 0; ;) { const l = 2 * i + 1, r = l + 1; let m2 = i; if (l < heap.length && heap[l][0] < heap[m2][0]) m2 = l; if (r < heap.length && heap[r][0] < heap[m2][0]) m2 = r; if (m2 === i) break; [heap[m2], heap[i]] = [heap[i], heap[m2]]; i = m2; }
      }
      return top;
    };
    const key = (i, j, d) => (j * W + i) * 4 + d;
    const cost = new Map(), prev = new Map();
    const h = (i, j) => Math.abs(xs[i] - t.x) + Math.abs(ys[j] - t.y);
    const k0 = key(si, sj, startDir);
    cost.set(k0, 0);
    push(h(si, sj), k0);
    let found = null, guard = 0;
    while (heap.length && guard++ < 60000) {
      const [, k] = pop();
      const d = k % 4, node = (k - d) / 4, i = node % W, j = (node - i) / W;
      const g = cost.get(k);
      if (i === ti && j === tj) { found = k; break; }
      for (let nd = 0; nd < 4; nd++) {
        if (DIRS[nd][0] === -DIRS[d][0] && DIRS[nd][1] === -DIRS[d][1]) continue; // no U-turns
        const ni = i + DIRS[nd][0], nj = j + DIRS[nd][1];
        if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
        if (stepBad(i, j, ni, nj)) continue;
        const arriving = ni === ti && nj === tj && nd !== endDir ? BEND : 0;
        const ng = g + Math.abs(xs[ni] - xs[i]) + Math.abs(ys[nj] - ys[j]) + (nd === d ? 0 : BEND) + arriving;
        const nk = key(ni, nj, nd);
        if (ng < (cost.get(nk) ?? Infinity)) {
          cost.set(nk, ng);
          prev.set(nk, k);
          push(ng + h(ni, nj), nk);
        }
      }
    }
    if (found === null) return null;
    const path = [];
    for (let k = found; k !== undefined; k = prev.get(k)) {
      const node = (k - (k % 4)) / 4, i = node % W;
      path.push({ x: xs[i], y: ys[(node - i) / W] });
    }
    path.reverse();
    const pts = [p1, ...path, p2].filter((p, i, a) => !i || Math.hypot(p.x - a[i - 1].x, p.y - a[i - 1].y) > 0.01);
    return pts.filter((p, i) => {
      if (!i || i === pts.length - 1) return true;
      const a = pts[i - 1], b = pts[i + 1];
      return !((Math.abs(a.x - p.x) < 0.01 && Math.abs(b.x - p.x) < 0.01) || (Math.abs(a.y - p.y) < 0.01 && Math.abs(b.y - p.y) < 0.01));
    });
  }

  // Hash of the items near a line: the route only needs redoing when one of these changes.
  function areaKey(p1, p2, reach) {
    const x0 = Math.min(p1.x, p2.x) - reach, y0 = Math.min(p1.y, p2.y) - reach;
    const x1 = Math.max(p1.x, p2.x) + reach, y1 = Math.max(p1.y, p2.y) + reach;
    let h = 7;
    for (const o of items) {
      if (o.type === 'connector' || o.x > x1 || o.x + o.w < x0 || o.y > y1 || o.y + o.h < y0) continue;
      h = (h * 31 + o.x * 7 + o.y * 13 + o.w * 17 + o.h * 19) | 0;
    }
    return h;
  }

  const routeCache = new Map();
  function routeFor(c, e) {
    const A = c.from.id ? byId.get(c.from.id) : null, B = c.to.id ? byId.get(c.to.id) : null;
    const bend = (c.from.id && sharedBend(c.from.id, e.s1)) ?? (c.to.id && sharedBend(c.to.id, e.s2)) ?? null;
    const ends = [e.p1.x, e.p1.y, e.s1, e.p2.x, e.p2.y, e.s2, bend, c.startArrow, c.endArrow, c.width].join(',');
    const k = ends + '|' + areaKey(e.p1, e.p2, 420);
    const hit = routeCache.get(c.id);
    if (hit && hit.k === k) return hit.pts;
    const dragging = S.drag && (S.drag.mode === 'move' || S.drag.mode === 'resize');
    // While dragging, lines whose own ends didn't move keep their route until you let go.
    if (dragging && hit && hit.ends === ends) return hit.pts;
    // An arrowhead needs a straight run longer than itself before the line's last (or first) turn.
    const head = 10 + (c.width || 2) * 2 + 6;
    const seg = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const roomy = q => (!c.endArrow || seg(q[q.length - 1], q[q.length - 2]) >= head) && (!c.startArrow || seg(q[0], q[1]) >= head);
    let pts = orthoRoute(e.p1, NORM[e.s1], e.p2, NORM[e.s2], bend), final = true;
    if (routeBlocked(pts, A, B) || !roomy(pts)) {
      if (dragging && performance.now() > taskMemo().budget) final = false; // out of time this frame
      else {
        const alt = [routeAround(e.p1, NORM[e.s1], e.p2, NORM[e.s2], 28, 400), routeAround(e.p1, NORM[e.s1], e.p2, NORM[e.s2], 8, 1200)].filter(Boolean);
        pts = alt.find(roomy) || alt[0] || pts;
      }
    }
    if (routeCache.size > 2000) routeCache.clear();
    routeCache.set(c.id, { k: final ? k : null, ends, pts });
    return pts;
  }

  function geom(c) {
    const mm = taskMemo();
    if (mm.geoms.has(c.id)) return mm.geoms.get(c.id);
    const g = computeGeom(c);
    mm.geoms.set(c.id, g);
    return g;
  }

  function computeGeom(c) {
    const e = connEnds(c);
    if (!e) return null;
    const pts = routeFor(c, e);

    const sw = c.width || 2, trim = (10 + sw * 2) * 0.7;
    const start = pts[0], end = pts[pts.length - 1];
    const endDir = tipDir(pts, true), startDir = tipDir(pts, false);
    const e2 = c.endArrow ? { x: end.x - endDir.x * trim, y: end.y - endDir.y * trim } : end;
    const sTrim = c.startArrow ? { x: start.x - startDir.x * trim, y: start.y - startDir.y * trim } : start;
    const P = p => `${n(p.x)} ${n(p.y)}`;
    const q = pts.slice(); q[0] = sTrim; q[q.length - 1] = e2;
    const d = 'M' + q.map(P).join('L');
    return { d, q, pts, start, end, startDir, endDir, mid: polyMid(pts) };
  }

  function labelBox(c, g) {
    const L = layout(c);
    const w = L.width + 16, h = L.lines.length * L.lh + 8;
    return { x: g.mid.x - w / 2, y: g.mid.y - h / 2, w, h };
  }

  function bbox(it) {
    if (it.type !== 'connector') return { x: it.x, y: it.y, w: it.w, h: it.h };
    const g = geom(it);
    if (!g) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const add = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
    g.pts.forEach(p => add(p.x, p.y));
    if (it.label) { const b = labelBox(it, g); add(b.x, b.y); add(b.x + b.w, b.y + b.h); }
    const m = 8;
    return { x: x0 - m, y: y0 - m, w: x1 - x0 + m * 2, h: y1 - y0 + m * 2 };
  }

  function unionBox(boxes) {
    boxes = boxes.filter(Boolean);
    if (!boxes.length) return null;
    const x0 = Math.min(...boxes.map(b => b.x)), y0 = Math.min(...boxes.map(b => b.y));
    const x1 = Math.max(...boxes.map(b => b.x + b.w)), y1 = Math.max(...boxes.map(b => b.y + b.h));
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  function itemAt(p, exclude) {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.type === 'connector' || it.id === exclude) continue;
      if (p.x >= it.x && p.x <= it.x + it.w && p.y >= it.y && p.y <= it.y + it.h) return it;
    }
    return null;
  }

  // ---------- rendering (the same markup is used for export) ----------
  // Color themes. The board is always dark; exports can also be drawn light so lines and text
  // stay legible on white pages. `map` swaps line/text colors for versions that read on that theme.
  const THEMES = {
    dark: { bg: BG, shapeFill: SHAPE_FILL, shadow: 0.35, map: {} },
    light: {
      bg: '#ffffff', shapeFill: '#ffffff', shadow: 0.08,
      map: { [INK]: NOTE_INK, '#ff6b70': '#e5484d', '#ffa057': '#f76b15', '#4cc38a': '#30a46c', '#6ea8ff': '#0b6cff', '#b994f5': '#8e4ec6' },
    },
  };
  const inkFor = (c, pal) => { c = c || INK; return pal.map[c] || c; };
  const fillFor = (f, pal) => { f = f || SHAPE_FILL; return f === SHAPE_FILL ? pal.shapeFill : f; };

  function shapeInk(it, pal = THEMES.dark) {
    const f = fillFor(it.fill, pal);
    if (f === 'none' || !/^#[0-9a-f]{6}$/i.test(f)) return inkFor(INK, pal);
    const [r, g, b] = [1, 3, 5].map(i => parseInt(f.slice(i, i + 2), 16));
    return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? NOTE_INK : INK;
  }

  const isDark = c => {
    if (!/^#[0-9a-f]{6}$/i.test(c)) return false;
    const [r, g, b] = [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
    return 0.299 * r + 0.587 * g + 0.114 * b < 128;
  };

  function textMarkup(L, box, color, ff, forExport = false) {
    const blockH = L.lines.length * L.lh;
    const start = L.align === 'start';
    const top = start ? box.y + L.pad : box.y + (box.h - blockH) / 2;
    const x = start ? box.x + L.pad : box.x + box.w / 2;
    const linkColor = isDark(color) ? '#0b57d0' : '#8ab4ff';
    let s = `<text font-family="${ff}" font-size="${n(L.size)}" fill="${color}" text-anchor="${start ? 'start' : 'middle'}">`;
    let link = -1, inLink = false, bold = false; // link state carries across wrapped lines
    L.lines.forEach((ln, i) => {
      const segs = [];
      let cur = '';
      for (const ch of ln) {
        if (ch !== LINK_START && ch !== LINK_END && ch !== BOLD_START && ch !== BOLD_END) { cur += ch; continue; }
        if (cur) segs.push([cur, inLink ? link : -1, bold]);
        cur = '';
        if (ch === LINK_START) { link++; inLink = true; }
        else if (ch === LINK_END) inLink = false;
        else bold = ch === BOLD_START;
      }
      if (cur) segs.push([cur, inLink ? link : -1, bold]);
      const y = top + i * L.lh + L.lh / 2 + L.size * 0.35;
      segs.forEach(([t, k, b], j) => {
        const pos = j ? '' : ` x="${n(x)}" y="${n(y)}"`;
        const style = (b ? ' font-weight="bold"' : '') +
          (k < 0 ? '' : ` fill="${linkColor}" text-decoration="underline"${forExport ? '' : ` data-href="${esc(L.links[k] || '')}"`}`);
        s += `<tspan${pos}${style}>${esc(t)}</tspan>`;
      });
    });
    return s + '</text>';
  }

  // PDFs only have fonts for basic Latin text, so text with other characters (math symbols,
  // emoji, most non-Latin scripts) is exported to PDF as a high-resolution image instead.
  const NEEDS_RASTER = /[^\u0000-\u00ff\u2013\u2014\u2018\u2019\u201c\u201d\u2022\u2026\u20ac\u2122\uE000\uE001]/;
  function textOrImage(it, L, box, color, ff, o) {
    const img = o.textImgs && o.textImgs.get(it.id);
    if (img) return `<image xlink:href="${img}" x="${n(box.x)}" y="${n(box.y)}" width="${n(box.w)}" height="${n(box.h)}" preserveAspectRatio="none"/>`;
    return textMarkup(L, box, color, ff, o.forExport);
  }

  // Horizontal segments hop over vertical segments of other lines where they cross.
  const HOP = 8;
  function verticalSegments(list) {
    const out = [];
    for (const it of list) {
      if (it.type !== 'connector') continue;
      const g = geom(it);
      if (!g) continue;
      for (let i = 1; i < g.q.length; i++) {
        const a = g.q[i - 1], b = g.q[i];
        if (Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) > 0.01) out.push({ id: it.id, x: a.x, y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y) });
      }
    }
    return out;
  }

  function hopPath(q, verts, ownId) {
    const P = p => `${n(p.x)} ${n(p.y)}`;
    let d = 'M' + P(q[0]);
    for (let i = 1; i < q.length; i++) {
      const a = q[i - 1], b = q[i];
      if (Math.abs(a.y - b.y) < 0.01 && Math.abs(a.x - b.x) > HOP * 2) {
        const dir = Math.sign(b.x - a.x), lo = Math.min(a.x, b.x), hi = Math.max(a.x, b.x);
        const xs = verts
          .filter(v => v.id !== ownId && v.x > lo + HOP && v.x < hi - HOP && a.y > v.y0 + HOP / 2 && a.y < v.y1 - HOP / 2)
          .map(v => v.x)
          .sort((m, k) => (m - k) * dir);
        let prev = null;
        for (const x of xs) {
          if (prev !== null && Math.abs(x - prev) < HOP * 2.5) continue;
          d += `L${n(x - dir * HOP)} ${n(a.y)}A${HOP} ${HOP} 0 0 ${dir > 0 ? 1 : 0} ${n(x + dir * HOP)} ${n(a.y)}`;
          prev = x;
        }
      }
      d += 'L' + P(b);
    }
    return d;
  }

  function arrowMarkup(tip, u, color, sw) {
    const L = 10 + sw * 2, W = 5 + sw;
    const bx = tip.x - u.x * L, by = tip.y - u.y * L;
    return `<path d="M${n(tip.x)} ${n(tip.y)}L${n(bx - u.y * W)} ${n(by + u.x * W)}L${n(bx + u.y * W)} ${n(by - u.x * W)}Z" fill="${color}" stroke="${color}" stroke-width="1" stroke-linejoin="round"/>`;
  }

  function itemMarkup(it, o) {
    const ff = o.font || FONT;
    const attr = o.forExport ? '' : ` data-id="${it.id}"`;
    const showText = o.editing !== it.id;
    const pal = o.pal || THEMES.dark;
    const R = (x, y, w, h) => `x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}"`;
    switch (it.type) {
      case 'sticky': {
        let s = `<g${attr}><rect ${R(it.x, it.y + 4, it.w, it.h)} rx="3" fill="#000" fill-opacity="${pal.shadow}"/>`;
        s += `<rect ${R(it.x, it.y, it.w, it.h)} rx="3" fill="${it.color}"/>`;
        if (showText && it.text) s += textOrImage(it, layout(it), it, NOTE_INK, ff, o);
        return s + '</g>';
      }
      case 'shape': {
        const fill = fillFor(it.fill, pal);
        const fillAttr = fill === 'none' ? (o.forExport ? 'fill="none"' : 'fill="#fff" fill-opacity="0"') : `fill="${fill}"`;
        const stroke = `stroke="${inkFor(it.stroke, pal)}" stroke-width="2"`;
        let s = `<g${attr}>`;
        const [body, detail] = shapePaths(it.shape, it.x, it.y, it.w, it.h);
        s += `<path d="${body}" ${fillAttr} ${stroke} stroke-linejoin="round"/>`;
        if (detail) s += `<path d="${detail}" fill="none" ${stroke}/>`;
        if (showText && it.text) s += textOrImage(it, layout(it), it, shapeInk(it, pal), ff, o);
        return s + '</g>';
      }
      case 'symbol': {
        let s = `<g${attr}>`;
        if (!o.forExport) s += `<rect ${R(it.x, it.y, it.w, it.h)} fill="#fff" fill-opacity="0"/>`;
        s += `<g transform="translate(${n(it.x)} ${n(it.y)}) scale(${n(it.w / 24 * 1000) / 1000} ${n(it.h / 24 * 1000) / 1000})" fill="none" stroke="${inkFor(it.color, pal)}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${iconMarkup(it.nodes)}</g>`;
        return s + '</g>';
      }
      case 'image': {
        const src = o.imgs ? o.imgs.get(it.img) : imageEntry(it.img)?.url;
        const R4 = R(it.x, it.y, it.w, it.h);
        if (!src) {
          if (!o.imgs) loadImage(it.img);
          const missing = imageEntry(it.img)?.missing;
          return `<g${attr}><rect ${R4} rx="4" fill="#262a33" stroke="#3a3f4b"/>` +
            (missing ? `<text x="${n(it.x + it.w / 2)}" y="${n(it.y + it.h / 2)}" font-family="${ff}" font-size="14" fill="#8b8d98" text-anchor="middle">Image missing</text>` : '') + '</g>';
        }
        return `<g${attr}><image ${o.imgs ? 'xlink:href' : 'href'}="${src}" ${R4} preserveAspectRatio="none"/></g>`;
      }
      case 'text': {
        let s = `<g${attr}>`;
        if (!o.forExport) s += `<rect ${R(it.x, it.y, it.w, it.h)} fill="#fff" fill-opacity="0"/>`;
        if (showText) s += textOrImage(it, layout(it), it, inkFor(it.color, pal), ff, o);
        return s + '</g>';
      }
      case 'connector': {
        const g = geom(it);
        if (!g) return '';
        const color = inkFor(it.color, pal), sw = it.width || 2;
        let s = `<g${attr}>`;
        if (!o.forExport) s += `<path d="${g.d}" fill="none" stroke="#000" stroke-opacity="0" stroke-width="16"/>`;
        const d = o.verts ? hopPath(g.q, o.verts, it.id) : g.d;
        // On screen, lines never get thinner than a pixel and are pixel-aligned, so they all look the same weight when zoomed out.
        const screen = o.forExport ? '' : ` class="line" style="--sw:${sw}"`;
        s += `<path d="${d}" fill="none" stroke="${color}" stroke-width="${sw}"${screen} stroke-linecap="round" stroke-linejoin="round"/>`;
        if (it.endArrow) s += arrowMarkup(g.end, g.endDir, color, sw);
        if (it.startArrow) s += arrowMarkup(g.start, g.startDir, color, sw);
        if (it.label && showText) {
          const b = labelBox(it, g);
          s += `<rect ${R(b.x, b.y, b.w, b.h)} rx="4" fill="${pal.bg}"/>` + textOrImage(it, layout(it), b, color, ff, o);
        }
        return s + '</g>';
      }
    }
    return '';
  }

  function textSpec(it, pal) {
    const text = it.type === 'connector' ? it.label : it.text;
    if (!text) return null;
    if (it.type === 'sticky') return { box: it, color: NOTE_INK };
    if (it.type === 'shape') return { box: it, color: shapeInk(it, pal) };
    if (it.type === 'text') return { box: it, color: inkFor(it.color, pal) };
    if (it.type === 'connector') { const g = geom(it); return g && { box: labelBox(it, g), color: inkFor(it.color, pal) }; }
    return null;
  }

  async function rasterizeTexts(list, pal) {
    const out = new Map();
    for (const it of list) {
      const text = it.type === 'connector' ? it.label : it.text;
      if (!text || !NEEDS_RASTER.test(text)) continue;
      const spec = textSpec(it, pal);
      if (!spec) continue;
      const { box, color } = spec, k = 4;
      const svgText = `<svg xmlns="http://www.w3.org/2000/svg" width="${n(box.w * k)}" height="${n(box.h * k)}" viewBox="${n(box.x)} ${n(box.y)} ${n(box.w)} ${n(box.h)}">${textMarkup(layout(it), box, color, FONT, true)}</svg>`;
      const url = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' }));
      try {
        const img = new Image();
        img.src = url;
        // never let one stuck image hold up the export; that text just stays as plain text
        await Promise.race([img.decode(), new Promise((_, rej) => setTimeout(() => rej(new Error('decode timeout')), 4000))]);
        const cv = document.createElement('canvas');
        cv.width = Math.ceil(box.w * k); cv.height = Math.ceil(box.h * k);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        out.set(it.id, cv.toDataURL('image/png'));
      } catch (err) { console.error(err); } finally { URL.revokeObjectURL(url); }
    }
    return out;
  }

  function sceneMarkup(list, o = {}) {
    o = { ...o, verts: verticalSegments(list) };
    let lines = '', rest = '';
    for (const it of list) {
      if (it.type === 'connector') lines += itemMarkup(it, o);
      else rest += itemMarkup(it, o);
    }
    return lines + rest;
  }

  let raf = 0, sceneDirty = true;
  function render(scene = true) {
    sceneDirty = sceneDirty || scene;
    if (!raf) raf = requestAnimationFrame(draw);
  }

  function draw() {
    raf = 0;
    const t = `translate(${n(view.x)} ${n(view.y)}) scale(${view.z})`;
    world.setAttribute('transform', t);
    world.style.setProperty('--z', view.z);
    world.classList.toggle('far', view.z < 0.6);
    overlay.setAttribute('transform', t);
    dotPattern.setAttribute('patternTransform', t);
    dot.setAttribute('r', n(1.1 / view.z));
    grid.style.display = view.z < 0.3 ? 'none' : '';
    if (sceneDirty) { world.innerHTML = sceneMarkup(items, { editing: S.editing }); sceneDirty = false; }
    drawOverlay();
    positionEditor();
    drawCtx();
    $('#zoomLabel').textContent = Math.round(view.z * 100) + '%';
    $('#emptyHint').hidden = items.length > 0;
    $('#undoBtn').disabled = !undoStack.length;
    $('#redoBtn').disabled = !redoStack.length;
  }

  function drawOverlay() {
    const z = view.z, px = 1 / z;
    const outline = (b, w, op = 1, dash = '') =>
      `<rect x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}" fill="none" stroke="${ACCENT}" stroke-opacity="${op}" stroke-width="${n(w * px)}"${dash ? ` stroke-dasharray="${n(4 * px)} ${n(4 * px)}"` : ''} pointer-events="none"/>`;
    const circle = (p, attrs) => `<circle cx="${n(p.x)}" cy="${n(p.y)}" r="${n(6 * px)}" fill="#fff" stroke="${ACCENT}" stroke-width="${n(1.75 * px)}" ${attrs}/>`;
    let s = '';
    const d = S.drag;
    const sel = selected();

    if (S.search) {
      S.search.matches.forEach((id, i) => {
        const it = byId.get(id), b = it && bbox(it);
        if (!b) return;
        const cur = i === S.search.i, m = (cur ? 6 : 3) * px;
        s += outline({ x: b.x - m, y: b.y - m, w: b.w + m * 2, h: b.h + m * 2 }, cur ? 3 : 1.5, cur ? 1 : 0.55);
      });
    }
    if (S.hover && !S.sel.has(S.hover) && !d) {
      const h = byId.get(S.hover);
      if (h) s += outline(h, 1.5, 0.5);
    }
    if (d && d.target) {
      const t = byId.get(d.target);
      if (t) s += outline({ x: t.x - 3 * px, y: t.y - 3 * px, w: t.w + 6 * px, h: t.h + 6 * px }, 2.5);
    }
    for (const it of sel) {
      if (it.type === 'connector') {
        const g = geom(it);
        if (!g) continue;
        s += `<path d="${g.d}" fill="none" stroke="${ACCENT}" stroke-opacity=".3" stroke-width="${n((it.width || 2) + 6 * px)}" pointer-events="none"/>`;
        if (sel.length === 1 && !d) {
          s += circle(g.start, `data-handle="from" data-hid="${it.id}"`);
          s += circle(g.end, `data-handle="to" data-hid="${it.id}"`);
        }
      } else if (S.editing !== it.id || it.type === 'text') {
        s += outline(it, 1.5);
      }
    }
    if (sel.length === 1 && sel[0].type !== 'connector' && !S.editing && (!d || d.mode === 'resize')) {
      const it = sel[0], hs = 9 * px;
      const handles = { nw: [it.x, it.y], ne: [it.x + it.w, it.y], sw: [it.x, it.y + it.h], se: [it.x + it.w, it.y + it.h] };
      if (it.type === 'text') { handles.w = [it.x, it.y + it.h / 2]; handles.e = [it.x + it.w, it.y + it.h / 2]; }
      for (const [k, [x, y]] of Object.entries(handles)) {
        s += `<rect data-handle="${k}" data-hid="${it.id}" x="${n(x - hs / 2)}" y="${n(y - hs / 2)}" width="${n(hs)}" height="${n(hs)}" rx="${n(2 * px)}" fill="#fff" stroke="${ACCENT}" stroke-width="${n(1.5 * px)}"/>`;
      }
    }
    if (sel.length > 1 && (!d || d.mode === 'marquee')) {
      const b = unionBox(sel.map(bbox));
      if (b) s += outline({ x: b.x - 6 * px, y: b.y - 6 * px, w: b.w + 12 * px, h: b.h + 12 * px }, 1, 0.8, true);
    }
    if (S.hover && !d && !S.editing && (S.tool === 'select' || S.tool === 'connector')) {
      const it = byId.get(S.hover);
      if (it) for (const side of Object.keys(NORM)) s += circle(sidePt(it, side, 16 * px), `data-anchor="${side}" data-for="${it.id}"`);
    }
    if (d && d.mode === 'marquee') {
      const b = rectFrom(d.start, d.cur);
      s += `<rect x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}" fill="${ACCENT}" fill-opacity=".08" stroke="${ACCENT}" stroke-width="${n(px)}" pointer-events="none"/>`;
    }
    overlay.innerHTML = s;
  }

  const rectFrom = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });

  // ---------- history & persistence ----------
  function commit() {
    const now = JSON.stringify(items);
    if (now === snapshot) return;
    undoStack.push(snapshot);
    if (undoStack.length > 300) undoStack.shift();
    redoStack = [];
    snapshot = now;
    save();
    markDirty(board.id);
    render();
  }

  function restore(json) {
    items = JSON.parse(json);
    board.items = items;
    reindex();
    S.sel = new Set([...S.sel].filter(id => byId.has(id)));
    snapshot = json;
    save();
    markDirty(board.id);
    render();
  }

  function undo() {
    commitEdit();
    if (!undoStack.length) return;
    redoStack.push(snapshot);
    restore(undoStack.pop());
  }

  function redo() {
    commitEdit();
    if (!redoStack.length) return;
    undoStack.push(snapshot);
    restore(redoStack.pop());
  }

  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 300);
  }

  function flushSave() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!board) return;
    board.items = items;
    board.view = { ...view };
    board.updatedAt = Date.now();
    if (!store.set(boardKey(board.id), board)) toast('Couldn’t save — browser storage may be full. Export to JSON!');
    const idx = store.get(INDEX_KEY, []);
    const e = idx.find(b => b.id === board.id);
    if (e) { e.name = board.name; e.updatedAt = board.updatedAt; store.set(INDEX_KEY, idx); }
  }

  // ---------- boards ----------
  // `seed` boards (the welcome board) aren't synced until you change them, so every new
  // device doesn't add another copy to your account.
  function createBoard(name, list = [], { seed = false } = {}) {
    const b = { id: uid(), name: name || 'Untitled board', items: list, view: null, createdAt: Date.now(), updatedAt: Date.now() };
    store.set(boardKey(b.id), b);
    const idx = store.get(INDEX_KEY, []);
    idx.unshift({ id: b.id, name: b.name, updatedAt: b.updatedAt, dirty: !seed, ...(seed && { seed: true }) });
    store.set(INDEX_KEY, idx);
    if (!seed) scheduleSync();
    return b;
  }

  function openBoard(id) {
    commitEdit();
    if (board) flushSave();
    const b = store.get(boardKey(id));
    if (!b) { toast('That board couldn’t be loaded'); return; }
    board = b;
    items = Array.isArray(b.items) ? b.items : [];
    board.items = items;
    reindex();
    items.forEach(syncTextHeight);
    const migrated = lockSides(items);
    S.sel.clear(); S.hover = null; S.drag = null;
    if (!searchBar.hidden) closeSearch(false);
    undoStack = []; redoStack = []; snapshot = JSON.stringify(items);
    if (migrated) { save(); markDirty(id); }
    $('#boardName').value = b.name;
    document.title = `${b.name} · Tack`;
    store.set(LAST_KEY, id);
    if (b.view && isFinite(b.view.z)) Object.assign(view, b.view);
    else if (items.length) fitView(false);
    else Object.assign(view, { x: innerWidth / 2, y: innerHeight / 2, z: 1 });
    render();
    renderSidebar();
  }

  function deleteBoard(id, { remote = true } = {}) {
    const entry = store.get(INDEX_KEY, []).find(b => b.id === id);
    if (remote && entry && entry.rv) {
      const pending = store.get(DELETES_KEY, []);
      if (!pending.includes(id)) store.set(DELETES_KEY, [...pending, id]);
      scheduleSync(0);
    }
    const idx = store.get(INDEX_KEY, []).filter(b => b.id !== id);
    store.set(INDEX_KEY, idx);
    store.del(boardKey(id));
    if (board && board.id === id) {
      board = null;
      if (idx.length) openBoard(idx[0].id);
      else openBoard(createBoard('Untitled board').id);
    }
    renderSidebar();
  }

  const ICON = {
    copy: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3"/></svg>',
    front: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2" fill="currentColor" fill-opacity=".15"/><path d="M15 9V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7a2 2 0 002 2h3"/></svg>',
    back: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="11" height="11" rx="2" fill="currentColor" fill-opacity=".15"/><path d="M9 15v3a2 2 0 002 2h7a2 2 0 002-2v-7a2 2 0 00-2-2h-3"/></svg>',
    none: '<svg viewBox="0 0 24 24"><path d="M4 12h16"/></svg>',
    end: '<svg viewBox="0 0 24 24"><path d="M4 12h15M14 7l5 5-5 5"/></svg>',
    both: '<svg viewBox="0 0 24 24"><path d="M5 12h14M10 7l-5 5 5 5M14 7l5 5-5 5"/></svg>',
    rect: '<svg viewBox="0 0 24 24"><rect x="4" y="6" width="16" height="12" rx="2"/></svg>',
    ellipse: '<svg viewBox="0 0 24 24"><ellipse cx="12" cy="12" rx="8" ry="6"/></svg>',
  };

  function timeAgo(t) {
    const s = (Date.now() - t) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    if (s < 86400 * 7) return Math.floor(s / 86400) + ' d ago';
    return new Date(t).toLocaleDateString();
  }

  function renderSidebar() {
    const idx = store.get(INDEX_KEY, []).sort((a, b) => b.updatedAt - a.updatedAt);
    $('#boardList').innerHTML = idx.map(b => `
      <li class="${board && b.id === board.id ? 'active' : ''}" data-bid="${b.id}">
        <button class="open" data-act="open"><b>${esc(b.name || 'Untitled board')}</b><small>Edited ${timeAgo(b.updatedAt)}</small></button>
        <button class="icon" data-act="dup" title="Duplicate board" aria-label="Duplicate board">${ICON.copy}</button>
        <button class="icon" data-act="del" title="Delete board" aria-label="Delete board">${ICON.trash}</button>
      </li>`).join('');
  }

  function toggleSidebar(open) {
    $('#sidebar').classList.toggle('open', open);
    $('#scrim').hidden = !open;
    if (open) { flushSave(); renderSidebar(); }
  }

  // ---------- item operations ----------
  function createItem(kind, p) {
    let it;
    if (kind === 'sticky') it = { type: 'sticky', w: S.lastStickySize, h: S.lastStickySize, color: S.lastSticky, text: '' };
    else if (kind === 'text') it = { type: 'text', w: 320, h: 40, fontSize: 24, text: '' };
    else it = { type: 'shape', shape: kind, w: SHAPES[kind].w, h: SHAPES[kind].h, fill: SHAPE_FILL, text: '' };
    it.id = uid();
    syncTextHeight(it);
    it.x = Math.round(p.x - it.w / 2);
    it.y = Math.round(p.y - it.h / 2);
    items.push(it);
    byId.set(it.id, it);
    return it;
  }

  function removeItems(ids) {
    const kill = new Set(ids);
    for (const it of items) {
      if (it.type === 'connector' && (kill.has(it.from.id) || kill.has(it.to.id))) kill.add(it.id);
    }
    items = items.filter(i => !kill.has(i.id));
    board.items = items;
    reindex();
    kill.forEach(id => S.sel.delete(id));
    if (kill.has(S.hover)) S.hover = null;
  }

  // Selected items plus any connectors that only touch them — what copy/duplicate/export-selection use.
  function collect(ids) {
    const set = new Set(ids);
    const nodes = items.filter(i => set.has(i.id) && i.type !== 'connector');
    const nodeIds = new Set(nodes.map(i => i.id));
    const ok = e => !e.id || nodeIds.has(e.id);
    const lines = items.filter(i => i.type === 'connector' && ok(i.from) && ok(i.to) &&
      (set.has(i.id) || (i.from.id && i.to.id)));
    return [...lines, ...nodes];
  }

  function insertClones(list, dx, dy) {
    const map = new Map(list.map(i => [i.id, uid()]));
    const out = list.map(src => {
      const it = JSON.parse(JSON.stringify(src));
      it.id = map.get(src.id);
      if (it.type === 'connector') {
        for (const end of ['from', 'to']) {
          if (it[end].id) it[end].id = map.get(it[end].id);
          else { it[end].x += dx; it[end].y += dy; }
        }
      } else { it.x += dx; it.y += dy; }
      return it;
    });
    out.forEach(it => { items.push(it); byId.set(it.id, it); });
    lockSides(out);
    return out.map(i => i.id);
  }

  function duplicateSelection(dx = 24, dy = 24) {
    const list = collect(S.sel);
    if (!list.length) return [];
    const ids = insertClones(list, dx, dy);
    S.sel = new Set(ids);
    return ids;
  }

  function reorder(front) {
    const sel = items.filter(i => S.sel.has(i.id)), rest = items.filter(i => !S.sel.has(i.id));
    items = front ? [...rest, ...sel] : [...sel, ...rest];
    board.items = items;
  }

  function addSibling(src, dir) {
    if (!src || src.type === 'connector') return;
    const w = src.type === 'sticky' ? src.w : 200, h = src.type === 'sticky' ? src.h : 200;
    const gap = 100;
    let x = dir === 'down' ? src.x + (src.w - w) / 2 : src.x + src.w + gap;
    let y = dir === 'down' ? src.y + src.h + gap : src.y + (src.h - h) / 2;
    const overlaps = (x, y) => items.some(i => i.type !== 'connector' && x < i.x + i.w && x + w > i.x && y < i.y + i.h && y + h > i.y);
    for (let k = 0; k < 40 && overlaps(x, y); k++) {
      if (dir === 'down') x += w + 40; else y += h + 40;
    }
    const it = createItem('sticky', { x: x + w / 2, y: y + h / 2 });
    it.w = w; it.h = h; it.x = x; it.y = y;
    if (src.type === 'sticky') it.color = src.color;
    const c = {
      id: uid(), type: 'connector', endArrow: true,
      from: { id: src.id, side: dir === 'down' ? 'bottom' : 'right' },
      to: { id: it.id, side: dir === 'down' ? 'top' : 'left' },
    };
    items.push(c); byId.set(c.id, c);
    commit();
    ensureVisible(it);
    startEdit(it.id);
  }

  function ensureVisible(it) {
    const m = 60;
    const sx = it.x * view.z + view.x, sy = it.y * view.z + view.y;
    const ex = (it.x + it.w) * view.z + view.x, ey = (it.y + it.h) * view.z + view.y;
    if (ex > innerWidth - m) view.x -= ex - innerWidth + m;
    if (sx < m + 60) view.x += m + 60 - sx;
    if (ey > innerHeight - m) view.y -= ey - innerHeight + m;
    if (sy < m + 20) view.y += m + 20 - sy;
  }

  // ---------- text editing ----------
  function startEdit(id) {
    const it = byId.get(id);
    if (!it || it.type === 'image' || it.type === 'symbol') return;
    if (S.editing && S.editing !== id) commitEdit();
    S.editing = id;
    S.sel = new Set([id]);
    S.hover = null;
    editor.value = it.type === 'connector' ? (it.label || '') : (it.text || '');
    editor.dataset.kind = it.type;
    editor.hidden = false;
    render();
    draw();
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
  }

  function commitEdit() {
    if (!S.editing) return;
    const id = S.editing;
    S.editing = null;
    editor.hidden = true;
    if (document.activeElement === editor) editor.blur();
    const it = byId.get(id);
    if (it && it.type === 'text' && !it.text.trim()) removeItems([id]);
    if (it && it.type === 'connector') it.label = (it.label || '').trim();
    commit();
    render();
  }

  function positionEditor() {
    if (!S.editing) return;
    const it = byId.get(S.editing);
    if (!it) { S.editing = null; editor.hidden = true; return; }
    const z = view.z, st = editor.style;
    let L, box;
    if (it.type === 'connector') {
      const g = geom(it);
      if (!g) return;
      L = layout(it);
      const h = Math.max(1, L.lines.length) * L.lh + 8;
      box = { x: g.mid.x - (LABEL_WRAP + 16) / 2, y: g.mid.y - h / 2, w: LABEL_WRAP + 16, h };
    } else {
      L = layout(it);
      box = it;
    }
    const lines = Math.max(1, L.lines.length);
    const top = L.align === 'start' ? L.pad : it.type === 'connector' ? 4 : Math.max(0, (box.h - lines * L.lh) / 2);
    st.left = n(box.x * z + view.x) + 'px';
    st.top = n(box.y * z + view.y) + 'px';
    st.width = n(box.w * z) + 'px';
    st.height = n(box.h * z) + 'px';
    st.fontSize = n(L.size * z) + 'px';
    st.lineHeight = n(L.lh * z) + 'px';
    st.textAlign = L.align === 'start' ? 'left' : 'center';
    st.padding = `${n(top * z)}px ${n(L.pad * z)}px 0`;
    st.color = it.type === 'sticky' ? NOTE_INK : it.type === 'shape' ? shapeInk(it) : (it.color || INK);
  }

  editor.addEventListener('input', () => {
    const it = byId.get(S.editing);
    if (!it) return;
    if (it.type === 'connector') it.label = editor.value;
    else it.text = editor.value;
    syncTextHeight(it);
    render();
  });

  editor.addEventListener('keydown', e => {
    e.stopPropagation();
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      const { selectionStart: a, selectionEnd: b, value: v } = editor;
      const before = v.slice(0, a), sel = v.slice(a, b), after = v.slice(b);
      if (before.endsWith('**') && after.startsWith('**')) {
        editor.value = before.slice(0, -2) + sel + after.slice(2);
        editor.setSelectionRange(a - 2, b - 2);
      } else {
        editor.value = before + '**' + sel + '**' + after;
        editor.setSelectionRange(a + 2, b + 2);
      }
      editor.dispatchEvent(new Event('input'));
      return;
    }
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
      e.preventDefault();
      commitEdit();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const id = S.editing;
      commitEdit();
      if (byId.has(id)) addSibling(byId.get(id), e.shiftKey ? 'down' : 'right');
    }
  });
  editor.addEventListener('blur', () => commitEdit());

  // ---------- context toolbar ----------
  let ctxSig = '';
  function drawCtx() {
    const sel = selected();
    const busy = S.drag && S.drag.mode !== 'pan';
    if (!sel.length || busy || (S.editing && byId.get(S.editing)?.type === 'connector')) { ctxEl.hidden = true; ctxSig = ''; return; }
    const sig = sel.map(i => [i.id, i.w, i.color, i.fill, i.shape, i.endArrow, i.startArrow, i.fontSize].join(':')).join('|');
    if (sig !== ctxSig) { ctxSig = sig; ctxEl.innerHTML = buildCtx(sel); }
    ctxEl.hidden = false;
    const b = unionBox(sel.map(bbox));
    if (!b) { ctxEl.hidden = true; return; }
    const r = ctxEl.getBoundingClientRect();
    const cx = (b.x + b.w / 2) * view.z + view.x;
    let top = b.y * view.z + view.y - r.height - 34;
    if (top < 64) top = (b.y + b.h) * view.z + view.y + 34;
    ctxEl.style.left = n(clamp(cx - r.width / 2, 8, innerWidth - r.width - 8)) + 'px';
    ctxEl.style.top = n(clamp(top, 64, innerHeight - r.height - 64)) + 'px';
  }

  function buildCtx(sel) {
    const types = new Set(sel.map(i => i.type));
    const first = t => sel.find(i => i.type === t);
    const groups = [];
    const btn = (act, val, inner, on, title, cls = '') =>
      `<button class="${cls}${on ? ' on' : ''}" data-act="${act}" data-val="${val}" title="${title}" aria-label="${title}">${inner}</button>`;
    const sw = (act, c, on) => `<button class="sw${c === 'none' ? ' none' : ''}${on ? ' on' : ''}" style="background:${c}" data-act="${act}" data-val="${c}" title="${c === 'none' ? 'No fill' : c}" aria-label="Color ${c}"></button>`;
    const grp = a => `<div class="grp">${a.join('')}</div>`;

    if (types.has('sticky') || types.has('shape')) {
      const cur = first('sticky')?.color ?? first('shape')?.fill;
      const pal = types.has('sticky') ? STICKY_COLORS : SHAPE_FILLS;
      groups.push(grp(pal.map(c => sw('fill', c, c === cur))));
    }
    if (types.has('sticky')) {
      const st = first('sticky');
      groups.push(grp(STICKY_SIZES.map(([l, v]) => btn('stickySize', v, l, st.w === v && st.h === v, `Note size ${l}`, 'txt'))));
    }
    if (types.has('shape')) {
      const cur = first('shape').shape;
      groups.push(grp(Object.keys(SHAPES).map(k => btn('shape', k, shapeIcon(k), cur === k, SHAPES[k].label))));
    }
    if (types.has('text')) {
      const cur = first('text');
      groups.push(grp(TEXT_SIZES.map(([l, v]) => btn('fontSize', v, l, cur.fontSize === v, `Text size ${l}`, 'txt'))));
      groups.push(grp(INK_COLORS.slice(0, 5).map(c => sw('ink', c, (cur.color || INK) === c))));
    }
    if (types.has('symbol') && !types.has('text')) {
      const cur = first('symbol');
      groups.push(grp(INK_COLORS.slice(0, 5).map(c => sw('ink', c, (cur.color || INK) === c))));
    }
    if (types.has('connector')) {
      const c = first('connector');
      const arrows = c.startArrow ? 'both' : c.endArrow ? 'end' : 'none';
      groups.push(grp(['none', 'end', 'both'].map(k => btn('arrows', k, ICON[k], arrows === k, { none: 'No arrows', end: 'Arrow at end', both: 'Arrows at both ends' }[k]))));
      groups.push(grp(INK_COLORS.slice(0, 5).map(col => sw('line', col, (c.color || INK) === col))));
    }
    groups.push(grp([
      btn('front', '', ICON.front, false, 'Bring to front'),
      btn('back', '', ICON.back, false, 'Send to back'),
      btn('delete', '', ICON.trash, false, 'Delete'),
    ]));
    return groups.join('<span class="sep"></span>');
  }

  ctxEl.addEventListener('pointerdown', e => e.preventDefault()); // keep the text editor focused
  ctxEl.addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const { act, val } = b.dataset;
    const sel = selected();
    for (const it of sel) {
      if (act === 'fill' && it.type === 'sticky' && val !== 'none') { it.color = val; S.lastSticky = val; }
      if (act === 'fill' && it.type === 'shape') it.fill = val;
      if (act === 'shape' && it.type === 'shape') it.shape = val;
      if (act === 'stickySize' && it.type === 'sticky') {
        const c = center(it);
        it.w = it.h = +val;
        it.x = Math.round(c.x - it.w / 2);
        it.y = Math.round(c.y - it.h / 2);
        S.lastStickySize = +val;
      }
      if (act === 'fontSize' && it.type === 'text') { it.fontSize = +val; syncTextHeight(it); }
      if (act === 'ink' && (it.type === 'text' || it.type === 'symbol')) it.color = val;
      if (act === 'arrows' && it.type === 'connector') { it.endArrow = val !== 'none'; it.startArrow = val === 'both'; }
      if (act === 'line' && it.type === 'connector') it.color = val;
    }
    if (act === 'front' || act === 'back') reorder(act === 'front');
    drawPicker();
    if (act === 'delete') { commitEdit(); removeItems([...S.sel]); }
    commit();
    render();
  });

  // ---------- pointer interaction ----------
  function toWorld(e) {
    const r = svg.getBoundingClientRect();
    return { x: (e.clientX - r.left - view.x) / view.z, y: (e.clientY - r.top - view.y) / view.z };
  }

  // Color & size picker shown next to the toolbar while the sticky tool is active.
  const picker = $('#stickyPicker');
  function drawPicker() {
    const btn = document.querySelector('[data-tool="sticky"]');
    btn.style.setProperty('--note', S.lastSticky);
    picker.hidden = S.tool !== 'sticky';
    if (picker.hidden) return;
    picker.innerHTML =
      `<div class="grp">${STICKY_COLORS.map(c => `<button class="sw${c === S.lastSticky ? ' on' : ''}" style="background:${c}" data-pick="color" data-val="${c}" aria-label="Note color ${c}"></button>`).join('')}</div>` +
      `<div class="grp">${STICKY_SIZES.map(([l, v]) => `<button class="txt${v === S.lastStickySize ? ' on' : ''}" data-pick="size" data-val="${v}" title="Note size ${l}">${l}</button>`).join('')}</div>`;
    const r = btn.getBoundingClientRect(), pr = picker.getBoundingClientRect();
    picker.style.left = n(r.right + 14) + 'px';
    picker.style.top = n(clamp(r.top + r.height / 2 - pr.height / 2, 8, innerHeight - pr.height - 8)) + 'px';
  }
  picker.addEventListener('pointerdown', e => e.preventDefault());
  picker.addEventListener('click', e => {
    const b = e.target.closest('[data-pick]');
    if (!b) return;
    if (b.dataset.pick === 'color') S.lastSticky = b.dataset.val;
    else S.lastStickySize = +b.dataset.val;
    drawPicker();
  });

  function setTool(t) {
    S.tool = t;
    document.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
    svg.classList.toggle('tool-create', ['sticky', 'text', 'rect', 'ellipse'].includes(t));
    svg.classList.toggle('tool-connector', t === 'connector');
    svg.classList.toggle('grab', t === 'hand' || S.spaceDown);
    drawPicker();
    S.hover = null;
    render(false);
  }

  function startConnector(fromItem, p, side) {
    const c = {
      id: uid(), type: 'connector',
      from: fromItem ? { id: fromItem.id, side: side || sideToward(fromItem, p) } : { x: p.x, y: p.y },
      to: { x: p.x, y: p.y },
      endArrow: true,
    };
    items.push(c);
    byId.set(c.id, c);
    S.sel.clear();
    S.hover = null;
    S.drag = { mode: 'connect', c, start: p, fromItem, lazySide: fromItem && !side };
  }

  function updateHover(p) {
    let h = null;
    if ((S.tool === 'select' || S.tool === 'connector') && !S.editing && !S.spaceDown) {
      const m = 24 / view.z;
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it.type === 'connector') continue;
        if (p.x >= it.x - m && p.x <= it.x + it.w + m && p.y >= it.y - m && p.y <= it.y + it.h + m) { h = it.id; break; }
      }
    }
    if (h !== S.hover) { S.hover = h; render(false); }
  }

  svg.addEventListener('pointerdown', e => {
    toggleSidebar(false);
    if (S.editing) commitEdit();
    const p = toWorld(e);
    S.pointer = p;
    svg.setPointerCapture(e.pointerId);

    if (e.button === 1 || (e.button === 0 && (S.tool === 'hand' || S.spaceDown))) {
      S.drag = { mode: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
      svg.classList.add('grabbing');
      return;
    }
    if (e.button !== 0) return;

    const t = e.target;
    const handle = t.closest('[data-handle]');
    const anchor = t.closest('[data-anchor]');
    const el = t.closest('[data-id]');
    const it = el ? byId.get(el.dataset.id) : null;

    if (anchor) { startConnector(byId.get(anchor.dataset.for), p, anchor.dataset.anchor); render(); return; }

    if (handle) {
      const target = byId.get(handle.dataset.hid);
      const h = handle.dataset.handle;
      if (h === 'from' || h === 'to') S.drag = { mode: 'endpoint', c: target, end: h };
      else S.drag = { mode: 'resize', it: target, h, start: p, orig: { x: target.x, y: target.y, w: target.w, h: target.h, fontSize: target.fontSize } };
      render(false);
      return;
    }

    if (['sticky', 'text', 'rect', 'ellipse'].includes(S.tool)) {
      const created = createItem(S.tool, p);
      S.sel = new Set([created.id]);
      setTool('select');
      commit();
      S.drag = { mode: 'created', id: created.id };
      return;
    }

    if (S.tool === 'connector') {
      startConnector(it && it.type !== 'connector' ? it : null, p);
      render();
      return;
    }

    if (it) {
      const multi = e.shiftKey || e.metaKey || e.ctrlKey;
      let clickSelect = null;
      if (multi) {
        if (S.sel.has(it.id)) { S.sel.delete(it.id); render(false); return; }
        S.sel.add(it.id);
      } else if (!S.sel.has(it.id)) {
        S.sel = new Set([it.id]);
      } else {
        clickSelect = it.id;
      }
      const href = t.closest('[data-href]')?.dataset.href;
      S.drag = { mode: 'move', start: p, moved: false, alt: e.altKey, clickSelect, href };
    } else {
      if (!e.shiftKey) S.sel.clear();
      S.drag = { mode: 'marquee', start: p, cur: p, base: new Set(S.sel) };
    }
    render(false);
  });

  function snapshotPositions() {
    const orig = new Map();
    for (const it of selected()) {
      if (it.type === 'connector') {
        orig.set(it.id, { from: it.from.id ? null : { ...it.from }, to: it.to.id ? null : { ...it.to } });
      } else orig.set(it.id, { x: it.x, y: it.y });
    }
    return orig;
  }

  svg.addEventListener('pointermove', e => {
    const p = toWorld(e);
    S.pointer = p;
    const d = S.drag;
    if (!d) { updateHover(p); return; }

    switch (d.mode) {
      case 'pan':
        view.x = d.vx + e.clientX - d.sx;
        view.y = d.vy + e.clientY - d.sy;
        render(false);
        return;

      case 'move': {
        const dx = p.x - d.start.x, dy = p.y - d.start.y;
        if (!d.moved) {
          if (Math.hypot(dx, dy) * view.z < 3) return;
          d.moved = true;
          if (d.alt) duplicateSelection(0, 0);
          d.orig = snapshotPositions();
        }
        for (const [id, o] of d.orig) {
          const it = byId.get(id);
          if (it.type === 'connector') {
            if (o.from) it.from = { x: o.from.x + dx, y: o.from.y + dy };
            if (o.to) it.to = { x: o.to.x + dx, y: o.to.y + dy };
          } else { it.x = Math.round(o.x + dx); it.y = Math.round(o.y + dy); }
        }
        if (!e.metaKey && !e.ctrlKey) {
          const moving = new Set([...d.orig.keys()].filter(id => byId.get(id).type !== 'connector'));
          const snap = straightSnap(moving, 10 / view.z);
          if (snap.dx || snap.dy) {
            for (const [id, o] of d.orig) {
              const it = byId.get(id);
              if (it.type !== 'connector') { it.x += snap.dx; it.y += snap.dy; continue; }
              if (o.from) { it.from.x += snap.dx; it.from.y += snap.dy; }
              if (o.to) { it.to.x += snap.dx; it.to.y += snap.dy; }
            }
          }
        }
        render();
        return;
      }

      case 'marquee': {
        d.cur = p;
        const r = rectFrom(d.start, p);
        S.sel = new Set(d.base);
        for (const it of items) {
          const b = bbox(it);
          if (b && b.x >= r.x && b.y >= r.y && b.x + b.w <= r.x + r.w && b.y + b.h <= r.y + r.h) S.sel.add(it.id);
        }
        render(false);
        return;
      }

      case 'resize': {
        const { it, h, orig: o } = d;
        const dx = p.x - d.start.x, dy = p.y - d.start.y;
        const min = 30;
        let w = o.w, hh = o.h;
        if (h.includes('e')) w = o.w + dx;
        if (h.includes('w')) w = o.w - dx;
        if (h.includes('s')) hh = o.h + dy;
        if (h.includes('n')) hh = o.h - dy;
        if (it.type === 'text') {
          if (h === 'e' || h === 'w') {
            it.w = Math.max(min, Math.round(w));
            if (h === 'w') it.x = o.x + o.w - it.w;
          } else {
            const s = Math.max(min / o.w, w / o.w);
            it.w = Math.round(o.w * s);
            it.fontSize = Math.max(6, Math.round((o.fontSize || 24) * s * 10) / 10);
            if (h.includes('w')) it.x = o.x + o.w - it.w;
          }
          syncTextHeight(it);
          if (h.includes('n')) it.y = o.y + o.h - it.h;
        } else {
          if (it.type === 'sticky' || (it.type === 'image' || it.type === 'symbol') !== e.shiftKey) {
            const s = Math.max(min / Math.min(o.w, o.h), Math.max(w / o.w, hh / o.h));
            w = o.w * s; hh = o.h * s;
          }
          it.w = Math.max(min, Math.round(w));
          it.h = Math.max(min, Math.round(hh));
          it.x = h.includes('w') ? o.x + o.w - it.w : o.x;
          it.y = h.includes('n') ? o.y + o.h - it.h : o.y;
        }
        render();
        return;
      }

      case 'connect': {
        const f = d.fromItem;
        if (d.lazySide && !(p.x >= f.x && p.x <= f.x + f.w && p.y >= f.y && p.y <= f.y + f.h)) d.c.from.side = sideToward(f, p);
        const target = itemAt(p, f?.id);
        d.target = target ? target.id : null;
        d.c.to = target ? { id: target.id, side: pickSide(target, p, endPoint(d.c, 'from')) } : { x: p.x, y: p.y };
        render();
        return;
      }

      case 'endpoint': {
        const otherEnd = d.end === 'from' ? 'to' : 'from';
        const target = itemAt(p, d.c[otherEnd].id);
        d.target = target ? target.id : null;
        d.c[d.end] = target ? { id: target.id, side: pickSide(target, p, endPoint(d.c, otherEnd)) } : { x: p.x, y: p.y };
        render();
        return;
      }
    }
  });

  function endDrag(e) {
    const d = S.drag;
    if (!d) return;
    S.drag = null;
    svg.classList.remove('grabbing');
    const p = toWorld(e);

    switch (d.mode) {
      case 'pan': save(); break;
      case 'move':
        if (d.moved) commit();
        else {
          if (d.clickSelect) S.sel = new Set([d.clickSelect]);
          if (d.href && /^https?:\/\//i.test(d.href)) window.open(d.href, '_blank', 'noopener,noreferrer');
        }
        break;
      case 'resize':
      case 'endpoint':
        commit();
        break;
      case 'created':
        if (['sticky', 'text'].includes(byId.get(d.id)?.type)) startEdit(d.id);
        break;
      case 'connect': {
        const { c, fromItem } = d;
        const dist = Math.hypot(p.x - d.start.x, p.y - d.start.y) * view.z;
        if (d.target) {
          S.sel = new Set([c.id]);
          commit();
        } else if (fromItem && dist > 30) {
          const size = fromItem.type === 'sticky' ? fromItem.w : 200;
          const note = createItem('sticky', p);
          note.w = note.h = size;
          note.x = Math.round(p.x - size / 2);
          note.y = Math.round(p.y - size / 2);
          if (fromItem.type === 'sticky') note.color = fromItem.color;
          c.to = { id: note.id, side: sideToward(note, endPoint(c, 'from')) };
          const snap = straightSnap(new Set([note.id]), 40 / view.z);
          note.x += snap.dx;
          note.y += snap.dy;
          commit();
          startEdit(note.id);
        } else if (!fromItem && dist > 30) {
          S.sel = new Set([c.id]);
          commit();
        } else {
          removeItems([c.id]);
        }
        break;
      }
    }
    updateHover(p);
    render();
  }
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);
  svg.addEventListener('pointerleave', () => { if (!S.drag && S.hover) { S.hover = null; render(false); } });

  svg.addEventListener('dblclick', e => {
    if (S.tool !== 'select' && S.tool !== 'connector') return;
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    if (hit && hit.closest('[data-handle],[data-anchor]')) return;
    const el = hit && hit.closest('[data-id]');
    if (el) { startEdit(el.dataset.id); return; }
    const it = createItem('sticky', toWorld(e));
    S.sel = new Set([it.id]);
    commit();
    startEdit(it.id);
  });

  // ---------- zoom & pan ----------
  function zoomAt(sx, sy, factor) {
    const z = clamp(view.z * factor, ZMIN, ZMAX);
    view.x = sx - (sx - view.x) * (z / view.z);
    view.y = sy - (sy - view.y) * (z / view.z);
    view.z = z;
    render(false);
    save();
  }
  const zoomCenter = f => zoomAt(innerWidth / 2, innerHeight / 2, f);

  function fitView(animate = true) {
    const b = unionBox(items.map(bbox));
    if (!b) { Object.assign(view, { x: innerWidth / 2, y: innerHeight / 2, z: 1 }); render(false); return; }
    const pad = 100;
    const z = clamp(Math.min((innerWidth - pad * 2) / b.w, (innerHeight - pad * 2) / b.h), ZMIN, 1.5);
    Object.assign(view, { z, x: innerWidth / 2 - (b.x + b.w / 2) * z, y: innerHeight / 2 - (b.y + b.h / 2) * z });
    if (animate) save();
    render(false);
  }

  svg.addEventListener('wheel', e => {
    e.preventDefault();
    const k = e.deltaMode === 1 ? 16 : 1;
    if (e.ctrlKey || e.metaKey) zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * k * 0.01));
    else {
      view.x -= e.deltaX * k;
      view.y -= e.deltaY * k;
      render(false);
      save();
    }
    if (S.editing) positionEditor();
  }, { passive: false });

  let gestureScale = 1; // Safari trackpad pinch
  svg.addEventListener('gesturestart', e => { e.preventDefault(); gestureScale = 1; });
  svg.addEventListener('gesturechange', e => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, e.scale / gestureScale);
    gestureScale = e.scale;
  });

  // ---------- keyboard & clipboard ----------
  const typing = () => {
    const a = document.activeElement;
    return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') || document.querySelector('dialog[open]');
  };

  window.addEventListener('keydown', e => {
    if (typing()) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    if (e.code === 'Space') {
      e.preventDefault();
      if (!S.spaceDown) { S.spaceDown = true; svg.classList.add('grab'); S.hover = null; render(false); }
      return;
    }
    // Typing with one note (or shape, text, line) selected starts editing it, adding to the end.
    if (!mod && !e.altKey && e.key.length === 1 && S.sel.size === 1) {
      const it = byId.get([...S.sel][0]);
      if (it && ['sticky', 'shape', 'text', 'connector'].includes(it.type)) {
        e.preventDefault();
        startEdit(it.id);
        const sep = editor.value && !/\s$/.test(editor.value) && /[\p{L}\p{N}]/u.test(e.key) ? ' ' : '';
        editor.value += sep + e.key;
        editor.setSelectionRange(editor.value.length, editor.value.length);
        editor.dispatchEvent(new Event('input'));
        return;
      }
    }
    if (mod) {
      if (k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      else if (k === 'y') { e.preventDefault(); redo(); }
      else if (k === 'a') { e.preventDefault(); S.sel = new Set(items.map(i => i.id)); render(false); }
      else if (k === 'd') { e.preventDefault(); duplicateSelection(); commit(); }
      else if (k === '=' || k === '+') { e.preventDefault(); zoomCenter(1.25); }
      else if (k === '-') { e.preventDefault(); zoomCenter(0.8); }
      else if (k === '0') { e.preventDefault(); zoomCenter(1 / view.z); }
      else if (k === 's') { e.preventDefault(); flushSave(); toast('Saved'); }
      else if (k === 'f') { e.preventDefault(); openSearch(); }
      else if (k === 'e' && e.shiftKey) { e.preventDefault(); openExport(); }
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (S.sel.size) { e.preventDefault(); removeItems([...S.sel]); commit(); }
    } else if (e.key === 'Escape') {
      S.sel.clear(); setTool('select'); toggleSidebar(false); toggleLibrary(false);
    } else if (e.key === 'Enter') {
      if (S.sel.size === 1) { e.preventDefault(); startEdit([...S.sel][0]); }
    } else if (e.key === 'Tab') {
      if (S.sel.size === 1) { e.preventDefault(); addSibling(byId.get([...S.sel][0]), e.shiftKey ? 'down' : 'right'); }
    } else if (e.key.startsWith('Arrow') && S.sel.size) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      for (const it of selected()) {
        if (it.type === 'connector') {
          if (!it.from.id) { it.from.x += dx; it.from.y += dy; }
          if (!it.to.id) { it.to.x += dx; it.to.y += dy; }
        } else { it.x += dx; it.y += dy; }
      }
      commit();
    } else if (e.code === 'Digit1' && e.shiftKey) {
      fitView();
    } else if (e.key === '?') {
      $('#helpDlg').showModal();
    } else {
      if (k === 'i' && !e.altKey) { $('#imageInput').click(); return; }
      if (k === 'k' && !e.altKey) { e.preventDefault(); toggleLibrary(); return; }
      const tool = { v: 'select', h: 'hand', n: 'sticky', s: 'sticky', t: 'text', r: 'rect', o: 'ellipse', l: 'connector', c: 'connector' }[k];
      if (tool && !e.altKey) setTool(tool);
    }
  });

  window.addEventListener('keyup', e => {
    if (e.code === 'Space') { S.spaceDown = false; svg.classList.toggle('grab', S.tool === 'hand'); }
  });
  window.addEventListener('blur', () => { S.spaceDown = false; svg.classList.toggle('grab', S.tool === 'hand'); });

  const CLIP_TAG = 'tack-clipboard:';
  document.addEventListener('copy', e => {
    if (typing() || !S.sel.size) return;
    e.preventDefault();
    const list = collect(S.sel);
    e.clipboardData.setData('text/plain', CLIP_TAG + JSON.stringify(list));
  });
  document.addEventListener('cut', e => {
    if (typing() || !S.sel.size) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', CLIP_TAG + JSON.stringify(collect(S.sel)));
    removeItems([...S.sel]);
    commit();
  });
  document.addEventListener('paste', e => {
    if (typing()) return;
    const files = [...(e.clipboardData.files || [])].filter(f => f.type.startsWith('image/'));
    if (files.length) {
      e.preventDefault();
      insertImageFiles(files, S.pointer);
      return;
    }
    const text = e.clipboardData.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    const p = S.pointer;
    if (text.startsWith(CLIP_TAG)) {
      let list;
      try { list = JSON.parse(text.slice(CLIP_TAG.length)); } catch { return; }
      const b = unionBox(list.filter(i => i.type !== 'connector').map(bbox).concat(
        list.filter(i => i.type === 'connector').flatMap(c => [c.from, c.to].filter(q => !q.id).map(q => ({ x: q.x, y: q.y, w: 0, h: 0 })))));
      if (!b) return;
      const ids = insertClones(list, Math.round(p.x - b.x - b.w / 2), Math.round(p.y - b.y - b.h / 2));
      S.sel = new Set(ids);
    } else {
      const it = createItem('sticky', p);
      it.text = text.trim();
      S.sel = new Set([it.id]);
    }
    commit();
  });

  // ---------- export ----------
  function exportSVGString(list, box, { bg = 'none', theme = 'light', font = FONT, scale = 1, imgs = new Map(), textImgs = null } = {}) {
    const pal = THEMES[theme] || THEMES.light;
    return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${n(box.w * scale)}" height="${n(box.h * scale)}" viewBox="${n(box.x)} ${n(box.y)} ${n(box.w)} ${n(box.h)}">` +
      (bg === 'solid' ? `<rect x="${n(box.x)}" y="${n(box.y)}" width="${n(box.w)}" height="${n(box.h)}" fill="${pal.bg}"/>` : '') +
      sceneMarkup(list, { forExport: true, font, imgs, pal, textImgs }) + '</svg>';
  }

  function exportScope(scope) {
    const list = scope === 'selection' && S.sel.size ? collect(S.sel) : items;
    const b = unionBox(list.map(bbox));
    if (!b) return null;
    const pad = 40;
    return { list, box: { x: Math.floor(b.x - pad), y: Math.floor(b.y - pad), w: Math.ceil(b.w + pad * 2), h: Math.ceil(b.h + pad * 2) } };
  }

  const MAX_SIDE = 16384, MAX_AREA = 120e6;
  function pngSize(box, scale) {
    let s = scale;
    s = Math.min(s, MAX_SIDE / box.w, MAX_SIDE / box.h, Math.sqrt(MAX_AREA / (box.w * box.h)));
    return { s, w: Math.floor(box.w * s), h: Math.floor(box.h * s), capped: s < scale };
  }

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  const fileBase = () => (board.name || 'board').replace(/[\\/:*?"<>|]+/g, '').trim().slice(0, 80) || 'board';

  const loaded = {};
  function loadScript(src) {
    return loaded[src] ||= new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = res;
      s.onerror = () => { delete loaded[src]; rej(new Error('Could not load ' + src)); };
      document.head.appendChild(s);
    });
  }

  async function doExport({ format, scope, bg, theme, scale }) {
    flushSave();
    if (format === 'json') {
      const list = scope === 'selection' && S.sel.size ? collect(S.sel) : items;
      const data = { app: 'tack', version: 1, name: board.name, exportedAt: new Date().toISOString(), items: list };
      const imgs = await imageDataURLs(list);
      if (imgs.size) data.images = Object.fromEntries(imgs);
      download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), fileBase() + '.json');
      return;
    }
    const sc = exportScope(scope);
    if (!sc) { toast('Nothing to export yet'); return; }
    const { list, box } = sc;
    const imgs = await imageDataURLs(list, format === 'pdf');

    if (format === 'svg') {
      download(new Blob([exportSVGString(list, box, { bg, theme, imgs })], { type: 'image/svg+xml' }), fileBase() + '.svg');
    } else if (format === 'png') {
      const size = pngSize(box, scale);
      const url = URL.createObjectURL(new Blob([exportSVGString(list, box, { bg, theme, scale: size.s, imgs })], { type: 'image/svg+xml' }));
      try {
        const img = new Image();
        img.src = url;
        await img.decode();
        const cv = document.createElement('canvas');
        cv.width = size.w; cv.height = size.h;
        const g = cv.getContext('2d');
        g.drawImage(img, 0, 0, size.w, size.h);
        const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
        if (!blob) throw new Error('canvas too large');
        download(blob, fileBase() + '.png');
        if (size.capped) toast(`Board is huge, so PNG was capped at ${size.w}×${size.h}. Use SVG or PDF for unlimited detail.`);
      } catch (err) {
        console.error(err);
        toast('PNG export failed — try a lower resolution, or SVG/PDF');
      } finally { URL.revokeObjectURL(url); }
    } else if (format === 'pdf') {
      toast('Building PDF…');
      try {
        await loadScript(CDN.jspdf);
        await loadScript(CDN.svg2pdf);
      } catch {
        toast('PDF needs an internet connection the first time (to load jsPDF). SVG works offline.');
        return;
      }
      const k = Math.min(1, 14000 / Math.max(box.w, box.h)); // PDF pages max out at 200 inches
      const W = box.w * k, H = box.h * k;
      const doc = new window.jspdf.jsPDF({ unit: 'pt', format: [W, H], orientation: W > H ? 'l' : 'p', compress: true });
      const holder = document.createElement('div');
      holder.style.cssText = 'position:fixed;left:-100000px;top:0;width:10px;height:10px;overflow:hidden';
      holder.innerHTML = exportSVGString(list, box, { bg, theme, font: 'helvetica', imgs, textImgs: await rasterizeTexts(list, THEMES[theme] || THEMES.light) });
      document.body.appendChild(holder);
      try {
        const el = holder.firstElementChild;
        if (typeof doc.svg === 'function') await doc.svg(el, { x: 0, y: 0, width: W, height: H });
        else await window.svg2pdf.svg2pdf(el, doc, { x: 0, y: 0, width: W, height: H });
        doc.save(fileBase() + '.pdf');
      } catch (err) {
        console.error(err);
        toast('PDF export failed — SVG export should still work');
      } finally { holder.remove(); }
    }
  }

  const exportDlg = $('#exportDlg'), exportForm = $('#exportForm');
  const PREFS_KEY = 'tack:exportPrefs';
  const FORMAT_NOTES = {
    png: 'Image file. Pick a high resolution for crisp zooming and printing.',
    svg: 'Vector, so it stays sharp at any size. Opens in browsers, Figma, Illustrator, Inkscape.',
    pdf: 'Vector PDF with selectable text, sized to fit the whole board on one page.',
    json: 'The raw board. Use it to back up or re-import into Tack.',
  };
  function exportOpts() {
    const f = new FormData(exportForm);
    return { format: f.get('format'), scope: f.get('scope'), bg: f.get('bg'), theme: f.get('theme'), scale: +f.get('scale') };
  }
  function updateExportDlg() {
    const o = exportOpts();
    $('#fmtNote').textContent = FORMAT_NOTES[o.format];
    $('#scaleSeg').hidden = o.format !== 'png';
    $('#bgSeg').hidden = $('#themeSeg').hidden = o.format === 'json';
    store.set(PREFS_KEY, { format: o.format, theme: o.theme, bg: o.bg, scale: o.scale });
    const sc = exportScope(o.scope);
    let dims = '';
    if (sc && o.format === 'png') {
      const s = pngSize(sc.box, o.scale);
      dims = `${s.w.toLocaleString()} × ${s.h.toLocaleString()} px${s.capped ? ' (capped by browser limits)' : ''}`;
    } else if (sc && o.format !== 'json') {
      dims = `${(sc.list.length).toLocaleString()} items · ${sc.box.w.toLocaleString()} × ${sc.box.h.toLocaleString()} units`;
    }
    $('#exportDims').textContent = dims;
  }
  function openExport() {
    commitEdit();
    const prefs = store.get(PREFS_KEY, {});
    for (const k of ['format', 'theme', 'bg', 'scale']) {
      const input = prefs[k] != null && exportForm.querySelector(`input[name="${k}"][value="${prefs[k]}"]`);
      if (input) input.checked = true;
    }
    const selInput = exportForm.querySelector('input[value="selection"]');
    selInput.disabled = !S.sel.size;
    exportForm.querySelector(`input[name="scope"][value="${S.sel.size ? 'selection' : 'all'}"]`).checked = true;
    updateExportDlg();
    exportDlg.showModal();
  }
  exportForm.addEventListener('change', updateExportDlg);
  exportDlg.addEventListener('close', () => {
    if (exportDlg.returnValue === 'go') doExport(exportOpts());
  });

  // ---------- import ----------
  $('#importInput').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const list = Array.isArray(data) ? data : data.items;
      if (!Array.isArray(list)) throw new Error('no items');
      const ok = list.filter(i => i && i.id && ['sticky', 'text', 'shape', 'connector', 'image', 'symbol'].includes(i.type));
      for (const [key, url] of Object.entries(data.images || {})) {
        if (typeof url === 'string' && url.startsWith('data:image/')) await imageDB.put(key, await (await fetch(url)).blob());
      }
      const b = createBoard(data.name || file.name.replace(/\.json$/i, ''), ok);
      openBoard(b.id);
      toggleSidebar(false);
      fitView();
      toast(`Imported ${ok.length} items`);
    } catch (err) {
      console.error(err);
      toast('That file doesn’t look like a Tack board');
    }
  });

  // ---------- chrome wiring ----------
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  }

  document.querySelectorAll('[data-tool]').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));
  $('#undoBtn').onclick = undo;
  $('#redoBtn').onclick = redo;
  $('#zoomIn').onclick = () => zoomCenter(1.25);
  $('#zoomOut').onclick = () => zoomCenter(0.8);
  $('#zoomLabel').onclick = () => zoomCenter(1 / view.z);
  $('#zoomFit').onclick = () => fitView();
  $('#exportBtn').onclick = openExport;
  $('#helpBtn').onclick = () => $('#helpDlg').showModal();
  $('#menuBtn').onclick = () => toggleSidebar(!$('#sidebar').classList.contains('open'));
  $('#sbClose').onclick = () => toggleSidebar(false);
  $('#scrim').onclick = () => toggleSidebar(false);
  $('#imageBtn').onclick = () => $('#imageInput').click();
  $('#imageInput').addEventListener('change', e => {
    const files = [...e.target.files];
    e.target.value = '';
    insertImageFiles(files, viewCenter());
  });
  // ---------- search ----------
  const searchBar = $('#searchBar'), searchInput = $('#searchInput');
  const itemText = it => it.type === 'connector' ? (it.label || '') : it.type === 'symbol' ? (it.icon || '') : (it.text || '');

  function runSearch() {
    const q = searchInput.value.trim().toLowerCase();
    const matches = !q ? [] : items
      .filter(it => itemText(it).toLowerCase().includes(q))
      .map(it => ({ id: it.id, b: bbox(it) }))
      .filter(m => m.b)
      .sort((a, b) => a.b.y - b.b.y || a.b.x - b.b.x)
      .map(m => m.id);
    S.search = { q, matches, i: matches.length ? 0 : -1 };
    if (matches.length) focusMatch();
    updateSearchUI();
    render(false);
  }

  function focusMatch() {
    const it = byId.get(S.search.matches[S.search.i]), b = it && bbox(it);
    if (!b) return;
    if (b.w * view.z < 80 || b.w * view.z > innerWidth - 120 || b.h * view.z > innerHeight - 160) {
      view.z = clamp(Math.min(1, (innerWidth - 240) / b.w, (innerHeight - 240) / b.h), ZMIN, ZMAX);
    }
    view.x = innerWidth / 2 - (b.x + b.w / 2) * view.z;
    view.y = innerHeight / 2 - (b.y + b.h / 2) * view.z;
    save();
  }

  function stepSearch(dir) {
    const sr = S.search;
    if (!sr || !sr.matches.length) return;
    sr.i = (sr.i + dir + sr.matches.length) % sr.matches.length;
    focusMatch();
    updateSearchUI();
    render(false);
  }

  function updateSearchUI() {
    const sr = S.search;
    $('#searchCount').textContent = !sr || !sr.q ? '' : sr.matches.length ? `${sr.i + 1} of ${sr.matches.length}` : 'No results';
    $('#searchPrev').disabled = $('#searchNext').disabled = !sr || sr.matches.length < 2;
  }

  function openSearch() {
    commitEdit();
    searchBar.hidden = false;
    searchInput.focus();
    searchInput.select();
    if (searchInput.value.trim()) runSearch();
  }

  function closeSearch(selectCurrent = true) {
    if (searchBar.hidden) return;
    const sr = S.search;
    if (selectCurrent && sr && sr.i >= 0 && byId.has(sr.matches[sr.i])) S.sel = new Set([sr.matches[sr.i]]);
    S.search = null;
    searchBar.hidden = true;
    searchInput.blur();
    render(false);
  }

  searchInput.addEventListener('input', runSearch);
  searchInput.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); stepSearch(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
    else if (e.key.toLowerCase() === 'f' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); searchInput.select(); }
  });
  $('#searchPrev').onclick = () => stepSearch(-1);
  $('#searchNext').onclick = () => stepSearch(1);
  $('#searchClose').onclick = () => closeSearch();

  // ---------- symbol library ----------
  const lib = $('#library'), libBody = $('#libBody'), libSearch = $('#libSearch');
  const POPULAR = ['lightbulb', 'star', 'heart', 'check', 'x', 'circle-help', 'circle-alert', 'triangle-alert', 'info', 'flag',
    'bookmark', 'tag', 'user', 'users', 'brain', 'book-open', 'graduation-cap', 'school', 'target', 'rocket', 'zap', 'sparkles',
    'search', 'message-circle', 'quote', 'file-text', 'link', 'calendar', 'clock', 'map-pin', 'globe', 'database', 'server',
    'cpu', 'code', 'laptop', 'smartphone', 'mail', 'image', 'chart-bar', 'chart-line', 'chart-pie', 'trending-up',
    'trending-down', 'thumbs-up', 'thumbs-down', 'smile', 'frown', 'circle-check', 'circle-x', 'arrow-right', 'refresh-cw',
    'lock', 'key', 'shield', 'dollar-sign', 'briefcase', 'building', 'house', 'settings', 'wrench', 'puzzle', 'layers', 'box',
    'gift', 'trophy', 'award', 'pencil', 'clipboard-list', 'list-checks', 'scale', 'bot', 'flask-conical', 'microscope'];
  const MATH = [
    ['+', 'plus'], ['−', 'minus'], ['×', 'times multiply'], ['÷', 'divide'], ['±', 'plus minus'], ['=', 'equals'],
    ['≠', 'not equal'], ['≈', 'approximately'], ['≡', 'identical equivalent'], ['<', 'less than'], ['>', 'greater than'],
    ['≤', 'less than or equal'], ['≥', 'greater than or equal'], ['∝', 'proportional'], ['∞', 'infinity'], ['√', 'square root radical'],
    ['∑', 'sum sigma'], ['∏', 'product pi'], ['∫', 'integral'], ['∮', 'contour integral'], ['∂', 'partial derivative'],
    ['∇', 'nabla gradient del'], ['Δ', 'delta change'], ['π', 'pi'], ['θ', 'theta'], ['λ', 'lambda'], ['μ', 'mu mean'],
    ['σ', 'sigma standard deviation'], ['α', 'alpha'], ['β', 'beta'], ['γ', 'gamma'], ['ε', 'epsilon'], ['φ', 'phi'],
    ['ω', 'omega'], ['Ω', 'omega ohm'], ['∈', 'element of in'], ['∉', 'not element'], ['⊂', 'subset'], ['⊆', 'subset equal'],
    ['∪', 'union'], ['∩', 'intersection'], ['∅', 'empty set'], ['∀', 'for all'], ['∃', 'exists'], ['¬', 'not negation'],
    ['∧', 'and conjunction'], ['∨', 'or disjunction'], ['⇒', 'implies'], ['⇔', 'if and only if iff'], ['→', 'arrow maps to'],
    ['∴', 'therefore'], ['∵', 'because'], ['°', 'degree'], ['′', 'prime'], ['²', 'squared superscript two'],
    ['³', 'cubed superscript three'], ['ⁿ', 'superscript n power'], ['½', 'half fraction'], ['ℝ', 'real numbers'],
    ['ℕ', 'natural numbers'], ['ℤ', 'integers'], ['ℚ', 'rationals'], ['ℂ', 'complex numbers'], ['x̄', 'x bar mean'],
  ];
  let iconIndex = null; // [{ name, nodes }]
  const kebab = k => k.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Z])([A-Z][a-z])/g, '$1-$2').toLowerCase();

  async function loadIcons() {
    if (iconIndex) return iconIndex;
    await loadScript(CDN.lucide);
    iconIndex = Object.entries(window.lucide.icons).map(([k, raw]) => ({ name: kebab(k), nodes: iconNodes(raw) }));
    return iconIndex;
  }

  function drawLibrary() {
    const q = libSearch.value.trim().toLowerCase();
    const shapes = Object.entries(SHAPES).filter(([k, v]) => !q || k.includes(q) || v.label.toLowerCase().includes(q));
    let html = '';
    if (shapes.length) {
      html += `<h3>Shapes</h3><div class="lib-grid shapes">${shapes.map(([k, v]) =>
        `<button draggable="true" data-sym="shape:${k}" title="${v.label}">${shapeIcon(k)}</button>`).join('')}</div>`;
    }
    const math = MATH.map((m, i) => [m, i]).filter(([[g, name]]) => !q || name.includes(q) || g === q);
    if (math.length) {
      html += `<h3>Math</h3><div class="lib-grid math">${math.map(([[g, name], i]) =>
        `<button draggable="true" data-sym="math:${i}" title="${name}">${esc(g)}</button>`).join('')}</div>`;
    }
    html += '<h3>Icons</h3>';
    if (!iconIndex) html += `<p class="lib-note" id="libStatus">Loading icons…</p>`;
    else {
      const byName = new Map(iconIndex.map(i => [i.name, i]));
      const list = q
        ? iconIndex.filter(i => i.name.includes(q)).sort((a, b) => (a.name.startsWith(q) ? 0 : 1) - (b.name.startsWith(q) ? 0 : 1)).slice(0, 240)
        : POPULAR.map(nm => byName.get(nm)).filter(Boolean);
      html += list.length
        ? `<div class="lib-grid">${list.map(i => `<button draggable="true" data-sym="icon:${i.name}" title="${i.name}"><svg viewBox="0 0 24 24">${iconMarkup(i.nodes)}</svg></button>`).join('')}</div>`
        : `<p class="lib-note">No icons match “${esc(q)}”.</p>`;
      if (!q) html += `<p class="lib-note">${iconIndex.length.toLocaleString()} icons from Lucide. Search to see more.</p>`;
    }
    libBody.innerHTML = html;
  }

  function toggleLibrary(open = lib.hidden) {
    lib.hidden = !open;
    $('#libraryBtn').classList.toggle('active', open);
    if (!open) return;
    drawLibrary();
    libSearch.focus();
    loadIcons().then(drawLibrary).catch(() => {
      const st = $('#libStatus');
      if (st) st.textContent = 'Icons need an internet connection the first time. Shapes work offline.';
    });
  }

  function insertSymbol(spec, p) {
    const [kind, name] = spec.split(':');
    let it;
    if (kind === 'shape' && SHAPES[name]) it = createItem(name, p);
    else if (kind === 'math' && MATH[+name]) {
      it = createItem('text', p);
      it.text = MATH[+name][0];
      it.fontSize = 56;
      it.w = Math.ceil(tw(it.text, 56)) + 24;
      syncTextHeight(it);
      it.x = Math.round(p.x - it.w / 2);
      it.y = Math.round(p.y - it.h / 2);
    }
    else if (kind === 'icon') {
      const icon = iconIndex?.find(i => i.name === name);
      if (!icon) return;
      it = { id: uid(), type: 'symbol', icon: name, nodes: icon.nodes, w: 96, h: 96 };
      it.x = Math.round(p.x - 48); it.y = Math.round(p.y - 48);
      items.push(it); byId.set(it.id, it);
    } else return;
    S.sel = new Set([it.id]);
    setTool('select');
    commit();
  }

  let libOffset = 0;
  libBody.addEventListener('click', e => {
    const b = e.target.closest('[data-sym]');
    if (!b) return;
    const c = viewCenter();
    libOffset = (libOffset + 24) % 144;
    insertSymbol(b.dataset.sym, { x: c.x + libOffset, y: c.y + libOffset });
  });
  libBody.addEventListener('dragstart', e => {
    const b = e.target.closest('[data-sym]');
    if (!b) return;
    e.dataTransfer.setData('application/x-tack-symbol', b.dataset.sym);
    e.dataTransfer.effectAllowed = 'copy';
  });
  libSearch.addEventListener('input', drawLibrary);
  libSearch.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); toggleLibrary(false); } });
  $('#libraryBtn').onclick = () => toggleLibrary();
  $('#libClose').onclick = () => toggleLibrary(false);

  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  const isSymbol = e => [...(e.dataTransfer?.types || [])].includes('application/x-tack-symbol');
  window.addEventListener('dragover', e => { if (hasFiles(e) || isSymbol(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  window.addEventListener('drop', e => {
    if (isSymbol(e)) {
      e.preventDefault();
      if (e.target.closest && e.target.closest('#library')) return;
      insertSymbol(e.dataTransfer.getData('application/x-tack-symbol'), toWorld(e));
      return;
    }
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (!insertImageFiles(e.dataTransfer.files, toWorld(e))) toast('Only image files can be dropped on the board');
  });
  // Clear the current board (undoable), after confirming.
  const clearDlg = $('#clearDlg');
  $('#clearBtn').onclick = () => {
    commitEdit();
    toggleSidebar(false);
    if (!items.length) { toast('This board is already empty'); return; }
    $('#clearMsg').textContent = `This removes all ${items.length} item${items.length === 1 ? '' : 's'} from “${board.name}”. You can undo it with ⌘Z.`;
    clearDlg.showModal();
  };
  clearDlg.addEventListener('close', () => {
    if (clearDlg.returnValue !== 'clear') return;
    removeItems(items.map(i => i.id));
    S.sel.clear();
    commit();
    toast('Board cleared. Press ⌘Z to undo');
  });
  $('#importBtn').onclick = () => $('#importInput').click();
  $('#newBoardBtn').onclick = () => {
    const b = createBoard('Untitled board');
    openBoard(b.id);
    toggleSidebar(false);
    $('#boardName').select();
  };
  $('#boardList').addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const id = b.closest('li').dataset.bid;
    if (b.dataset.act === 'open') { openBoard(id); toggleSidebar(false); }
    if (b.dataset.act === 'dup') {
      flushSave();
      const src = store.get(boardKey(id));
      if (src) { createBoard(src.name + ' copy', src.items); renderSidebar(); }
    }
    if (b.dataset.act === 'del') {
      const name = store.get(INDEX_KEY, []).find(x => x.id === id)?.name || 'this board';
      if (confirm(`Delete “${name}”? This can’t be undone.`)) deleteBoard(id);
    }
  });
  const nameInput = $('#boardName');
  nameInput.addEventListener('input', () => {
    board.name = nameInput.value || 'Untitled board';
    document.title = `${board.name} · Tack`;
    save();
    markDirty(board.id);
  });
  nameInput.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === 'Escape') nameInput.blur(); });
  nameInput.addEventListener('blur', () => { if (!nameInput.value.trim()) nameInput.value = board.name = 'Untitled board'; flushSave(); });

  window.addEventListener('resize', () => render(false));
  window.addEventListener('beforeunload', flushSave);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });

  // ---------- sync ----------
  // Local-first: boards always save to this browser instantly. When the hosted sync API is
  // available and you're signed in, changed boards are pushed a moment later and other
  // devices' changes are pulled in. Each board carries the server version it was last synced
  // at (`rv` in the index); the server refuses a save based on an older version, and then the
  // local copy is kept as a separate "conflict copy" board, so nothing is ever overwritten.
  const DELETES_KEY = 'tack:pendingDeletes', UPLOADED_KEY = 'tack:uploaded', SYNC_USER_KEY = 'tack:syncUser';
  const API = new URL('api/', location.href).toString();
  const sync = { state: 'off', email: null, timer: null, running: false, again: false, last: 0 };
  class SignedOut extends Error {}

  function setIndexEntry(id, patch) {
    const idx = store.get(INDEX_KEY, []);
    const e = idx.find(b => b.id === id);
    if (!e) return null;
    Object.assign(e, patch);
    store.set(INDEX_KEY, idx);
    return e;
  }

  function markDirty(id) {
    setIndexEntry(id, { dirty: true, seed: false });
    scheduleSync();
  }

  function scheduleSync(delay = 2000) {
    if (!['idle', 'syncing', 'offline', 'error'].includes(sync.state)) return;
    clearTimeout(sync.timer);
    sync.timer = setTimeout(runSync, delay);
  }

  async function api(path, opts = {}) {
    const res = await fetch(API + path, { credentials: 'same-origin', redirect: 'manual', cache: 'no-store', ...opts });
    if (res.type === 'opaqueredirect' || res.status === 401) throw new SignedOut();
    return res;
  }

  async function fetchRemoteImage(key) {
    if (!['idle', 'syncing'].includes(sync.state)) return null;
    try {
      const res = await api('images/' + key);
      if (!res.ok) return null;
      const blob = await res.blob();
      await imageDB.put(key, blob);
      rememberUploaded(key);
      return blob;
    } catch { return null; }
  }

  function rememberUploaded(key) {
    const up = store.get(UPLOADED_KEY, []);
    if (!up.includes(key)) { up.push(key); store.set(UPLOADED_KEY, up); }
  }

  async function startSync() {
    try {
      const res = await api('me');
      if (res.status === 404 || res.status === 503) return setSync('off');
      if (!res.ok) return setSync('error');
      const me = await res.json();
      sync.email = me.email;
      // A different account signed in on this browser: treat every local board as new to it.
      const prev = store.get(SYNC_USER_KEY);
      if (prev && prev !== me.id) {
        const idx = store.get(INDEX_KEY, []);
        idx.forEach(e => { delete e.rv; e.dirty = !e.seed; });
        store.set(INDEX_KEY, idx);
        store.set(UPLOADED_KEY, []);
      }
      store.set(SYNC_USER_KEY, me.id);
      setSync('idle');
      runSync();
    } catch (err) {
      setSync(err instanceof SignedOut ? 'signed-out' : 'off');
    }
  }

  async function runSync() {
    clearTimeout(sync.timer);
    if (sync.running) { sync.again = true; return; }
    sync.running = true;
    setSync('syncing');
    try {
      await pushDeletes();
      await pull();
      await pushDirty();
      sync.last = Date.now();
      setSync('idle');
    } catch (err) {
      if (err instanceof SignedOut) setSync('signed-out');
      else { console.error(err); setSync(navigator.onLine === false || err instanceof TypeError ? 'offline' : 'error'); }
    }
    sync.running = false;
    if (sync.again) { sync.again = false; runSync(); }
  }

  async function pushDeletes() {
    for (const id of store.get(DELETES_KEY, [])) {
      const res = await api('boards/' + id, { method: 'DELETE' });
      if (res.ok) store.set(DELETES_KEY, store.get(DELETES_KEY, []).filter(x => x !== id));
    }
  }

  // Replace a local board with the server's copy (keeping this device's view position).
  function applyRemote(id, remote) {
    const local = store.get(boardKey(id)) || { id, view: null, createdAt: Date.now() };
    const next = { ...local, name: remote.name, items: remote.items, updatedAt: remote.updatedAt };
    store.set(boardKey(id), next);
    const idx = store.get(INDEX_KEY, []);
    const e = idx.find(b => b.id === id);
    if (e) Object.assign(e, { name: remote.name, updatedAt: remote.updatedAt, rv: remote.version, dirty: false });
    else idx.push({ id, name: remote.name, updatedAt: remote.updatedAt, rv: remote.version, dirty: false });
    store.set(INDEX_KEY, idx);
    if (board && board.id === id) {
      board = next;
      items = next.items;
      reindex();
      items.forEach(syncTextHeight);
      S.sel = new Set([...S.sel].filter(x => byId.has(x)));
      undoStack = []; redoStack = []; snapshot = JSON.stringify(items);
      nameInput.value = next.name;
      document.title = `${next.name} · Tack`;
      render();
    }
  }

  async function pull() {
    const res = await api('boards');
    if (!res.ok) throw new Error('List failed: ' + res.status);
    const { boards } = await res.json();
    const pendingDeletes = store.get(DELETES_KEY, []);
    let changed = false;
    for (const r of boards) {
      const local = store.get(INDEX_KEY, []).find(b => b.id === r.id);
      const busy = board && board.id === r.id && (S.editing || S.drag);
      if (r.deleted) {
        if (local && local.rv && !local.dirty && !busy) { deleteBoard(r.id, { remote: false }); changed = true; }
        continue;
      }
      if (pendingDeletes.includes(r.id)) continue;
      if (local && (local.dirty || r.version <= (local.rv || 0) || busy)) continue;
      const got = await api('boards/' + r.id);
      if (!got.ok) continue;
      applyRemote(r.id, await got.json());
      changed = true;
    }
    if (changed) {
      // This device's untouched welcome board isn't needed once your own boards have arrived.
      const synced = store.get(INDEX_KEY, []).filter(b => b.rv);
      for (const e of store.get(INDEX_KEY, []).filter(b => b.seed && !b.dirty && !b.rv)) {
        if (!synced.length || (board && board.id === e.id && (S.editing || S.drag))) continue;
        if (board && board.id === e.id) openBoard(synced[0].id);
        deleteBoard(e.id, { remote: false });
      }
      renderSidebar();
    }
  }

  async function uploadImages(list) {
    const up = new Set(store.get(UPLOADED_KEY, []));
    for (const it of list) {
      if (it.type !== 'image' || up.has(it.img)) continue;
      const blob = await imageDB.get(it.img);
      if (!blob) continue;
      const res = await api('images/' + it.img, { method: 'PUT', headers: { 'Content-Type': blob.type || 'image/png' }, body: blob });
      if (res.ok) { rememberUploaded(it.img); up.add(it.img); }
      else if (res.status === 413) toast('An image is too large to sync (15 MB max)');
    }
  }

  async function pushDirty() {
    for (const entry of store.get(INDEX_KEY, []).filter(b => b.dirty)) {
      if (board && board.id === entry.id) flushSave();
      const b = store.get(boardKey(entry.id));
      if (!b) { setIndexEntry(entry.id, { dirty: false }); continue; }
      await uploadImages(b.items);
      const sent = JSON.stringify([b.name, b.items]);
      const res = await api('boards/' + entry.id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: b.name, items: b.items, baseVersion: entry.rv || 0 }),
      });
      if (res.status === 409) {
        // Someone else (another device) saved first: keep ours as a copy, take theirs.
        createBoard(`${b.name} (conflict copy)`, b.items);
        const got = await api('boards/' + entry.id);
        if (got.ok) applyRemote(entry.id, await got.json());
        renderSidebar();
        toast(`“${b.name}” was changed on another device. Your version was saved as a conflict copy.`);
        continue;
      }
      if (res.status === 413) { setIndexEntry(entry.id, { dirty: false }); toast(`“${b.name}” is too large to sync`); continue; }
      if (!res.ok) throw new Error('Save failed: ' + res.status);
      const { version } = await res.json();
      const now = store.get(boardKey(entry.id));
      const unchanged = now && JSON.stringify([now.name, now.items]) === sent;
      setIndexEntry(entry.id, { rv: version, dirty: !unchanged });
    }
  }

  // ---- sync button & menu
  const syncBtn = $('#syncBtn'), syncMenu = $('#syncMenu');
  const SYNC_TEXT = {
    'signed-out': 'Sign in to sync your boards across devices',
    idle: 'Synced',
    syncing: 'Syncing…',
    offline: 'Offline. Changes will sync when you’re back online',
    error: 'Sync hit a problem. Will retry',
  };
  function setSync(state) {
    sync.state = state;
    syncBtn.hidden = state === 'off';
    syncBtn.dataset.state = state;
    syncBtn.title = SYNC_TEXT[state] || '';
    if (!syncMenu.hidden) drawSyncMenu();
  }
  let authMode = 'in'; // 'in' (sign in) or 'up' (create account)
  function drawSyncMenu() {
    const st = sync.state;
    const when = sync.last ? `Last synced ${timeAgo(sync.last)}` : '';
    if (st === 'signed-out') {
      const up = authMode === 'up';
      syncMenu.innerHTML = `
        <form id="authForm" novalidate>
          <h3>${up ? 'Create an account' : 'Sign in'}</h3>
          <p>${up ? 'Your boards will sync to every device you sign in on.' : 'Sync your boards across devices. They stay in this browser too.'}</p>
          <input name="email" type="email" placeholder="Email" autocomplete="email" required>
          <input name="password" type="password" placeholder="Password${up ? ' (8+ characters)' : ''}" autocomplete="${up ? 'new-password' : 'current-password'}" required minlength="8">
          <p class="auth-error" id="authError" role="alert"></p>
          <button class="btn primary" type="submit">${up ? 'Create account' : 'Sign in'}</button>
          ${!up && passkeysSupported ? '<button class="btn" type="button" id="passkeySignIn">Sign in with a passkey</button>' : ''}
          <button class="link" type="button" id="authSwitch">${up ? 'Have an account? Sign in' : 'New here? Create an account'}</button>
        </form>`;
      $('#authSwitch').onclick = () => { authMode = up ? 'in' : 'up'; drawSyncMenu(); $('#authForm input[name=email]').focus(); };
      $('#authForm').onsubmit = submitAuth;
      if ($('#passkeySignIn')) $('#passkeySignIn').onclick = passkeySignIn;
      return;
    }
    syncMenu.innerHTML = `<p><b>${esc(sync.email || '')}</b><br><span>${esc(SYNC_TEXT[st] || '')}${when && st === 'idle' ? ' · ' + when : ''}</span></p>
       <div class="row"><button id="syncNow">Sync now</button><button id="signOut">Sign out</button></div>
       ${passkeysSupported ? '<button id="passkeyAdd" class="wide">Add a passkey</button>' : ''}
       <button id="aiConnect" class="wide">Connect an AI tool…</button>`;
    $('#syncNow').onclick = () => runSync();
    $('#signOut').onclick = signOut;
    $('#aiConnect').onclick = openAiDialog;
    if ($('#passkeyAdd')) $('#passkeyAdd').onclick = passkeyAdd;
  }

  async function submitAuth(e) {
    e.preventDefault();
    const form = e.target, err = $('#authError'), btn = form.querySelector('button[type=submit]');
    const email = form.email.value.trim(), password = form.password.value;
    if (!/^\S+@\S+\.\S+$/.test(email)) { err.textContent = 'Enter a valid email address.'; return; }
    if (password.length < 8) { err.textContent = 'Passwords need at least 8 characters.'; return; }
    btn.disabled = true;
    err.textContent = '';
    try {
      const up = authMode === 'up';
      const res = await fetch(API + (up ? 'auth/sign-up/email' : 'auth/sign-in/email'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(up ? { email, password, name: email.split('@')[0] } : { email, password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        err.textContent = res.status === 429 ? 'Too many tries. Wait a minute and try again.'
          : data.message || (up ? 'Couldn’t create that account.' : 'Wrong email or password.');
        return;
      }
      syncMenu.hidden = true;
      await startSync();
      toast(up ? 'Account created. Your boards are syncing.' : 'Signed in. Your boards are syncing.');
    } catch {
      err.textContent = 'Couldn’t reach the server. Check your connection.';
    } finally {
      btn.disabled = false;
    }
  }

  // ---- passkeys (WebAuthn), talking to Better Auth's passkey endpoints
  const passkeysSupported = !!(window.PublicKeyCredential && navigator.credentials);
  const b64u = {
    toBuf: s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0)).buffer,
    from: buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  };
  const authApi = (path, opts = {}) => fetch(API + 'auth/' + path, {
    credentials: 'same-origin', ...opts,
    headers: { ...(opts.body && { 'Content-Type': 'application/json' }), ...opts.headers },
  });
  const apiError = async (res, fallback) => (await res.json().catch(() => ({}))).message || fallback;

  async function passkeyAdd() {
    try {
      const optRes = await authApi('passkey/generate-register-options?name=' + encodeURIComponent(navigator.platform || 'Passkey'));
      if (!optRes.ok) throw new Error(await apiError(optRes, 'Couldn’t start'));
      const o = await optRes.json();
      const cred = await navigator.credentials.create({ publicKey: {
        ...o,
        challenge: b64u.toBuf(o.challenge),
        user: { ...o.user, id: b64u.toBuf(o.user.id) },
        excludeCredentials: (o.excludeCredentials || []).map(c => ({ ...c, id: b64u.toBuf(c.id) })),
      } });
      const r = cred.response;
      const response = {
        id: cred.id, rawId: b64u.from(cred.rawId), type: cred.type,
        authenticatorAttachment: cred.authenticatorAttachment || undefined,
        response: {
          clientDataJSON: b64u.from(r.clientDataJSON),
          attestationObject: b64u.from(r.attestationObject),
          transports: r.getTransports ? r.getTransports() : undefined,
          publicKeyAlgorithm: r.getPublicKeyAlgorithm ? r.getPublicKeyAlgorithm() : undefined,
          publicKey: r.getPublicKey && r.getPublicKey() ? b64u.from(r.getPublicKey()) : undefined,
          authenticatorData: r.getAuthenticatorData ? b64u.from(r.getAuthenticatorData()) : undefined,
        },
      };
      const ver = await authApi('passkey/verify-registration', { method: 'POST', body: JSON.stringify({ response }) });
      if (!ver.ok) throw new Error(await apiError(ver, 'Couldn’t save the passkey'));
      syncMenu.hidden = true;
      toast('Passkey added. Next time, choose “Sign in with a passkey”.');
    } catch (err) {
      if (err && err.name === 'NotAllowedError') return; // cancelled
      toast(err && err.name === 'InvalidStateError' ? 'This device already has a passkey for your account' : `Passkey: ${err.message || err}`);
    }
  }

  async function passkeySignIn() {
    const errEl = $('#authError');
    try {
      const optRes = await authApi('passkey/generate-authenticate-options');
      if (!optRes.ok) throw new Error(await apiError(optRes, 'Couldn’t start'));
      const o = await optRes.json();
      const cred = await navigator.credentials.get({ publicKey: {
        ...o,
        challenge: b64u.toBuf(o.challenge),
        allowCredentials: (o.allowCredentials || []).map(c => ({ ...c, id: b64u.toBuf(c.id) })),
      } });
      const r = cred.response;
      const response = {
        id: cred.id, rawId: b64u.from(cred.rawId), type: cred.type,
        authenticatorAttachment: cred.authenticatorAttachment || undefined,
        response: {
          clientDataJSON: b64u.from(r.clientDataJSON),
          authenticatorData: b64u.from(r.authenticatorData),
          signature: b64u.from(r.signature),
          userHandle: r.userHandle ? b64u.from(r.userHandle) : undefined,
        },
      };
      const ver = await authApi('passkey/verify-authentication', { method: 'POST', body: JSON.stringify({ response }) });
      if (!ver.ok) throw new Error(await apiError(ver, 'That passkey didn’t work'));
      syncMenu.hidden = true;
      await startSync();
      toast('Signed in. Your boards are syncing.');
    } catch (err) {
      if (err && err.name === 'NotAllowedError') return; // cancelled
      if (errEl) errEl.textContent = err.message || 'Passkey sign-in failed';
    }
  }

  // ---- AI tools (MCP)
  const aiDlg = $('#aiDlg');
  async function openAiDialog() {
    syncMenu.hidden = true;
    const body = $('#aiBody');
    body.innerHTML = '<p class="dlg-text">Creating a key…</p>';
    aiDlg.showModal();
    try {
      const res = await fetch(API + 'ai-keys', { method: 'POST', credentials: 'same-origin' });
      if (!res.ok) throw new Error(res.status);
      const { token } = await res.json();
      const url = API + 'mcp';
      const claude = `claude mcp add --transport http tack ${url} --header "Authorization: Bearer ${token}"`;
      const config = JSON.stringify({ mcpServers: { tack: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);
      body.innerHTML = `
        <p class="dlg-text">Lets an AI assistant read and edit your boards through MCP. Changes show up here within a minute.
        Anyone with this key can edit your boards, so keep it private.</p>
        <h3>Claude Code</h3>
        <div class="codebox"><code id="aiClaude"></code><button type="button" data-copy="aiClaude">Copy</button></div>
        <h3>Other MCP apps</h3>
        <div class="codebox"><pre id="aiConfig"></pre><button type="button" data-copy="aiConfig">Copy</button></div>
        <p class="dlg-text small">API reference: <a href="${API}docs" target="_blank" rel="noopener">${API}docs</a></p>`;
      $('#aiClaude').textContent = claude;
      $('#aiConfig').textContent = config;
    } catch {
      body.innerHTML = '<p class="dlg-text">Couldn’t create a key. Check that you’re signed in and online.</p>';
    }
  }
  aiDlg.addEventListener('click', async e => {
    const b = e.target.closest('[data-copy]');
    if (b) {
      try { await navigator.clipboard.writeText($('#' + b.dataset.copy).textContent); b.textContent = 'Copied'; setTimeout(() => (b.textContent = 'Copy'), 1500); }
      catch { toast('Couldn’t copy. Select the text and copy it manually.'); }
    }
    if (e.target.id === 'aiRevoke') {
      if (!confirm('Disconnect every AI tool? Their keys stop working immediately.')) return;
      const res = await fetch(API + 'ai-keys', { method: 'DELETE', credentials: 'same-origin' }).catch(() => null);
      const n = res && res.ok ? (await res.json()).revoked : null;
      aiDlg.close();
      toast(n == null ? 'Couldn’t reach the server' : `Revoked ${n} AI key${n === 1 ? '' : 's'}`);
    }
  });

  async function signOut() {
    try { await fetch(API + 'auth/sign-out', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch {}
    sync.email = null;
    setSync('signed-out');
    syncMenu.hidden = true;
    toast('Signed out. Your boards are still on this device.');
  }
  syncBtn.onclick = () => {
    syncMenu.hidden = !syncMenu.hidden;
    if (!syncMenu.hidden) {
      drawSyncMenu();
      syncMenu.querySelector('input')?.focus();
    }
  };
  syncMenu.addEventListener('keydown', e => { if (e.key === 'Escape') { syncMenu.hidden = true; syncBtn.focus(); } });
  document.addEventListener('pointerdown', e => {
    if (!syncMenu.hidden && !e.target.closest('#syncMenu, #syncBtn')) syncMenu.hidden = true;
  });
  window.addEventListener('online', () => scheduleSync(0));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleSync(0); });
  setInterval(() => { if (!document.hidden) scheduleSync(0); }, 60000);

  // ---------- boot ----------
  function welcomeItems() {
    const st = (x, y, text, color) => ({ id: uid(), type: 'sticky', x, y, w: 200, h: 200, color, text });
    const line = (a, b, extra = {}) => ({ id: uid(), type: 'connector', from: { id: a.id, side: 'right' }, to: { id: b.id, side: 'left' }, endArrow: true, ...extra });
    const hub = st(-100, -100, 'Double-click anywhere to add a sticky note', STICKY_COLORS[0]);
    const a = st(300, -330, 'Hover a note, then drag one of its dots onto another note to connect them', STICKY_COLORS[4]);
    const b = st(300, 130, 'Drag a dot into empty space to spawn a new connected note', STICKY_COLORS[5]);
    const c = st(-500, -100, 'Select a note and press Tab to grow a mind map', STICKY_COLORS[2]);
    const title = { id: uid(), type: 'text', x: -500, y: -330, w: 560, h: 60, fontSize: 44, text: 'Welcome to Tack' };
    const sub = { id: uid(), type: 'text', x: -500, y: 150, w: 460, h: 60, fontSize: 20, color: '#8b8d98', text: 'Export: PNG up to 8×, vector SVG and PDF (sharp at any zoom), or JSON. Unlimited boards live in the menu, top-left.' };
    const box = { id: uid(), type: 'shape', shape: 'rect', x: 640, y: -100, w: 240, h: 140, text: 'Shapes take text too' };
    return [line(hub, a), line(hub, b, { label: 'labels too' }), line(c, hub), line(a, box), title, sub, hub, a, b, c, box];
  }

  const idx = store.get(INDEX_KEY, []);
  let startId = store.get(LAST_KEY);
  if (!idx.length) startId = createBoard('Welcome to Tack', welcomeItems(), { seed: true }).id;
  else if (!idx.some(b => b.id === startId)) startId = idx[0].id;
  openBoard(startId);
  setTool('select');
  startSync();
})();
