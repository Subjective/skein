// Vim for a text field (VIM-MODEL: Field). Pure: a state and a key in, a new state and effects out.
// Composers, the edit box, menu search fields and the file editor all run this one engine.
//
// NORMAL: h l j k w b e W B E 0 ^ $ gg G (5G, 5gg: line 5), counts, x X D C S s r~ J, d c y with motions
//         (and iw aw, dd cc yy), p P (3p), i a I A o O, v V, u ctrl-r (rule 17), enter (effect 'enter'),
//         esc (effect 'leave'). The register is the state's `reg`; VimField shares one across fields (input/register).
// VISUAL / V-LINE: the same motions extend; d x c y s, o swaps ends, esc back to NORMAL.
// INSERT: esc to NORMAL; everything else is typed by the browser (the field calls `typed`).
export type FieldMode = 'NORMAL' | 'INSERT' | 'VISUAL' | 'V-LINE';

export interface TextState {
  text: string;
  pos: number;          // caret (INSERT) or block cursor (NORMAL), 0..len
  mode: FieldMode;
  anchor: number;       // VISUAL start
  pending: string;      // operator / count / g / r waiting for more
  reg: { text: string; line: boolean };
  undo: { text: string; pos: number }[];
  redo: { text: string; pos: number }[];
  /** Snapshot taken when INSERT began, pushed to undo once it ends with a change (one INSERT stretch is one step). */
  insertFrom?: { text: string; pos: number };
  col?: number;         // wanted column for j / k
}

export type Effect = 'enter' | 'leave' | 'leave-up' | 'leave-down' | 'changed' | 'insert' | 'yank' | 'oldest' | 'newest';

export const init = (text = '', mode: FieldMode = 'INSERT'): TextState => ({ text, pos: text.length, mode, anchor: 0, pending: '', reg: { text: '', line: false }, undo: [], redo: [], insertFrom: mode === 'INSERT' ? { text, pos: text.length } : undefined });

// ---------- quotes ----------
// A quoted selection sits in a composer's text as one item between invisible U+2063 marks. The cursor never
// goes inside one: motions step over it whole, the NORMAL block covers all of it, operators take it whole.
const TOKRE = /\u2063[^\u2063]*\u2063/g;
/** The quote [start, end) that position p is inside, if any. */
export function tokAt(t: string, p: number): [number, number] | null {
  if (t.indexOf('\u2063') < 0) return null;
  TOKRE.lastIndex = 0; let m: RegExpExecArray | null;
  while ((m = TOKRE.exec(t))) { if (p >= m.index && p < m.index + m[0].length) return [m.index, m.index + m[0].length]; if (m.index > p) break; }
  return null;
}
/** Widen [a, b) so it holds every quote it touches whole. */
export function widen(t: string, a: number, b: number): [number, number] {
  const x = tokAt(t, a), y = b > a ? tokAt(t, b - 1) : null;
  return [x ? x[0] : a, y ? y[1] : b];
}
const snapTok = (t: string, p: number) => { const k = tokAt(t, p); return k ? k[0] : p; };

// ---------- geometry ----------
const lineStart = (t: string, p: number) => t.lastIndexOf('\n', p - 1) + 1;
const lineEnd = (t: string, p: number) => { const i = t.indexOf('\n', p); return i < 0 ? t.length : i; };
/** Last character of the line (NORMAL cursor never sits on the newline unless the line is empty). */
const lastCol = (t: string, p: number) => Math.max(lineStart(t, p), lineEnd(t, p) - 1);
const clampN = (t: string, p: number) => Math.min(Math.max(0, p), Math.max(lineStart(t, p), lastCol(t, p)));
const cls = (c: string | undefined, big: boolean) => (c === undefined ? -1 : /\s/.test(c) ? 0 : big || /\w/.test(c) ? 1 : 2);

