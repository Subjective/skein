/* Annotations and reader mode.
   Annotations: select text in a thread, side chat, file, plan, diff or terminal; a small popup offers
   "Add to Chat" / "Add to Side Chat". The quote becomes an inline item in the composer's text, so it
   can sit anywhere between what you type. Hovering it highlights the original text, clicking goes
   there, and an x on hover removes it.
   Reader mode: the Vim cursor over read-only text. The mouse and the keyboard do the same things,
   as with `set mouse=a`: click = move the cursor, drag = v, triple-click = V. */
(function () {
  let nid = 0;
  const HL = window.CSS && CSS.highlights;
  const q = k => `[data-src="${k.replace(/"/g, '\\"')}"]`;

  // text offsets <-> DOM ranges inside one data-src element
  function rangeIn(el, start, len) {
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), r = document.createRange(), end = start + len;
    let n, pos = 0, open = false;
    while ((n = w.nextNode())) {
      const L = n.data.length;
      if (!open && start < pos + L) { r.setStart(n, start - pos); open = true; }
      if (open && end <= pos + L) { r.setEnd(n, end - pos); return r; }
      pos += L;
    }
    return null;
  }
  function offsets(el, range) {
    const pre = document.createRange(); pre.selectNodeContents(el); pre.setEnd(range.startContainer, range.startOffset);
    const start = pre.toString().length;
    return { start, len: Math.max(1, Math.min(range.toString().length, el.textContent.length - start)) };
  }
  function current() {
    const s = getSelection(); if (!s.rangeCount || s.isCollapsed) return null;
    const r = s.getRangeAt(0), n = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;
    const src = n && n.closest('[data-src]');
    if (!src || !src.contains(r.endContainer)) return null;
    const text = s.toString().replace(/\s+/g, ' ').trim();
    return text ? { src, r, text } : null;
  }

  // ---- selection popup ----
  const bar = document.createElement('div');
  bar.className = 'seltb';
  bar.innerHTML = '<button data-k="chat" title="' + kb('mod-l') + '">Add to Chat</button><i></i><button data-k="side" title="' + kb('mod-shift-s') + '">Add to Side Chat</button>';
  bar.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); const b = e.target.closest('button'); if (b) Annot.add(b.dataset.k); });
  const hideBar = () => bar.remove();
  function showBar() {
    const c = current(); if (!c || (Reader.on && Reader.mode === 'n')) return hideBar();
    const b = c.r.getBoundingClientRect();
    document.body.appendChild(bar);
    bar.style.left = Math.max(8, Math.min(b.left, innerWidth - bar.offsetWidth - 8)) + 'px';
    bar.style.top = (b.top > 48 ? b.top - 38 : b.bottom + 8) + 'px';
  }
  let mouseRoot = null;
  document.addEventListener('mousedown', e => {
    mouseRoot = e.button === 0 && !e.target.closest('input, textarea, [contenteditable=true]')
      ? e.target.closest('[data-read]') : null;
  }, true);
  function boundDrag() {
    const s = getSelection();
    if (!mouseRoot || s.isCollapsed || !mouseRoot.contains(s.anchorNode)) return;
    const block = selectionBlock(s.anchorNode);
    if (!block || block.contains(s.focusNode)) return;
    const range = s.getRangeAt(0);
    const forward = range.endContainer === s.focusNode && range.endOffset === s.focusOffset;
    const nodes = Reader.texts(block, mouseRoot);
    const end = forward ? nodes.at(-1) : nodes[0];
    if (end) s.extend(end, forward ? end.length : 0);
  }
  document.addEventListener('selectionchange', () => { boundDrag(); if (!current()) hideBar(); });
  document.addEventListener('mouseup', e => {
    const root = mouseRoot;
    boundDrag();
    mouseRoot = null;
    if (!bar.contains(e.target)) setTimeout(() => { Reader.fromMouse(e, root); showBar(); }, 0);
  });
  window.addEventListener('blur', () => { mouseRoot = null; });

  const Annot = window.Annot = {
    has: () => !!current() && !(Reader.on && Reader.mode === 'n'),
    // kind: 'chat' | 'side'
    add(kind) {
      const c = current(); if (!c) return;
      const note = { id: 'a' + (++nid), key: c.src.dataset.src, text: c.text, ...offsets(c.src, c.r) };
      const host = App.tabAt(c.src), rect = c.r.getBoundingClientRect();
      Reader.off(); getSelection().removeAllRanges(); hideBar();
      App.addNote(host, note, kind, rect);
    },
    // for scenes: annotate the first occurrence of `text` inside a source
    quote(key, text) {
      const el = document.querySelector(q(key)), i = el ? el.textContent.indexOf(text) : -1;
      return i < 0 ? null : { id: 'a' + (++nid), key, text, start: i, len: text.length };
    },
    select(key, text) {   // for scenes: put a real selection on some text
      const el = document.querySelector(q(key)), i = el ? el.textContent.indexOf(text) : -1; if (i < 0) return;
      const r = rangeIn(el, i, text.length), s = getSelection(); s.removeAllRanges(); s.addRange(r); showBar();
    },
    // highlight every pending note where its source is on screen; `hot` is the hovered one
    paint(hot) {
      if (!HL) return;
      const norm = new Highlight(), h = new Highlight();
      for (const t of App.everyTab()) for (const n of t.notes) document.querySelectorAll(q(n.key)).forEach(el => { const r = rangeIn(el, n.start, n.len); if (r) (n.id === hot ? h : norm).add(r); });
      CSS.highlights.set('note', norm); CSS.highlights.set('note-hot', h);
    },
    reveal(n) {
      const el = document.querySelector(q(n.key)), r = el && rangeIn(el, n.start, n.len); if (!r) return false;
      (r.startContainer.parentElement || el).scrollIntoView({ block: 'center', behavior: 'smooth' });
      Annot.paint(n.id); setTimeout(() => Annot.paint(), 1400); return true;
    },
  };

  // ---- reader mode ----
  // f is the cursor, a the visual anchor; both are { n: text node, o: offset }.
  // mode: 'n' NORMAL (block cursor), 'v' VISUAL (characters), 'V' VISUAL LINE (whole lines).
  const textAt = (node, off) => {   // resolve any DOM position to a character in a text node
    if (node.nodeType === 3) return { n: node, o: Math.max(0, Math.min(off, node.data.length - 1)) };
    const kid = node.childNodes[off] || node.childNodes[node.childNodes.length - 1] || node;
    const w = document.createTreeWalker(kid, NodeFilter.SHOW_TEXT); let n = kid.nodeType === 3 ? kid : w.nextNode();
    while (n && !n.data.trim()) n = w.nextNode();
    return n ? { n, o: 0 } : null;
  };
  function selectionBlock(node) {
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return el.closest('.diff, pre.out, summary, .ag, .sc-link, [data-src], .reply > *, .thread [data-read] > :not(.reply)');
  }
  const Reader = window.Reader = {
    on: false, mode: 'n', root: null, prev: null, a: null, f: null,
    get visual() { return Reader.on && Reader.mode !== 'n'; },
    // Lines that are a single thing rather than prose: the cursor takes the whole line.
    ROWS: '.tool > summary, .cfile > summary, .dgap, .tool > .sum, .ag, .sc-link, .sc-anchor, .appr.plan .ah, .appr .af, .worked, .err-row, .note-row',
    // where the cursor may go: any text of the tab, except controls that are not rows themselves
    inside: (n, root = Reader.root) => { const e = n && (n.parentElement || n); return !!e && root.contains(n) && !e.closest('input, textarea, .hov, .m-acts, .comp, .dl > .n, .t-dl > .n') && !(e.closest('button') && !e.closest('.ag, .sc-link, .sc-anchor, .af, .dgap')); },
    // From the keyboard: start on the very last line above the composer, whatever it is (prose, a row,
    // the status line), so that k then j always retrace the same lines.
    enter(tab) {
      const root = document.querySelector(`[data-tab="${tab.id}"] [data-read]`); if (!root) return false;
      Reader.root = root;   // inside() needs the root
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let n, node = null;
      while ((n = w.nextNode())) if (n.data.trim() && Reader.inside(n) && !n.parentElement.closest('.t-foot, .t-prompt, .tui-menu')) node = n;   // in a terminal: output, not the prompt's footer
      if (!node) return false;
      Reader.begin(root, { vim: S.vim, cn: S.cn }, 'n', { n: node, o: node.data.trimEnd().length - 1 });
      if (!Reader.row) Reader.key('0');   // the start of that line
      return true;
    },
    begin(root, prev, mode, f, a) {
      Reader.off();
      if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
      Object.assign(Reader, { on: true, mode, root, prev, f, a: a || f, bound: null });
      if (mode !== 'n') {   // a drag that ran past its block is cut back to the block's edge
        const bd = Reader.block(Reader.a); Reader.bound = bd;
        if (bd && !bd.contains(f.n)) {
          const ns = Reader.texts(bd);
          const after = Reader.a.n.compareDocumentPosition(f.n) & Node.DOCUMENT_POSITION_FOLLOWING, e = ns[after ? ns.length - 1 : 0];
          if (e) Reader.f = { n: e, o: after ? e.data.length - 1 : 0 };
        }
      }
      S.vim = 'NORMAL'; Reader.draw();
    },
    // A place that survives the tab being drawn again: the cursor's text (or row) by its position in the tab.
    // (The mock counts text nodes; the app should store the block's key and an offset inside it, so that a
    // thread that has grown or re-flowed since still resolves.)
    tick: 0,
    texts(el, root = Reader.root) { const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), ns = []; let n; while ((n = w.nextNode())) if (n.data.trim() && Reader.inside(n, root)) ns.push(n); return ns; },
    mark() {
      const tab = Reader.on && Reader.root.isConnected && Reader.root.closest('[data-tab]'); if (!tab) return null;
      const m = { tab: tab.dataset.tab, prev: Reader.prev, tick: Reader.tick };
      if (Reader.row) m.row = [...Reader.root.querySelectorAll(Reader.ROWS)].indexOf(Reader.row); else { m.ti = Reader.texts(Reader.root).indexOf(Reader.f.n); m.o = Reader.f.o; }
      return m;
    },
    goto(m) {
      const root = document.querySelector(`[data-tab="${m.tab}"] [data-read]`); if (!root) return false;
      Reader.root = root; let n, o = m.o || 0;
      if (m.row != null) { const row = root.querySelectorAll(Reader.ROWS)[m.row]; n = row && Reader.texts(row)[0]; o = n ? n.data.length - n.data.trimStart().length : 0; } else n = Reader.texts(root)[m.ti];
      if (!n) return false;
      Reader.begin(root, m.prev || { vim: 'NORMAL', cn: true }, 'n', { n, o: Math.max(0, Math.min(o, n.data.length - 1)) }); return true;
    },
    toRow(row) { if (!row || !Reader.on) return; const n = Reader.texts(row)[0]; if (!n) return; Reader.f = { n, o: n.data.length - n.data.trimStart().length }; Reader.draw(); },   // put the cursor on a row (a file in Changes)
    off() { if (!Reader.on) return; Reader.last = Reader.mark();   // whoever turned it off to open something can still ask where it was (during the same key press or click)
      if (HL) CSS.highlights.delete('vcur'); document.querySelectorAll('.rowcur, .src .dl.curl').forEach(x => x.classList.remove('rowcur', 'curl')); Reader.row = null; Reader.root.classList.remove('rd', 'rv'); Reader.on = false; Reader.mode = 'n'; hideBar(); },
    exit() {   // back to where we came from (the composer, in NORMAL)
      const p = Reader.prev || {}; Reader.off(); getSelection().removeAllRanges();
      S.vim = p.vim || 'NORMAL'; S.cn = !!p.cn; if (S.cn || S.vim === 'INSERT') App.refocus(); App.renderStatus();
    },
    // paint the cursor / selection for the current mode
    draw() {
      const s = getSelection(), { a, f, mode, root } = Reader, end = p => Math.min(p.o + 1, p.n.data.length);
      root.classList.add('rd'); root.classList.toggle('rv', mode !== 'n');
      // On a row the cursor is the row: no character is picked out, and h / l fold and unfold instead of moving.
      document.querySelectorAll('.rowcur').forEach(x => x.classList.remove('rowcur'));
      document.querySelectorAll('.src .dl.curl').forEach(x => x.classList.remove('curl'));   // an open file shows the cursor's line
      const fl = f.n.parentElement.closest('.src .dl'); if (fl) fl.classList.add('curl');
      const row = mode === 'n' ? f.n.parentElement.closest(Reader.ROWS) : null; Reader.row = row && root.contains(row) ? row : null;
      if (Reader.row) {
        Reader.row.classList.add('rowcur'); if (HL) CSS.highlights.delete('vcur'); s.removeAllRanges();
        Reader.row.scrollIntoView({ block: 'nearest' }); hideBar(); App.renderStatus(); return;
      }
      // NORMAL: the cursor is a painted highlight, not a selection. A real one-character selection
      // under the pointer breaks double-click: the browser treats the second press as the start of
      // dragging that selected text instead of selecting the word.
      if (mode === 'n') { if (HL) s.removeAllRanges(); else s.setBaseAndExtent(f.n, f.o, f.n, end(f)); }
      else {
        const r = document.createRange(); r.setStart(a.n, a.o); r.collapse(true);
        const [st, en] = r.comparePoint(f.n, f.o) >= 0 ? [a, f] : [f, a];
        if (mode === 'v') s.setBaseAndExtent(st.n, st.o, en.n, end(en));
        else {   // whole lines: from the start of the first line to the end of the last
          const bd = Reader.bound, within = n => !bd || bd.contains(n);   // a line's ends, but never outside the block
          s.setBaseAndExtent(st.n, st.o, st.n, st.o); s.modify('move', 'backward', 'lineboundary');
          const [sn, so] = within(s.focusNode) ? [s.focusNode, s.focusOffset] : [st.n, 0];
          s.setBaseAndExtent(en.n, en.o, en.n, en.o); s.modify('move', 'forward', 'lineboundary');
          const [fn, fo] = within(s.focusNode) ? [s.focusNode, s.focusOffset] : [en.n, en.n.data.length];
          s.setBaseAndExtent(sn, so, fn, fo);
        }
      }
      if (f.n.parentElement) f.n.parentElement.scrollIntoView({ block: 'nearest' });
      if (HL) {   // the cursor itself, in every mode; in VISUAL / V-LINE it marks the end that moves
        const c = document.createRange(); c.setStart(f.n, f.o); c.setEnd(f.n, end(f)); CSS.highlights.set('vcur', new Highlight(c));
      }
      if (mode === 'n') hideBar(); else showBar();
      App.renderStatus();
    },
    // Word motions, done on the text itself so they mean what they mean in Vim on every platform:
    // w = first letter of the next word, e = last letter of this or the next word, b = first letter
    // of this or the previous word. A new paragraph or line counts as a break between words.
    word(k) {
      const w = document.createTreeWalker(Reader.root, NodeFilter.SHOW_TEXT), ns = []; let n;
      while ((n = w.nextNode())) if (n.data.length && Reader.inside(n)) ns.push(n);
      const step = (p, d) => { const o = p.o + d; if (o >= 0 && o < p.n.data.length) return { n: p.n, o }; const m = ns[ns.indexOf(p.n) + d]; return m ? { n: m, o: d > 0 ? 0 : m.data.length - 1 } : null; };
      const sp = p => p.n.data[p.o].trim() === '';
      const blk = p => p.n.parentElement.closest('p, li, div, summary, pre, h1, h2, h3, figcaption, button');
      const gap = (a, b) => blk(a) !== blk(b);
      let q = Reader.f, r;
      if (k === 'w') {
        let crossed = sp(q);
        for (;;) { r = step(q, 1); if (!r) return null; if (gap(q, r)) crossed = true; q = r; if (sp(q)) crossed = true; else if (crossed) return q; }
      }
      const d = k === 'e' ? 1 : -1;
      q = step(q, d); if (!q) return null;
      while (sp(q)) { q = step(q, d); if (!q) return null; }
      for (;;) { r = step(q, d); if (!r || sp(r) || gap(q, r)) return q; q = r; }
    },
    // VISUAL and V-LINE are bounded by the block the selection started in, as if its first and last
    // lines were the ends of a file. Back in NORMAL, j and k cross into the next block again.
    ok: p => Reader.mode === 'n' || !Reader.bound || Reader.bound.contains(p.n),
    // the block a selection is confined to: the innermost one. Inside a tool call that is its diff or its
    // output, not the whole call, so a selection cannot climb onto the call's header row or beyond.
    block: p => selectionBlock(p.n),
    land(node, off) { const p = node && Reader.inside(node) ? textAt(node, off) : null; if (!p || !Reader.inside(p.n) || !Reader.ok(p)) return false; Reader.f = p; return true; },
    at(key) { const el = document.querySelector(q(key)), n = el && document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode(); if (n) { Reader.f = Reader.a = { n, o: 0 }; Reader.draw(); } },
    // Mouse does what the keys do: click moves the cursor, drag is v, triple-click is V.
    fromMouse(e, root) {
      if (!S.vimOn || !root?.isConnected) return;
      const s = getSelection(), term = root.matches('.term');
      const actionable = e.target.closest('button, input, textarea, summary, img, [data-act]');
      if (s.isCollapsed && (actionable || !root.contains(e.target))) return;
      // In a terminal a plain click still means "type at the prompt"; only a drag or triple-click selects.
      if (term && s.isCollapsed && e.detail < 3) return;
      const back = term ? { vim: 'INSERT', cn: false } : { vim: 'NORMAL', cn: true };   // leaving returns to the prompt / the composer
      const c = document.caretRangeFromPoint(e.clientX, e.clientY), at = c && c.startContainer.nodeType === 3 && root.contains(c.startContainer) && c.startContainer.data.trim() ? textAt(c.startContainer, c.startOffset) : null;
      if (e.detail >= 3 && at) return Reader.begin(root, back, 'V', at);
      if (!s.isCollapsed && root.contains(s.anchorNode)) {
        const fwd = s.anchorNode.compareDocumentPosition(s.focusNode) & Node.DOCUMENT_POSITION_FOLLOWING || (s.anchorNode === s.focusNode && s.focusOffset >= s.anchorOffset);
        const a = textAt(s.anchorNode, fwd ? s.anchorOffset : s.anchorOffset - 1), f = textAt(s.focusNode, fwd ? s.focusOffset - 1 : s.focusOffset);
        // a double-click selects a word; browsers (Windows especially) include the space after it, which
        // would leave the cursor on a blank. Keep just the word, with the cursor on its last letter.
        if (a && f && e.detail === 2 && fwd) while (f.o > 0 && f.n.data[f.o].trim() === '' && (f.n !== a.n || f.o > a.o)) f.o--;
        if (a && f) return Reader.begin(root, back, 'v', f, a);
      }
      if (at) Reader.begin(root, back, 'n', at);
    },
    key(k) {
      const s = getSelection(), f = Reader.f;
      const go = (dir, gran) => { s.setBaseAndExtent(f.n, f.o, f.n, f.o); s.modify('move', dir, gran); return Reader.land(s.focusNode, s.focusOffset); };
      const vert = d => {   // line up / down by geometry, which works on any static text
        const fr = document.createRange(); fr.setStart(f.n, f.o); fr.setEnd(f.n, Math.min(f.o + 1, f.n.data.length));
        const row = Reader.mode === 'n' ? Reader.row : null, rect = row ? row.getBoundingClientRect() : fr.getClientRects()[0]; if (!rect) return false;
        const x = row ? (Reader.x || rect.left + 12) : rect.left + 2; if (!row) Reader.x = x;
        const sc = Reader.root.closest('.thread, .term, .tool-b') || Reader.root, lh = row ? 18 : Math.max(14, rect.height);
        // What is on the line at height y: the text straight above / below if there is some, otherwise the
        // nearest text on that line (your own messages sit to the right, so they would be skipped otherwise).
        const probe = y => {
          const b = sc.getBoundingClientRect(), xs = [x]; for (let px = b.left + 10; px < b.right - 4; px += 18) xs.push(px);
          let best = null, bd = Infinity;
          for (const px of xs) {
            const c = document.caretRangeFromPoint(px, y);
            if (!c || c.startContainer.nodeType !== 3 || !Reader.inside(c.startContainer) || !c.startContainer.data.trim()) continue;
            if (row && row.contains(c.startContainer)) continue;
            const cr = c.getClientRects()[0];
            if (cr && ((!row && Math.abs(cr.top - rect.top) < 3) || y < cr.top - 3 || y > cr.bottom + 3)) continue;   // same line, or snapped from another line
            const dist = Math.abs(px - x); if (dist < bd) { bd = dist; best = c; } if (px === x) break;
          }
          return best;
        };
        for (let i = 1; i <= 16; i++) {
          let y = d > 0 ? rect.bottom + i * lh * 0.55 - 3 : rect.top - i * lh * 0.55 + 3;
          const b = sc.getBoundingClientRect();
          if (y > b.bottom - 4 || y < b.top + 4) { const before = sc.scrollTop; sc.scrollTop += d * lh * 4; y -= sc.scrollTop - before; if (y > b.bottom - 4 || y < b.top + 4) return false; }
          const c = probe(y); if (!c) continue;
          return Reader.land(c.startContainer, c.startOffset);
        }
        return false;
      };
      const set = m => { Reader.mode = Reader.mode === m ? 'n' : m; };   // v and V toggle; switching between them keeps the anchor
      // j and k move one line at a time, the same in both directions. Bigger steps have their own keys,
      // also the same both ways: { } by block, [[ ]] by your own messages, gg to the top.
      const firstText = el => { const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) if (n.data.trim() && Reader.inside(n)) return { n, o: n.data.length - n.data.trimStart().length }; return null; };
      const jump = (list, d) => {   // to the nearest element of the list before (d < 0) or after (d > 0) the cursor
        const rel = d < 0 ? Node.DOCUMENT_POSITION_FOLLOWING : Node.DOCUMENT_POSITION_PRECEDING;
        const hits = list.filter(el => !el.contains(f.n) && (el.compareDocumentPosition(f.n) & rel)), el = d < 0 ? hits[hits.length - 1] : hits[0], p = el && firstText(el);
        if (!p || !Reader.ok(p)) return false; Reader.f = p; return true;
      };
      const settle = () => { if (Reader.mode === 'n') { Reader.a = Reader.f; Reader.bound = null; } Reader.draw(); };
      const blocks = () => [...Reader.root.querySelectorAll('[data-src], .ag, .sc-link, .sc-anchor, .appr.plan .ah')].filter(el => !el.parentElement.closest('[data-src]'));
      if (k === 'block-start') { const b = blocks().find(el => el.contains(f.n)), p = b && firstText(b); if (p && Reader.ok(p)) Reader.f = p; return settle(); }   // arriving from the composer with {
      if (Reader.br) {   // [[ and ]]: previous / next message of yours
        const b = Reader.br; Reader.br = null; if (k !== b) return;
        const mine = [...Reader.root.querySelectorAll('[data-user]')];
        if (!jump(mine, b === '[' ? -1 : 1) && b === ']' && Reader.mode === 'n') return Reader.exit();   // past your last message is the composer
        return settle();
      }
      if (Reader.g) {   // g f: open the file reference under the cursor; g g: top
        Reader.g = false;
        if (k === 'g') { const p = firstText(Reader.root); if (p && Reader.ok(p)) Reader.f = p; return settle(); }
        const link = k === 'f' && f.n.parentElement.closest('.flink');
        if (link) { const t = App.tabAt(link); Reader.off(); getSelection().removeAllRanges(); S.cn = false; App.act.openFile(link, t, null, App.focused()); }
        return;
      }
      if (Reader.mode === 'n' && k === '/' && Reader.root.querySelector('.cfile')) {   // Changes: / searches the file tree
        const q = Reader.root.closest('[data-tab]').querySelector('[data-input=tq]'); if (q) { Reader.off(); getSelection().removeAllRanges(); S.vim = 'INSERT'; q.focus(); q.select(); App.renderStatus(); } return;
      }
      if (Reader.row && Reader.mode === 'n') {   // on a row: l unfolds, h folds, enter opens; no sideways movement
        const row = Reader.row, det = row.matches('summary') ? row.parentElement : null;
        if (row.matches('.cfile > summary') && (k === 's' || k === 'x')) {   // a changed file: s stages it, x reverts it (with Undo)
          const b = row.querySelector(k === 's' ? '.cb' : '[data-act=revertFile]'), p = row.parentElement.dataset.p;
          Reader.off(); b.click();
          if (k === 's') { const t = App.curTab(); if (Reader.enter(t)) Reader.toRow(document.querySelector(`[data-tab="${t.id}"] .cfile[data-p="${CSS.escape(p)}"] > summary`)); }
          return;
        }
        if (row.matches('.af')) {   // a request's answers: h / l choose, enter presses. It starts on the main one.
          const bs = [...row.querySelectorAll('button')], c = row.querySelector('.kcur') || row.querySelector('.primary') || bs[0], i = bs.indexOf(c);
          const d = k === 'l' || k === 'ArrowRight' ? 1 : k === 'h' || k === 'ArrowLeft' ? -1 : 0;
          if (d) { bs.forEach(b => b.classList.remove('kcur')); bs[Math.max(0, Math.min(bs.length - 1, i + d))].classList.add('kcur'); return; }
          if (k === 'Enter' || k === 'o') { Reader.off(); c.click(); return; }
        }
        if (k === 'l' || k === 'ArrowRight') { if (det) det.open = true; return Reader.draw(); }
        if (k === 'h' || k === 'ArrowLeft') { if (det) det.open = false; return Reader.draw(); }
        if (k === 'Enter' || k === 'o') {
          if (det) { det.open = !det.open; return Reader.draw(); }
          // nothing to unfold: a row that names a file (Read) opens it; a button row is pressed; anything else stays put
          const link = row.querySelector('.flink'), b = row.matches('button') ? row : row.querySelector('button');
          if (link) { const t = App.tabAt(link); Reader.off(); getSelection().removeAllRanges(); S.cn = false; App.act.openFile(link, t, null, App.focused()); }
          else if (b) { Reader.off(); b.click(); }
          return;
        }
        if ('wbe0$'.includes(k)) return;
      }
      // In a file, an editing key starts editing at the cursor: the source becomes a field and the key acts there.
      const fsrc = Reader.mode === 'n' && !Reader.row && f.n.parentElement.closest('[data-src^="file:"]');
      if (fsrc && k.length === 1 && 'iaIAoOcCdDx'.includes(k)) {
        const t = App.tabAt(fsrc), raw = Tools.text(t), line = f.n.parentElement.closest('.dl'); let pos = 0;
        if (line) { const ls = raw.split(String.fromCharCode(10)), i = [...fsrc.children].indexOf(line); pos = ls.slice(0, i).join(String.fromCharCode(10)).length + (i ? 1 : 0) + Math.min(f.o, ls[i].length); }   // source view: line and column
        else { const lead = f.n.data.length - f.n.data.trimStart().length, at = raw.indexOf(f.n.data.trim().slice(0, 24)); pos = at < 0 ? 0 : at + Math.max(0, f.o - lead); }   // preview: find the same words in the source
        Reader.off(); getSelection().removeAllRanges(); App.act.fileEdit(t, pos, k); return;
      }
      const mine = Reader.mode === 'n' && !Reader.row && f.n.parentElement.closest('.m-user.can-edit');
      if (mine && k.length === 1 && 'iaIAcCdDx'.includes(k)) {
        // where the cursor is in the message as typed: the rendered text has no backticks or ** marks
        const box = mine.querySelector(':scope > div') || mine, pre = document.createRange(); pre.selectNodeContents(box); pre.setEnd(f.n, f.o);
        const shown = pre.toString().length, t = App.tabAt(mine);
        Reader.off(); getSelection().removeAllRanges(); S.cn = false; App.act.edit(mine, t);
        const ta = document.activeElement; if (!ta || !ta.matches('.m-edit textarea')) return;
        const raw = ta.value; let pos = raw.length, seen = 0;
        for (let i = 0; i < raw.length; i++) { if (raw[i] === '`') continue; if (raw[i] === '*' && raw[i + 1] === '*') { i++; continue; } if (seen === shown) { pos = i; break; } seen++; }
        S.cn = true; S.vim = 'NORMAL'; Vim.block(ta, pos); Vim.key(ta, k); App.renderStatus();   // then the key does what it does in a composer
        return;
      }
      switch (k) {
        case 'g': Reader.g = true; return;
        case '[': case ']': Reader.br = k; return;
        case '{': jump(blocks(), -1); break;
        case '}': if (!jump(blocks(), 1) && Reader.mode === 'n') return Reader.exit(); break;
        case 'h': go('backward', 'character'); break;
        case 'l': go('forward', 'character'); break;
        case 'w': case 'e': case 'b': { const p = Reader.word(k); if (p && Reader.ok(p)) Reader.f = p; break; }
        case '0': go('backward', 'lineboundary'); break;
        case '$': go('forward', 'lineboundary'); break;
        case 'k': vert(-1); break;
        case 'j': if (!vert(1) && Reader.mode === 'n') return Reader.exit(); break;
        case 'v': case 'V': if (Reader.mode === 'n') Reader.a = Reader.f; set(k); Reader.bound = Reader.mode === 'n' ? null : Reader.block(Reader.a); break;
        case 'y': if (navigator.clipboard) navigator.clipboard.writeText(s.toString()).catch(() => {}); Reader.mode = 'n'; break;
        case 'Escape': if (Reader.mode !== 'n') Reader.mode = 'n'; else return Reader.exit(); break;
        case 'q': return Reader.exit();
        case 'G': {   // the bottom of the document is the composer's last line
          Reader.exit(); const ta = document.activeElement;
          if (ta && ta.matches('textarea[data-input]')) Vim.block(ta, ta.value.lastIndexOf(String.fromCharCode(10)) + 1);
          return;
        }
        case 'i': case 'a': {   // anywhere that is not one of your messages: straight back to typing
          Reader.exit(); const ta = document.activeElement;
          if (ta && ta.matches('[data-input]')) Vim.insert(ta, ta.value.length);   // a composer or a terminal prompt
          return;
        }
        default: return;
      }
      if (Reader.mode === 'n') { Reader.a = Reader.f; Reader.bound = null; }
      Reader.draw();
    },
  };
  ['keydown', 'mousedown'].forEach(ev => document.addEventListener(ev, () => { Reader.tick++; }, true));   // one count per key press or click
})();
