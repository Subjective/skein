// A terminal: xterm.js (WebGL, Sixel / iTerm2 images) over a pty from the main process.
// Instances are cached by tab id, so a tab keeps its terminal while it moves between panes or pops out.
// VIM-MODEL rule 11: in TERMINAL every key goes to the program except the leader, alt-hjkl and Skein's
// modifier shortcuts; the dispatcher enforces that before a key reaches xterm.
import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { ImageAddon } from '@xterm/addon-image';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import type { PtySpec } from '@shared/api';
import { api } from '../../api';
import type { Surface } from '../../input/dispatcher';
import { keyOf } from '../../input/keys';
import { registerTab } from '../../input/surfaces';
import type { Tab } from '../../state/layout';
import { machine, S, update } from '../../state/store';
import { LinkNote } from '../../ui/LinkNote';
import { discardUpload, pasteClipboard, pasteImage, uploads } from './paste';
import { OS } from '../../input/platform';
import { Button, Icon } from '../../ui/primitives';
import { isReading, readerKey } from './scrollback';

export interface TermEntry {
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
  ptyId: string | null;
  exited: number | null | undefined;
  spec: PtySpec;
  onExit?: (code: number | null) => void;
  /** The program set the terminal title (OSC 0/2) or asked for attention (bell, OSC 9 / 777). */
  onTitle?: (title: string) => void;
  onAttention?: (text: string) => void;
}
const cache = new Map<string, TermEntry>();
export const termOf = (tabId: string) => cache.get(tabId);

const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
function theme() {
  const dark = document.documentElement.dataset.theme !== 'light';
  return {
    background: css('--bg') || (dark ? '#212121' : '#fdfdfd'), foreground: css('--fg') || (dark ? '#ececec' : '#1a1a1a'),
    cursor: css('--fg'), cursorAccent: css('--bg'), selectionBackground: 'rgba(74, 163, 255, .3)',
    ...(dark ? {} : { black: '#1a1a1a', brightBlack: '#707070', white: '#d0d0d0', brightWhite: '#ffffff', yellow: '#b8770f', brightYellow: '#c98a1e' }),
  };
}

// one listener for every terminal's output
let wired = false;
const byPty = new Map<string, TermEntry>();
function wire() {
  if (wired) return; wired = true;
  api.on(e => {
    if (e.type === 'pty.data') byPty.get(e.id)?.term.write(e.data);
    if (e.type === 'pty.exit') { const t = byPty.get(e.id); if (t) { t.exited = e.code; t.ptyId = null; byPty.delete(e.id); t.onExit?.(e.code); update(); } }
  });
}