function wordFwd(t: string, p: number, big: boolean) {
  const n = t.length; if (p >= n) return n;
  const c0 = cls(t[p], big);
  let i = p;
  if (c0 > 0) while (i < n && cls(t[i], big) === c0) i++;
  while (i < n && cls(t[i], big) === 0 && t[i] !== '\n') i++;
  if (t[i] === '\n') { i++; while (i < n && /[ \t]/.test(t[i])) i++; }
  return i;
}
function wordBack(t: string, p: number, big: boolean) {
  let i = p - 1;
  while (i > 0 && cls(t[i], big) === 0) i--;
  const c = cls(t[i], big);
  while (i > 0 && cls(t[i - 1], big) === c && c !== 0) i--;
  return Math.max(0, i);
}
function wordEnd(t: string, p: number, big: boolean) {
  const n = t.length; let i = p + 1;
  while (i < n && cls(t[i], big) === 0) i++;
  const c = cls(t[i], big);
  while (i + 1 < n && cls(t[i + 1], big) === c) i++;
  return Math.min(i, Math.max(0, n - 1));
}
function vert(t: string, p: number, d: number, col?: number): number | null {
  const s = lineStart(t, p), want = col ?? p - s;
  if (d < 0) { if (s === 0) return null; const ps = lineStart(t, s - 1); return Math.min(ps + want, Math.max(ps, s - 2 >= ps ? s - 2 : ps)); }
  const e = lineEnd(t, p); if (e >= t.length) return null;
  const ns = e + 1, ne = lineEnd(t, ns);
  return Math.min(ns + want, Math.max(ns, ne - 1));
}
function innerWord(t: string, p: number, around: boolean): [number, number] {
  const c = cls(t[p], false); let a = p, b = p;
  while (a > 0 && cls(t[a - 1], false) === c && t[a - 1] !== '\n') a--;
  while (b < t.length && cls(t[b], false) === c && t[b] !== '\n') b++;
  if (around) while (b < t.length && /[ \t]/.test(t[b])) b++;
  return [a, b];
}

// ---------- editing helpers ----------
const snap = (s: TextState) => ({ text: s.text, pos: s.pos });
function edit(s: TextState, text: string, pos: number): TextState {
  return { ...s, undo: [...s.undo, snap(s)].slice(-200), redo: [], text, pos: snapTok(text, pos) };
}
const toInsert = (s: TextState, pos: number): TextState => ({ ...s, mode: 'INSERT', pos, pending: '', insertFrom: snap({ ...s, pos }) });

export interface Result { s: TextState; handled: boolean; fx: Effect[] }
const R = (s: TextState, ...fx: Effect[]): Result => ({ s, handled: true, fx });
const PASS = (s: TextState): Result => ({ s, handled: false, fx: [] });

/** Motion: where the cursor lands, and whether an operator over it is inclusive / linewise. */
function motion(s: TextState, k: string, count: number, explicit = false): { to: number; incl?: boolean; line?: boolean; col?: number } | null | 'up' | 'down' {
  const t = s.text, p = s.pos;
  let to = p;
  switch (k) {
    case 'h': case 'left': return { to: Math.max(lineStart(t, p), p - count) };
    case 'l': case 'right': return { to: Math.min(s.mode === 'NORMAL' && !s.pending ? lastCol(t, p) : lineEnd(t, p), p + count) };
    case '0': case 'home': return { to: lineStart(t, p) };
    case '^': { let i = lineStart(t, p); while (/[ \t]/.test(t[i] || '')) i++; return { to: i }; }
    case '$': case 'end': return { to: s.mode === 'NORMAL' && !s.pending ? lastCol(t, p) : lineEnd(t, p) - (s.pending ? 1 : 0), incl: true };
    case 'w': case 'W': for (let i = 0; i < count; i++) to = wordFwd(t, to, k === 'W'); if (s.pending === 'c' || s.pending.endsWith('c')) { to = wordEnd(t, p - 1 < 0 ? 0 : p, k === 'W') + 1; if (cls(t[p], k === 'W') === 0) to = wordFwd(t, p, k === 'W'); } return { to };
    case 'b': case 'B': for (let i = 0; i < count; i++) to = wordBack(t, to, k === 'B'); return { to };
    case 'e': case 'E': for (let i = 0; i < count; i++) to = wordEnd(t, to, k === 'E'); return { to, incl: true };
    case 'j': case 'down': case 'k': case 'up': {
      let q: number | null = p; const col = s.col ?? p - lineStart(t, p);
      for (let i = 0; i < count && q != null; i++) q = vert(t, q, k === 'j' || k === 'down' ? 1 : -1, col);
      if (q == null) return k === 'j' || k === 'down' ? 'down' : 'up';
      return { to: q, line: true, col };
    }
    case 'G': case 'g g': {
      if (!explicit) return { to: k === 'G' ? lineStart(t, t.length) : 0, line: true };
      let at = 0;   // 5G / 5gg: the start of line 5 (or the last line)
      for (let n = 1; n < count; n++) { const e = t.indexOf('\n', at); if (e < 0) break; at = e + 1; }
      return { to: at, line: true };
    }
  }
  return null;
}

