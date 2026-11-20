/* Keymap.
   App NORMAL  — nothing is being typed into; plain keys drive the app (sidebar, tabs, panes).
   INSERT      — keys go to the focused composer or terminal.
   Composer NORMAL — Vim editing inside a composer (block cursor, motions). esc from INSERT enters it,
                     esc again leaves the composer. Applies to every composer: thread, side chat,
                     new thread, and the edit-a-message box.
   TERMINAL    — a terminal view owns its input line (it is the harness's TUI or a shell running in a pty).
                 Every key goes to the program, esc included (esc interrupts a turn, esc esc rewinds).
                 Only the leader, alt-h/j/k/l and the app's own modifier shortcuts are kept back.
                 Leader [ (or leader esc) opens the scrollback as a reader; i, q or esc there return to the program.
   Pane and tab commands are reachable from anywhere through the leader. With Vim keys off in Settings
   there are no modes: esc just leaves the composer, and the leader, the modifier keys and arrows still work.
   Modifiers follow the OS (App.OS): app commands use cmd on a Mac and ctrl on Windows; Vim's own
   ctrl keys (ctrl-o, ctrl-i, ctrl-w, ctrl-n/p in lists) and the leader are ctrl on both. */
(function () {
  const A = App, S = A.S;
  let g = false, op = null, brk = false;

  // ---- Vim editing in a textarea. The block cursor is a one-character selection. ----
  // Undo history per field (a composer, an edit box, a file), kept by tab so it survives the tab being drawn again.
  // A step is taken before each NORMAL edit and when INSERT starts, so a whole run of typing undoes as one.
  const hist = new Map();
  const hkey = ta => { const t = A.tabAt(ta); return (t ? t.id : '?') + ':' + ta.dataset.input + (ta.closest('.m-edit') ? ':edit' : ''); };
  const Vim = window.Vim = {
    snap(ta) {
      const h = hist.get(hkey(ta)) || { u: [], r: [] }, top = h.u[h.u.length - 1];
      if (!top || top.v !== ta.value) { h.u.push({ v: ta.value, p: S.cn ? S.cpos : ta.selectionStart }); h.r = []; }
      if (h.u.length > 200) h.u.shift(); hist.set(hkey(ta), h);
    },
    undo(ta, redo) {   // u / ctrl-r
      const h = hist.get(hkey(ta)); if (!h) return;
      const from = redo ? h.r : h.u, to = redo ? h.u : h.r;
      let st = from.pop(); while (st && st.v === ta.value) st = from.pop();   // skip steps that changed nothing
      if (!st) return A.toast && A.toast(redo ? 'Already at newest change' : 'Already at oldest change', 1400);
      to.push({ v: ta.value, p: S.cpos });
      ta.value = st.v; ta.dispatchEvent(new Event('input', { bubbles: true })); Vim.block(ta, Math.min(st.p, Math.max(0, st.v.length - 1)));
    },
    // NORMAL cursor. On a character it is that character, selected. Where there is no character
    // (empty composer, empty line) it is the caret itself, drawn as a block.
    block(ta, pos) {
      const v = ta.value, n = v.length; pos = Math.max(0, Math.min(pos, n));
      if (pos > 0 && (pos === n || v[pos] === '\n') && v[pos - 1] !== '\n') pos--;   // never rest past the end of a line
      const hollow = pos >= n || v[pos] === '\n';
      const tk = Vim.tokAt(v, pos); if (tk) pos = tk[0];   // a quote is one block: the cursor covers all of it
      ta.classList.add('vn'); ta.classList.toggle('hollow', hollow && !tk); ta.classList.remove('vv');
      ta.setSelectionRange(pos, tk ? tk[1] : hollow ? pos : pos + 1); S.cpos = pos; A.paintBk(ta);
    },
    // VISUAL (S.cv 'v'): anchor to cursor, inclusive. VISUAL LINE (S.cv 'V'): the whole lines they touch.
    // Returns the range an operator acts on.
    span(ta) {
      const v = ta.value, n = v.length; let a = Math.min(S.va, S.cpos), b = Math.min(n, Math.max(S.va, S.cpos) + 1);
      const q1 = Vim.tokAt(v, a), q2 = Vim.tokAt(v, b - 1); if (q1) a = q1[0]; if (q2) b = q2[1];   // a quote is selected whole or not at all
      ta.classList.add('vn', 'vv'); ta.classList.remove('hollow');
      if (S.cv === 'V') { a = v.lastIndexOf('\n', a - 1) + 1; b = v.indexOf('\n', b - 1); if (b < 0) b = n; ta.setSelectionRange(a, b); A.paintBk(ta); return [a, Math.min(n, b + 1)]; }
      ta.setSelectionRange(a, b, S.cpos < S.va ? 'backward' : 'forward'); A.paintBk(ta);
      return [a, b];
    },
    // a quoted selection in the text is one item, wrapped in invisible U+2063 marks. Returns its [start, end) if p is inside one.
    tokAt(v, p) { const re = /\u2063[^\u2063]*\u2063/g; let m; while ((m = re.exec(v))) if (p >= m.index && p < m.index + m[0].length) return [m.index, m.index + m[0].length]; return null; },
    normal(ta) { S.cn = true; S.cv = false; S.vim = 'NORMAL'; Vim.block(ta, ta.selectionStart - 1); A.renderStatus(); },
    insert(ta, pos) { Vim.snap(ta); S.cn = false; S.cv = false; S.vim = 'INSERT'; op = null; ta.classList.remove('vn', 'vv', 'hollow'); ta.setSelectionRange(pos, pos); A.paintBk(ta); A.renderStatus(); },
    leave(ta) { S.cn = false; S.cv = false; S.vim = 'NORMAL'; op = null; ta.classList.remove('vn', 'vv', 'hollow'); ta.blur(); A.renderStatus(); },
    edit(ta, from, to, text = '') { if (S.cn) Vim.snap(ta); ta.setRangeText(text, from, to, 'end'); ta.dispatchEvent(new Event('input', { bubbles: true })); },
    // where a motion key takes the cursor; undefined if `k` is not a motion, 'up' when k leaves the top
    motion(v, p, k) {
      const n = v.length, ls = v.lastIndexOf('\n', p - 1) + 1; let le = v.indexOf('\n', p); if (le < 0) le = n;
      const eol = Math.max(ls, le - 1), sp = c => /\s/.test(c);
      switch (k) {
        case 'h': return Math.max(ls, p - 1);
        case 'l': return Math.min(eol, p + 1);
        case '0': return ls;
        case '$': return eol;
        case 'w': { let i = p; while (i < n && !sp(v[i])) i++; while (i < n && sp(v[i])) i++; return Math.min(i, Math.max(0, n - 1)); }
        case 'b': { let i = p; while (i > 0 && sp(v[i - 1])) i--; while (i > 0 && !sp(v[i - 1])) i--; return i; }
        case 'e': { let i = p + 1; while (i < n && sp(v[i])) i++; while (i < n - 1 && !sp(v[i + 1])) i++; return Math.min(i, Math.max(0, n - 1)); }
        case 'j': { if (le >= n) return p; let ne = v.indexOf('\n', le + 1); if (ne < 0) ne = n; return Math.min(le + 1 + (p - ls), Math.max(le + 1, ne - 1)); }
        case 'k': { if (!ls) return 'up'; const ps = v.lastIndexOf('\n', ls - 2) + 1; return Math.min(ps + (p - ls), Math.max(ps, ls - 2)); }
      }
    },
    key(ta, k) {
      const v = ta.value, n = v.length, p = S.cv ? S.cpos : ta.selectionStart;
      const ls = v.lastIndexOf('\n', p - 1) + 1; let le = v.indexOf('\n', p); if (le < 0) le = n;
      const tk = Vim.tokAt(v, p), from = tk ? ('lwe$'.includes(k) ? tk[1] - 1 : tk[0]) : p;
      const to = Vim.motion(v, from, k);

      if (S.cv) {                                          // VISUAL: motions extend, operators act on the selection
        if (typeof to === 'number') { S.cpos = to; Vim.span(ta); return; }
        const [a, b] = Vim.span(ta);
        if (k === 'd' || k === 'x') { S.cv = false; Vim.edit(ta, a, b); Vim.block(ta, a); }
        else if (k === 'c') { Vim.edit(ta, a, b); Vim.insert(ta, a); }
        else if (k === 'y') { if (navigator.clipboard) navigator.clipboard.writeText(v.slice(a, b)).catch(() => {}); S.cv = false; Vim.block(ta, a); }
        else if (k === 'Escape' || k === S.cv) { S.cv = false; Vim.block(ta, S.cpos); }   // v / V again, or esc, leaves
        else if (k === 'v' || k === 'V') { S.cv = k; Vim.span(ta); }                       // switch between the two
        A.renderStatus(); return;
      }
      if (op) {                                            // an operator is waiting: dd / cc, or c / d with a motion
        const o = op; op = null;
        if (k !== o) {
          const cw = o === 'c' && k === 'w', m = Vim.motion(v, from, cw ? 'e' : k);   // cw changes to the end of the word, as in Vim
          if (typeof m !== 'number') return;
          const a = Math.min(p, m), b = Math.min(n, Math.max(p, m) + (cw || k === 'e' || k === '$' ? 1 : 0));
          Vim.edit(ta, a, b); if (o === 'c') Vim.insert(ta, a); else Vim.block(ta, a);
          return;
        }
        if (o === 'd') { const a = ls > 0 && le === n ? ls - 1 : ls, b = le < n ? le + 1 : le; Vim.edit(ta, a, b); Vim.block(ta, a); }
        else { Vim.edit(ta, ls, le); Vim.insert(ta, ls); }
        return;
      }
      if (to === 'up') { S.cpos = p; Reader.enter(A.tabAt(ta)); return; }   // above the first line is the conversation: read it with the same keys
      if (typeof to === 'number') return Vim.block(ta, to);
      // The thread and the composer below it read as one document: gg is the top of the thread,
      // G is the bottom, which is the composer's last line.
      if (Vim.g) { Vim.g = false; if (k === 'g') { S.cpos = p; if (Reader.enter(A.tabAt(ta))) { Reader.key('g'); Reader.key('g'); } } return; }
      switch (k) {
        case 'g': Vim.g = true; break;
        case 'G': Vim.block(ta, v.lastIndexOf(String.fromCharCode(10)) + 1); break;   // start of the last line
        case 'v': case 'V': S.cv = k; S.va = S.cpos = p; Vim.span(ta); A.renderStatus(); break;
        case 'i': Vim.insert(ta, p); break;
        case 'a': Vim.insert(ta, tk ? tk[1] : Math.min(le, p + 1)); break;
        case 'I': Vim.insert(ta, ls); break;
        case 'A': Vim.insert(ta, le); break;
        case 'o': Vim.edit(ta, le, le, '\n'); Vim.insert(ta, le + 1); break;
        case 'x': if (p < le) { const tk = Vim.tokAt(v, p) || [p, p + 1]; Vim.edit(ta, tk[0], tk[1]); Vim.block(ta, tk[0]); } break;   // a quote goes as one item
        case 'D': Vim.edit(ta, p, le); Vim.block(ta, p); break;
        case 'C': Vim.edit(ta, p, le); Vim.insert(ta, p); break;
        case 'd': case 'c': op = k; break;
        case 'u': Vim.undo(ta); break;
        case ':': A.cmdline(); break;
        case '?': A.keysSheet(); break;
        case 'Escape':                                     // leave the composer; in an edit box, cancel the edit and stay on that message
          if (ta.closest('.m-edit')) A.act.editCancel(null, A.tabAt(ta), true); else if (ta.dataset.input === 'file') A.act.fileDone(A.tabAt(ta)); else if (S.pf && ta.closest('.peek')) A.act.peekClose(); else Vim.leave(ta);   // in a popup, esc from NORMAL closes it
          break;
      }
    },
  };

  // a field entered straight into INSERT (a click, a new tab) starts a step too
  document.addEventListener('focusin', e => { if (e.target.matches && e.target.matches('textarea[data-input]')) Vim.snap(e.target); });

  // ---- the composer's controls ----
  // Below a composer's text is a row of controls, and under a new thread's composer a second row
  // (machine, directory, worktree). They are a list: j from the text's last line moves down onto them,
  // h / l move along a row, j / k between rows and back up to the text, enter presses the control.
  const Ctl = window.Ctl = {
    cur: null,
    rows(el) {
      const col = el.closest('.col') || el.closest('.m-edit') || el.parentElement, vis = x => x.offsetParent !== null;
      return [[...col.querySelectorAll('.comp .cf > button')], [...col.querySelectorAll('.under.pick > button')], [...col.querySelectorAll('.cards > button')]].map(r => r.filter(vis)).filter(r => r.length);
    },
    set(el) { Ctl.clear(); Ctl.cur = el; el.classList.add('kcur'); el.scrollIntoView({ block: 'nearest' }); },
    clear() { if (Ctl.cur) Ctl.cur.classList.remove('kcur'); Ctl.cur = null; },
    enter(ta) { const r = Ctl.rows(ta); if (!r.length) return false; Ctl.ta = ta; ta.blur(); Ctl.set(r[0][0]); S.vim = 'NORMAL'; A.renderStatus(); return true; },
    text(insert) {   // back up into the text
      const ta = Ctl.ta; Ctl.clear(); if (!ta || !ta.isConnected) return;
      ta.focus(); if (insert) Vim.insert(ta, ta.value.length); else { S.cn = true; Vim.block(ta, S.cpos); A.renderStatus(); }
    },
    key(k) {
      const rows = Ctl.rows(Ctl.cur), r = rows.findIndex(x => x.includes(Ctl.cur)), i = rows[r].indexOf(Ctl.cur);
      const near = row => { const x = Ctl.cur.getBoundingClientRect().left; return row.reduce((a, b) => (Math.abs(b.getBoundingClientRect().left - x) < Math.abs(a.getBoundingClientRect().left - x) ? b : a)); };
      if (k === 'h' || k === 'ArrowLeft') { if (i > 0) Ctl.set(rows[r][i - 1]); }
      else if (k === 'l' || k === 'ArrowRight') { if (i < rows[r].length - 1) Ctl.set(rows[r][i + 1]); }
      else if (k === 'j' || k === 'ArrowDown') { if (rows[r + 1]) Ctl.set(near(rows[r + 1])); }
      else if (k === 'k' || k === 'ArrowUp') { if (r > 0) Ctl.set(near(rows[r - 1])); else Ctl.text(false); }
      else if (k === 'Enter' || k === ' ') { const b = Ctl.cur; Ctl.clear(); b.click(); }
      else if (k === 'i' || k === 'a') Ctl.text(true);
      else if (k === 'Escape') { Ctl.clear(); S.cn = false; A.renderStatus(); }
    },
  };
  document.addEventListener('mousedown', () => Ctl.clear(), true);

  const normal = () => { S.vim = 'NORMAL'; S.cn = false; if (document.activeElement) document.activeElement.blur(); A.renderStatus(); };
  const insert = () => { S.vim = 'INSERT'; S.cn = false; A.refocus(); A.renderStatus(); };

  // H / L: previous / next tab in the focused pane (buffers, in Vim terms). Works in app NORMAL,
  // in a composer's NORMAL mode and while reading; rebinding the action in the vimrc turns this off.
  // Also | (split side by side) and \ (split stacked).
  const tabKey = k => { const cmd = { H: 'tabprev', L: 'tabnext', '|': 'vsplit', '\\': 'split' }[k]; if (!cmd || A.bound(cmd)) return false; Reader.off(); A.runCmd(cmd); return true; };

  // A thread that is waiting on you (a request to run something, a plan to approve) takes y / n from NORMAL
  // anywhere in its tab: the composer, the text above it, or the app. In VISUAL, y is still yank.
  const answer = (k, t) => {
    if (!t || t.kind !== 'thread' || (k !== 'y' && k !== 'n')) return false;
    const ev = A.sess(t.sid).events;
    if (ev.some(x => x.t === 'approval')) { A.resolve(t, k === 'y'); return true; }
    if (k === 'y' && ev.some(x => x.t === 'plan')) { A.act.planOk(null, t); return true; }
    return false;
  };

  function leader(k) {
    const f = A.focused(), t = A.cur(f);
    if (S.lmap[k]) return A.runCmd(S.lmap[k]);
    const moved = { w: 'workspace', v: 'vsplit', s: 'split', '%': 'vshell', '"': 'shell', z: 'zoom', c: 'tabnew', q: 'q', t: 'view' }[k];
    if (moved && A.bound(moved)) return;
    const run = {
      v: () => A.split(f, 'row'), s: () => A.split(f, 'col'),
      '%': () => A.split(f, 'row', A.shellTab(f)), '"': () => A.split(f, 'col', A.shellTab(f)),
      c: () => A.act.tabNew(null, null, null, f), q: () => (S.pf ? A.act.peekClose() : A.closeTab(f, t)), t: () => A.setView(t),
      n: () => A.tabStep(1), p: () => A.tabStep(-1), d: () => { if (S.pf) A.act.peekDock(); }, o: A.act.peekFocus,
      '[': () => Reader.enter(A.curTab()),                 // reader mode on any tab; in a terminal, its scrollback (tmux's copy-mode key)
      z: () => A.act.zoom(null, null, null, f), x: A.swapNext, r: A.rotate, b: A.act.toggleSide,
      '<': () => A.resize('row', -0.06), '>': () => A.resize('row', 0.06), '+': () => A.resize('col', 0.06), '-': () => A.resize('col', -0.06),
      w: () => A.WS.menu(),
      Escape: () => (A.isTerm(A.curTab()) ? Reader.enter(A.curTab()) : normal()), ' ': normal,
    }[k];
    if (run) return run();
    if ('hjkl'.includes(k)) return A.focusDir(k);
    if ('HJKL'.includes(k)) return A.moveDir(k.toLowerCase());
  }

  document.addEventListener('keyup', e => { if (e.key === 'Control' && Menu.cur && Menu.cur.o.tag === 'wsw') Menu.accept(); }, true);

  document.addEventListener('keydown', e => {
    if (e.target.matches?.('.sidebar-name-input')) return;
    const k = e.key, lk = k.toLowerCase(), ctrl = e.ctrlKey || e.metaKey;
    const mod = A.OS === 'mac' ? e.metaKey : e.ctrlKey;                        // app commands: cmd on a Mac, ctrl on Windows
    const hjkl = { KeyH: 'h', KeyJ: 'j', KeyK: 'k', KeyL: 'l' }[e.code];       // option-h types ˙ on a Mac, so read the physical key
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(k)) return;

    if (e.ctrlKey && k === 'Tab') { e.preventDefault(); A.WS.cycle(e.shiftKey ? -1 : 1); return; }   // workspaces, most recent first; letting go of ctrl switches

    if (A.Keys.el && A.Keys.el.isConnected) { if (A.Keys.cap || (!ctrl && !e.altKey)) { e.preventDefault(); A.Keys.key(k, e); } return; }   // keyboard popup
    if (A.Auth.el && A.Auth.el.isConnected) { A.Auth.key(e); return; }
    if (A.Move.el && A.Move.el.isConnected) { if (!e.ctrlKey && !e.metaKey && !e.altKey) A.Move.key(e); return; }   // moving a thread   // SSH sign-in dialog
    if (A.Sett.el && A.Sett.el.isConnected) { if (!ctrl && !e.altKey) { e.preventDefault(); A.Sett.key(k, e); } return; }   // settings dialog
    if (document.querySelector('.sheet, .lightbox')) {
      if (k === 'Escape' || k === '?' || k === 'q') { e.preventDefault(); A.closeSheet(); }
      return;
    }

    // Menus are modal like everything else. One with a search field has INSERT (typing filters) and
    // NORMAL (j k move, h l adjust, i or / to search); one without is always NORMAL.
    // esc only acts from NORMAL: the first esc leaves INSERT, the next one closes.
    // A slash or @ menu is part of typing in a composer, so esc there puts the composer in NORMAL.
    // With Vim keys off there are no modes: type to filter, esc closes.
    if (Menu.cur) {
      const c = Menu.cur, aid = c.o.tag === 'slash' || c.o.tag === 'at' || c.o.tag === 'tui', nav = S.vimOn && !aid && !c.ins;
      const cj = e.ctrlKey && !e.metaKey;
      const down = k === 'ArrowDown' || (cj && (lk === 'j' || lk === 'n')) || (nav && k === 'j'), up = k === 'ArrowUp' || (cj && (lk === 'k' || lk === 'p')) || (nav && k === 'k');
      const left = k === 'ArrowLeft' || (cj && lk === 'h') || (nav && k === 'h'), right = k === 'ArrowRight' || (cj && lk === 'l') || (nav && k === 'l');
      if (A.Fly.el) {                                      // commits flyout beside the scope menu
        e.preventDefault();
        if (down || up) A.Fly.move(down ? 1 : -1); else if (k === 'Enter' || k === ' ') A.Fly.toggle(); else if (k === 'Escape' || left) A.Fly.close();
        return;
      }
      if (down || up) { e.preventDefault(); Menu.move(down ? 1 : -1); return; }
      if (right && c.items[c.i] && c.items[c.i].fly) { e.preventDefault(); Menu.accept(); return; }
      if (c.o.tab && (k === 'Tab' || (right && nav))) {   // a folder list: tab completes to the folder under the cursor and lists it; it never chooses
        const it = c.items[c.i];
        if (it && it.into) { e.preventDefault(); c.o.tab(it); return; }
        if (k === 'Tab') { e.preventDefault(); Menu.move(1); return; }   // on a row with nothing to go into: on to the next
      }
      if (c.o.effort && (left || right)) { e.preventDefault(); c.o.effort(left ? -1 : 1); return; }
      if (k === 'Escape') {
        e.preventDefault();
        if (aid) { Menu.close(); const ta = document.activeElement; if (S.vimOn && ta && ta.matches('textarea[data-input]')) Vim.normal(ta); return; }
        if (S.vimOn && c.o.search && c.ins) { Menu.mode(false); return; }
        Menu.close(); if (S.vim === 'INSERT' || S.cn) A.refocus(); return;
      }
      if (k === 'Enter' || k === 'Tab') {
        if (c.items.some(i => !i.head)) { e.preventDefault(); Menu.accept(); return; }
        if (c.o.search) { e.preventDefault(); return; }
        Menu.close();      // nothing to pick: let enter fall through and send
      } else if (nav) {
        if (ctrl || e.altKey) return;
        e.preventDefault();
        if (c.o.search && (k === 'i' || k === 'a' || k === '/')) Menu.mode(true);
        else if (c.o.search && k === 'x') { const inp = c.e.querySelector('input'); inp.value = inp.value.slice(0, -1); Menu.filter(inp.value); }   // x: delete the character under the cursor
        else if (k === ' ') Menu.accept(true);            // space: pick without closing
        else if (c.o.keys) c.o.keys(k, c.items[c.i]);     // the menu's own keys for the row under the cursor
        return;
      } else return;
    }

    if (S.leader) { e.preventDefault(); S.leader = false; leader(k); A.renderStatus(); return; }
    if (e.ctrlKey && !e.metaKey && e.code === (S.leaderKey === 'ctrl-\\' ? 'Backslash' : 'Space')) { e.preventDefault(); S.leader = true; A.renderStatus(); return; }
    // pane focus works from everywhere, a terminal included
    if (e.altKey && hjkl && !e.ctrlKey && !e.metaKey) { e.preventDefault(); Reader.off(); Ctl.clear(); A.focusDir(hjkl); return; }
    if (A.OS === 'mac' && e.metaKey && !e.shiftKey && lk === 'w') { e.preventDefault(); A.closeTab(A.focused(), A.cur(A.focused())); return; }   // cmd-w keeps its Mac meaning

    // ctrl-shift-a searches the focused pane's tabs (the chevron menu in its tab bar), as in Chrome.
    if (mod && e.shiftKey && lk === 'a') {
      e.preventDefault(); Reader.off();
      const btn = document.querySelector('.pane.focus [data-act=tabSearch]') || document.querySelector('.pane [data-act=tabSearch]');
      if (btn) A.act.tabSearch(btn, null, null, A.focused());
      return;
    }
    // ctrl-k (cmd-k on a Mac) is the search palette, the same one the search button opens; ctrl-p searches files
    // in the project of the thread you are in. On Windows, in a terminal these ctrl keys belong to the program;
    // a Mac's cmd keys never reach a terminal, so there they always work.
    const inTerm = !!(document.activeElement && document.activeElement.closest && document.activeElement.closest('.term'));
    if (mod && !e.shiftKey && !e.altKey && (lk === 'k' || lk === 'p') && !(inTerm && A.OS !== 'mac')) {
      e.preventDefault(); Reader.off(); if (lk === 'k') A.palette(); else A.fileSearch(); return;
    }
    // A selection (mouse, or Vim visual mode) can be quoted into the chat or into a new side chat.
    // ctrl-o / ctrl-i: the jump list between a popup and the pane it came from (not while typing at a terminal prompt)
    if (e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && (lk === 'o' || lk === 'i') && !inTerm) {
      const ft = A.curTab();   // in an open file, its own back / forward come first
      if (ft && ft.kind === 'file' && !S.pf && A.fileStep(ft, lk === 'o' ? -1 : 1)) { e.preventDefault(); Reader.off(); return; }
      if (lk === 'o' ? !S.pf : !S.back) return;
      e.preventDefault(); Reader.off(); Ctl.clear(); if (lk === 'o') A.act.jumpBack(); else A.act.jumpFwd(); return;
    }
    if (mod && Annot.has() && (lk === 'l' || (e.shiftKey && lk === 's'))) { e.preventDefault(); Annot.add(lk === 'l' ? 'chat' : 'side'); return; }
    // A row of buttons that stands in for a field (the Claude Code mirror bar, the handoff card, a failed upload, an
    // error's fix): h / l move along it, enter presses, esc presses its way out (or leaves), k reads the thread above.
    const kbtn = document.activeElement && document.activeElement.matches('.kbrow button') ? document.activeElement : null;
    if (kbtn && !ctrl && !e.altKey) {
      const row = [...kbtn.closest('.kbrow').querySelectorAll('button')], i = row.indexOf(kbtn), t = A.tabAt(kbtn);
      if (k === 'Tab') return;
      e.preventDefault();
      if (k === 'h' || k === 'ArrowLeft') row[Math.max(0, i - 1)].focus();
      else if (k === 'l' || k === 'ArrowRight') row[Math.min(row.length - 1, i + 1)].focus();
      else if (k === "Enter" || k === " ") kbtn.click();
      else if (k === 'Escape') { const out = kbtn.closest('.kbrow').querySelector('[data-esc]'); if (out) out.click(); else { kbtn.blur(); normal(); } }
      else if ((k === 'k' || k === '[' || k === '{') && Reader.enter(t)) {}
      else if ((k === "i" || k === "a") && kbtn.closest(".mirror")) { const b = kbtn.closest('.kbrow').querySelector('[data-act=takeBack]'); if (b) b.click(); }
      else if (S.vimOn && answer(k, t)) {}
      else if (S.vimOn && k === ':') A.cmdline();
      else if (S.vimOn) tabKey(k);
      A.renderStatus(); return;
    }
    if (Ctl.cur && !Ctl.cur.isConnected) Ctl.cur = null;
    if (Ctl.cur) { if (ctrl || e.altKey) return; e.preventDefault(); Ctl.key(k); return; }   // on a composer control
    if (Reader.on) { if (ctrl || e.altKey) return; e.preventDefault(); if (Reader.mode === 'n' && answer(k, A.curTab())) return; if (!tabKey(k)) Reader.key(k); return; }

    const ae = document.activeElement;
    const inp = ae && ae.matches('[data-input]') ? ae : null;
    if (inp && inp.closest('.term')) {                   // a terminal: the program owns the line (TERMINAL)
      const t = A.tabAt(inp);
      if (k === 'Enter' && !e.shiftKey) { e.preventDefault(); A.send(t); return; }
      if (k === 'Escape') { e.preventDefault(); A.termEsc(t, inp); return; }
      return;                                            // typed into the program
    }
    if (inp && inp.dataset.input === 'tq') {             // changed-files search: enter goes to the first match, esc back to reading
      const t = A.tabAt(inp);
      if (k === 'Enter' || k === 'Escape') {
        e.preventDefault(); const first = k === 'Enter' && inp.closest('.ctree').querySelector('.tfn');
        if (first) A.act.jumpFile(first, t); inp.blur(); S.vim = 'NORMAL';
        if (Reader.enter(t) && first) Reader.toRow(inp.closest('[data-tab]').querySelector(`.cfile[data-p="${CSS.escape(first.dataset.p)}"] > summary`));
        A.renderStatus();
      }
      return;
    }
    if (inp) {
      const t = A.tabAt(inp), area = inp.tagName === 'TEXTAREA', rc = inp.dataset.input === 'vimrc' || inp.dataset.input === 'file';   // a text file: enter is a new line
      if (k === 'Enter' && !e.shiftKey && !rc) { e.preventDefault(); A.send(t); return; }
      if (!S.cn && !e.shiftKey && (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'Delete') && inp.selectionStart === inp.selectionEnd) {
        const p = inp.selectionStart, tk = Vim.tokAt(inp.value, k === 'ArrowLeft' ? p - 1 : p);
        if (tk) { e.preventDefault(); if (k === 'Delete') Vim.edit(inp, tk[0], tk[1]); else { const to = k === 'ArrowLeft' ? tk[0] : tk[1]; inp.setSelectionRange(to, to); } return; }
      }
      if (!S.cn && k === 'Backspace' && inp.selectionStart === inp.selectionEnd) {   // a quoted selection deletes as one item
        const tk = Vim.tokAt(inp.value, inp.selectionStart - 1);
        if (tk) { e.preventDefault(); Vim.edit(inp, tk[0], tk[1]); return; }
      }
      if (!S.cn && S.vimOn && k.length === 1 && !ctrl) {    // vimrc: inoremap jk <Esc>
        const now = Date.now(), prev = inp.value[inp.selectionStart - 1];
        if (S.imap.some(m => m[1] === k && m[0] === prev) && now - (inp._t || 0) < 600) { e.preventDefault(); Vim.edit(inp, inp.selectionStart - 1, inp.selectionStart); Vim.normal(inp); return; }
        inp._t = now;
      }
      if (S.cn) {                                          // composer NORMAL
        if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && k.toLowerCase() === 'r' && !S.cv) { e.preventDefault(); Vim.undo(inp, true); return; }   // redo (and never a page reload)
        if (ctrl || e.altKey) return;
        e.preventDefault();
        if (!S.cv && !inp.closest('.m-edit') && answer(k, t)) return;
        // [[ and { reach up out of the composer: your last message, and the last block. { first stops at a blank
        // line in the composer if there is one above the cursor, as it would in any text.
        if (!S.cv && inp.closest('.comp') && !inp.closest('.m-edit')) {
          if (k === '[') { if (!brk) { brk = true; return; } brk = false; S.cpos = inp.selectionStart; if (Reader.enter(t)) { Reader.key('['); Reader.key('['); } return; }
          brk = false;
          if (k === '{' && inp.value.lastIndexOf(String.fromCharCode(10).repeat(2), inp.selectionStart - 1) < 0) { S.cpos = inp.selectionStart; if (Reader.enter(t)) Reader.key('block-start'); return; }
        }
        // j on the last line of the text goes down onto the composer's controls
        if (!S.cv && k === 'j' && inp.value.indexOf(String.fromCharCode(10), inp.selectionStart) < 0 && (S.cpos = inp.selectionStart, Ctl.enter(inp))) return;
        if (!(S.cv ? false : tabKey(k))) Vim.key(inp, k); return;
      }
      if (k === 'Escape') { e.preventDefault(); if (S.vimOn) Vim.normal(inp); else if (inp.closest('.m-edit')) A.act.editCancel(null, t); else normal(); }
      return;
    }

    // App NORMAL
    if (e.ctrlKey && !e.metaKey && lk === 'w') { e.preventDefault(); S.leader = true; A.renderStatus(); return; }
    if (ctrl || e.altKey) return;
    if (S.sf && (['Enter', 'Escape', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(k) || 'jkhlgGoOxpcm'.includes(k) && k.length === 1)) { e.preventDefault(); A.sideKey(k, e.shiftKey); return; }   // the sidebar has focus
    const f = A.focused(), t = A.cur(f);
    if (k === 'Escape' && S.pf) { e.preventDefault(); A.act.peekClose(); return; }   // nothing left to step out of but the popup
    const arrows = { ArrowDown: () => A.cursor(1), ArrowUp: () => A.cursor(-1), Enter: () => { if (S.cursor) A.openThread(S.cursor, { split: e.shiftKey }); } }[k];
    if (arrows) { e.preventDefault(); arrows(); return; }
    if (!S.vimOn) return;                                  // plain-letter shortcuts are the Vim layer
    if (g) { g = false; e.preventDefault(); if (k === 't' && !A.bound('tabnext')) A.tabStep(1); else if (k === 'T' && !A.bound('tabprev')) A.tabStep(-1); else if (k === 'v') A.setView(t); return; }
    const evs = t.kind === 'thread' ? A.sess(t.sid).events : [], pending = evs.some(x => x.t === 'approval'), plan = evs.some(x => x.t === 'plan');
    if (S.nmap[k]) { e.preventDefault(); A.runCmd(S.nmap[k]); return; }   // vimrc: nnoremap X :command<CR>
    if (k === 'y' && plan) { e.preventDefault(); A.act.planOk(null, t); return; }
    if (tabKey(k)) { e.preventDefault(); return; }
    switch (k) {
      case 'j': A.cursor(1); break;
      case 'k': A.cursor(-1); break;
      case 'o': if (S.cursor) A.openThread(S.cursor); break;
      case 'O': if (S.cursor) A.openThread(S.cursor, { split: true }); break;
      case 'i': case 'a': insert(); break;
      case ':': A.cmdline(); break;
      case '/': A.palette(); break;
      case '?': A.keysSheet(); break;
      case 'g': g = true; break;
      case 'y': if (pending) A.resolve(t, true); break;
      case 'n': if (pending) A.resolve(t, false); break;
      default: return;
    }
    e.preventDefault();
  }, true);
})();