export function ensureTerm(tabId: string, spec: PtySpec, onExit?: (code: number | null) => void): TermEntry {
  let t = cache.get(tabId);
  if (t) { t.onExit = onExit; return t; }
  wire();
  const el = document.createElement('div');
  el.className = 'xterm-host';
  const term = new Terminal({
    fontFamily: css('--mono') || 'monospace', fontSize: 13, lineHeight: 1.25, cursorBlink: true, allowProposedApi: true,
    scrollback: 10000, theme: theme(), macOptionIsMeta: false, drawBoldTextInBrightColors: false,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon((_e, url) => void api.app.openExternal(url)));
  term.loadAddon(new ImageAddon({ sixelSupport: true, iipSupport: true }));
  t = { term, fit, el, ptyId: null, exited: undefined, spec, onExit };
  cache.set(tabId, t);
  const entry = t;
  // Keys: the window-level dispatcher runs first in the capture phase (rule 11); xterm only sees what it let through.
  term.attachCustomKeyEventHandler(e => {
    if (e.type !== 'keydown') return true;
    const k = keyOf(e);
    // Windows and Linux copy and paste as Windows Terminal does: ctrl-shift-c / ctrl-shift-v, and on Windows
    // ctrl-c copies when there is a selection and ctrl-v pastes. A Mac's cmd-v arrives as a paste event instead.
    if ((k === 'ctrl-shift-c' || (OS === 'win' && k === 'ctrl-c')) && term.hasSelection()) { void navigator.clipboard.writeText(term.getSelection()); term.clearSelection(); return false; }
    if (k === 'ctrl-shift-v' || (OS === 'win' && k === 'ctrl-v')) { e.preventDefault(); void pasteClipboard(tabId, entry); return false; }
    return true;
  });
  term.onData(d => { if (entry.ptyId) api.pty.write(entry.ptyId, d); });
  term.onTitleChange(title => entry.onTitle?.(title));
  term.onBell(() => entry.onAttention?.(''));
  // OSC 9 (iTerm2 / Windows Terminal) and OSC 777;notify (rxvt): desktop notifications from the TUI
  term.parser.registerOscHandler(9, data => { if (!/^\d+;/.test(data)) entry.onAttention?.(data); return true; });
  term.parser.registerOscHandler(777, data => { const m = /^notify;([^;]*);?(.*)$/.exec(data); if (m) entry.onAttention?.(m[2] || m[1]); return true; });
  term.onResize(({ cols, rows }) => { if (entry.ptyId) api.pty.resize(entry.ptyId, cols, rows); });
  el.addEventListener('paste', ev => { if (pasteImage(tabId, entry, ev)) { ev.preventDefault(); ev.stopPropagation(); } }, true);
  return t;
}

export async function startPty(t: TermEntry) {
  if (t.ptyId) return;
  t.exited = undefined;
  try {
    t.ptyId = await api.pty.spawn({ ...t.spec, cols: t.term.cols, rows: t.term.rows });
    byPty.set(t.ptyId, t);
  } catch (e) {
    t.exited = -1;
    t.term.write(`\r\n\x1b[31m${String((e as Error).message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}\x1b[0m\r\n`);
    update();
  }
}

export function disposeTerm(tabId: string) {
  const t = cache.get(tabId); if (!t) return;
  if (t.ptyId) { api.pty.kill(t.ptyId); byPty.delete(t.ptyId); }
  t.term.dispose(); cache.delete(tabId);
}

/** Mount a cached terminal into this component; register the tab's TERMINAL surface while focused. */
export function useTerminal(tab: Tab, focused: boolean, spec: PtySpec | null, onExit?: (code: number | null) => void) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!spec || !host.current) return;
    const t = ensureTerm(tab.id, spec, onExit);
    host.current.appendChild(t.el);
    if (!t.term.element) {
      t.term.open(t.el);
      try { const gl = new WebglAddon(); gl.onContextLoss(() => gl.dispose()); t.term.loadAddon(gl); } catch { /* falls back to the DOM renderer */ }
    }
    const ro = new ResizeObserver(() => { if (t.el.offsetWidth > 0) { try { t.fit.fit(); } catch { /* hidden */ } } });
    ro.observe(host.current);
    requestAnimationFrame(() => { try { t.fit.fit(); } catch { /* hidden */ } if (t.ptyId === null && t.exited === undefined) void startPty(t); });
    return () => { ro.disconnect(); };
  }, [tab.id, !!spec]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!focused || !spec) return;
    const t = ensureTerm(tab.id, spec, onExit);
    const surface: Surface = {
      kind: 'terminal',
      mode: () => (isReading(tab.id) ? 'NORMAL' : 'TERMINAL'),
      key: (k, e) => (isReading(tab.id) ? readerKey(tab.id, k, e) : false),
    };
    const un = registerTab(tab.id, surface);
    if (!isReading(tab.id)) t.term.focus();
    update(s => { s.tick++; });
    return () => { un(); t.term.blur(); };
  }, [focused, tab.id, !!spec]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { const t = cache.get(tab.id); if (t) t.term.options.theme = theme(); }, [S.settings.theme]); // eslint-disable-line react-hooks/exhaustive-deps
  return host;
}

export function TerminalView({ t, focused, spec }: { t: Tab; focused: boolean; spec: PtySpec }) {
  const host = useTerminal(t, focused, spec);
  const e = cache.get(t.id);
  return (
    <div className="term-wrap">
      <div className="term-host" ref={host} onMouseDown={() => setTimeout(() => cache.get(t.id)?.term.focus(), 0)} />
      <LinkNote machine={machine(t.machine || 'local')} variant="term" />
      <UploadCard tabId={t.id} />
      {e && e.exited !== undefined && e.exited !== -1 && (
        <div className="t-exit kbrow"><span>Process exited{e.exited ? ` with code ${e.exited}` : ''}</span><span className="sp" /><Button small variant="primary" onClick={() => { e.term.reset(); void startPty(e); }}>Restart</Button></div>
      )}
    </div>
  );
}
export function retheme() { for (const t of cache.values()) t.term.options.theme = theme(); }

/** An image on its way to the remote before its path is pasted (G14); a failed one offers Retry or Discard. */
export function UploadCard({ tabId }: { tabId: string }) {
  const u = uploads.get(tabId); if (!u) return null;
  if (u.state === 'up') return (
    <div className="t-over" role="status"><Icon name="upload" /><span>Uploading <b>{u.name}</b> to {u.host}</span><span className="bar ind"><i /></span></div>
  );
  return (
    <div className="t-over bad kbrow" role="alert">
      <Icon name="alert" /><span title={u.error}>Couldn't upload <b>{u.name}</b> to {u.host}</span><span className="sp" />
      <Button small onClick={() => { discardUpload(tabId); cache.get(tabId)?.term.focus(); }}>Discard</Button>
      <Button small variant="primary" onClick={u.retry}>Retry</Button>
    </div>
  );
}