export function step(s0: TextState, k: string): Result {
  let s = s0;
  if (s.mode === 'INSERT') {
    if (k === 'esc' || k === 'ctrl-[') {
      const changed = s.insertFrom && s.insertFrom.text !== s.text;
      const undo = changed ? [...s.undo, s.insertFrom!].slice(-200) : s.undo;
      return R({ ...s, mode: 'NORMAL', undo, redo: changed ? [] : s.redo, insertFrom: undefined, pos: snapTok(s.text, clampN(s.text, s.pos > lineStart(s.text, s.pos) ? s.pos - 1 : s.pos)), col: undefined });
    }
    return PASS(s);
  }

  // ---- pending: counts, g, r, operators ----
  // a count may come before the operator, after it, or both (3dw, d3w, 2d3w: 6 words), as in Vim
  const pend = s.pending.replace(/\d+/g, '');
  if (pend === 'r') { s = { ...s, pending: '' }; if (k.length !== 1 || tokAt(s.text, s.pos)) return R(s); return R(edit(s, s.text.slice(0, s.pos) + k + s.text.slice(s.pos + 1), s.pos), 'changed'); }
  if (/^[1-9]$/.test(k) || (k === '0' && /\d$/.test(s.pending))) return R({ ...s, pending: s.pending + k });
  const groups = s.pending.match(/\d+/g) || [];
  const explicit = groups.length > 0;
  const count = Math.max(1, Math.min(100000, groups.reduce((a, g) => a * parseInt(g, 10), 1)));
  const key = pend === 'g' || /^[dcy]g$/.test(pend) ? (k === 'g' ? 'g g' : k) : k;

  const visual = s.mode === 'VISUAL' || s.mode === 'V-LINE';
  const op = (pend.match(/^([dcy])/) || [])[1];

  if (k === 'esc') {
    if (s.pending) return R({ ...s, pending: '' });
    if (visual) return R({ ...s, mode: 'NORMAL', pending: '' });
    return R(s, 'leave');
  }

  // text objects after an operator or in visual: iw aw
  if ((op || visual) && (pend.endsWith('i') || pend.endsWith('a')) && (k === 'w' || k === 'W')) {
    const [a, b] = innerWord(s.text, s.pos, pend.endsWith('a'));
    if (visual) return R({ ...s, anchor: a, pos: b - 1, pending: '' });
    return applyOp(s, op!, a, b, false);
  }
  if ((op || visual) && (k === 'i' || k === 'a') && !pend.endsWith('i') && !pend.endsWith('a')) {
    if (visual || op) return R({ ...s, pending: s.pending + k });
  }

  if (k === 'g' && !pend.endsWith('g')) return R({ ...s, pending: s.pending + 'g' });

  // doubled operator: dd cc yy
  if (op && pend === op && k === op) {
    const t = s.text; let a = lineStart(t, s.pos), b = s.pos;
    for (let i = 0; i < count; i++) b = lineEnd(t, b) + (i < count - 1 ? 1 : 0);
    return applyOp(s, op, a, Math.min(t.length, b), true);
  }

  // on a quote, forward motions start from its last mark and backward ones from its first
  const tk0 = tokAt(s.text, s.pos);
  const from = tk0 ? (['l', 'right', 'w', 'W', 'e', 'E', '$', 'end'].includes(key) ? tk0[1] - 1 : tk0[0]) : s.pos;
  const mv = motion({ ...s, pending: pend, pos: from }, key, count, explicit);
  if (mv === 'up' || mv === 'down') {
    if (op) return R({ ...s, pending: '' });
    return R({ ...s, pending: '' }, mv === 'up' ? 'leave-up' : 'leave-down');
  }
  if (mv) {
    if (op) {
      const lo = Math.min(s.pos, mv.to), hi = Math.max(s.pos, mv.to);
      if (mv.line) return applyOp(s, op, lineStart(s.text, lo), lineEnd(s.text, hi), true);
      return applyOp(s, op, lo, hi + (mv.incl ? 1 : 0), false);
    }
    let to = visual ? Math.min(mv.to, s.text.length) : clampN(s.text, mv.to);
    // a motion that lands inside a quote rests on its start; one that cannot leave it (l at its end) stays
    const tk = tokAt(s.text, to); if (tk) to = tk[0];
    return R({ ...s, pos: to, pending: '', col: mv.col });
  }

  if (visual) return visualKey(s, k);
  if (op) return R({ ...s, pending: '' });

  const t = s.text, p = s.pos;
  switch (k) {
    case 'i': return R(toInsert(s, p), 'insert');
    case 'a': return R(toInsert(s, Math.min(t.length, (tokAt(t, p)?.[1] ?? p + (t[p] === '\n' || !t.length ? 0 : 1)))), 'insert');
    case 'I': { let i = lineStart(t, p); while (/[ \t]/.test(t[i] || '')) i++; return R(toInsert(s, i), 'insert'); }
    case 'A': return R(toInsert(s, lineEnd(t, p)), 'insert');
    case 'o': { const e = lineEnd(t, p); const x = toInsert(s, e + 1); return R({ ...x, text: t.slice(0, e) + '\n' + t.slice(e) }, 'insert', 'changed'); }
    case 'O': { const b = lineStart(t, p); const x = toInsert(s, b); return R({ ...x, text: t.slice(0, b) + '\n' + t.slice(b) }, 'insert', 'changed'); }
    case 'x': case 'delete': if (!t.length || t[p] === '\n') return R(s); return applyOp(s, 'd', p, Math.min(lineEnd(t, p), p + count), false);
    case 'X': if (p === lineStart(t, p)) return R(s); return applyOp(s, 'd', Math.max(lineStart(t, p), p - count), p, false);
    case 'D': return applyOp(s, 'd', p, lineEnd(t, p), false);
    case 'C': return applyOp(s, 'c', p, lineEnd(t, p), false);
    case 's': return applyOp(s, 'c', p, Math.min(lineEnd(t, p), p + count), false);
    case 'S': return applyOp(s, 'c', lineStart(t, p), lineEnd(t, p), false);
    case 'd': case 'c': case 'y': return R({ ...s, pending: s.pending + k });
    case 'r': return R({ ...s, pending: 'r' });
    case '~': { if (!t.length || tokAt(t, p)) return R(s); const c = t[p]; const sw = c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase(); return R({ ...edit(s, t.slice(0, p) + sw + t.slice(p + 1), clampN(t, p + 1)) }, 'changed'); }
    case 'J': { const e = lineEnd(t, p); if (e >= t.length) return R(s); let j = e + 1; while (/[ \t]/.test(t[j] || '')) j++; return R(edit(s, t.slice(0, e) + ' ' + t.slice(j), e), 'changed'); }
    case 'p': case 'P': return s.reg.text ? R(put({ ...s, pending: '' }, k === 'P', count), 'changed') : R({ ...s, pending: '' });
    case 'v': return R({ ...s, mode: 'VISUAL', anchor: p });
    case 'V': return R({ ...s, mode: 'V-LINE', anchor: p });
    case 'u': { const prev = s.undo[s.undo.length - 1]; if (!prev) return R(s, 'oldest'); return R({ ...s, text: prev.text, pos: clampN(prev.text, prev.pos), undo: s.undo.slice(0, -1), redo: [...s.redo, snap(s)] }, 'changed'); }
    case 'ctrl-r': { const nx = s.redo[s.redo.length - 1]; if (!nx) return R(s, 'newest'); return R({ ...s, text: nx.text, pos: clampN(nx.text, nx.pos), redo: s.redo.slice(0, -1), undo: [...s.undo, snap(s)] }, 'changed'); }
    case 'enter': return R(s, 'enter');
  }
  return PASS(s);
}

function visualKey(s: TextState, k: string): Result {
  const [a, b] = vrange(s);
  switch (k) {
    case 'o': return R({ ...s, pos: s.anchor, anchor: s.pos });
    case 'v': return R(s.mode === 'VISUAL' ? { ...s, mode: 'NORMAL' } : { ...s, mode: 'VISUAL' });
    case 'V': return R(s.mode === 'V-LINE' ? { ...s, mode: 'NORMAL' } : { ...s, mode: 'V-LINE' });
    case 'd': case 'x': case 'delete': return applyOp({ ...s, mode: 'NORMAL' }, 'd', a, b, s.mode === 'V-LINE');
    case 'c': case 's': return applyOp({ ...s, mode: 'NORMAL' }, 'c', a, b, s.mode === 'V-LINE');
    case 'y': return applyOp({ ...s, mode: 'NORMAL' }, 'y', a, b, s.mode === 'V-LINE');
  }
  return R(s);
}

/** The selected range [from, to) of a visual state. */
export function vrange(s: TextState): [number, number] {
  const lo = Math.min(s.anchor, s.pos), hi = Math.max(s.anchor, s.pos);
  if (s.mode === 'V-LINE') return [lineStart(s.text, lo), lineEnd(s.text, hi)];
  return widen(s.text, lo, Math.min(s.text.length, hi + 1));
}

function applyOp(s: TextState, op: string, a: number, b: number, line: boolean): Result {
  const t = s.text;
  if (!line) [a, b] = widen(t, a, b);   // a quote goes whole or not at all
  const reg = { text: t.slice(a, b), line };
  if (op === 'y') return R({ ...s, reg, pending: '', pos: a, mode: 'NORMAL' }, 'yank');
  if (line && op === 'd') {
    // take the line's newline too: the one after it, or before it on the last line
    let x = a, y = b;
    if (y < t.length) y++; else if (x > 0) x--;
    const text = t.slice(0, x) + t.slice(y);
    const pos = Math.min(x === a ? a : lineStart(text, x), text.length);
    return R({ ...edit(s, text, clampN(text, pos)), reg, pending: '', mode: 'NORMAL' }, 'changed');
  }
  const text = t.slice(0, a) + t.slice(b);
  if (op === 'c') { const e = edit(s, text, a); return R({ ...e, reg, mode: 'INSERT', pending: '', insertFrom: undefined }, 'changed', 'insert'); }
  return R({ ...edit(s, text, clampN(text, a)), reg, pending: '', mode: 'NORMAL' }, 'changed');
}

function put(s: TextState, before: boolean, count = 1): TextState {
  const { text: one, line } = s.reg; if (!one) return s;
  const r = Array(Math.min(count, 500)).fill(one).join(line ? '\n' : '');
  const t = s.text;
  if (line) {
    const at = before ? lineStart(t, s.pos) : lineEnd(t, s.pos);
    const ins = before ? r + '\n' : '\n' + r;
    return edit(s, t.slice(0, at) + ins + t.slice(at), before ? at : at + 1);
  }
  const at = before || !t.length ? s.pos : s.pos + 1;
  return edit(s, t.slice(0, at) + r + t.slice(at), at + r.length - 1);
}

/** The browser typed into the field (INSERT): take its value and caret. */
export const typed = (s: TextState, text: string, pos: number): TextState => ({ ...s, text, pos });
/** Replace the whole text from outside (a pick from the / menu, a cleared composer after send). */
export const setText = (s: TextState, text: string, pos = text.length): TextState => ({ ...s, text, pos, pending: '' });
