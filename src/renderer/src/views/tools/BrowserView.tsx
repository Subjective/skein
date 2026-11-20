// The Browser tab: a dev server beside a thread. In the app the page is an Electron <webview> (main strips its
// preload, sandboxes it and allows http(s) only); in a plain browser (dev:web, UI tests) an <iframe> stands in.
// For a thread on an SSH machine, localhost means that machine: the port is forwarded over ssh and the page
// loads from the forwarded port, while the address bar keeps showing the remote's address.
//
// Keys (VIM-MODEL rule 11, like a terminal): in NORMAL `i` (or `gi`) gives the page the keyboard (TERMINAL) and
// `esc` takes it back; `r` reloads, `[` `]` and ctrl-o / ctrl-i go back and forward, `o` and mod-l (ctrl-l on a
// Mac too) edit the address, j k ctrl-d ctrl-u gg G scroll. While the page has the keys Skein keeps esc, the
// leader, alt-hjkl and its modifier shortcuts (main's before-input-event, or a listener in a same-origin iframe).
import { useEffect, useRef } from 'react';
import { api, inElectron } from '../../api';
import type { KeyLike } from '../../input/keys';
import { keyOf } from '../../input/keys';
import { canon } from '../../input/platform';
import * as A from '../../state/actions';
import { allTabs, type Tab } from '../../state/layout';
import { machine as machineOf, S, topLayer, update, useApp, ws } from '../../state/store';
import { dispatchKey, keptKeys, syncKeptKeys } from '../../shell/keyboard';
import { Button, Icon, IconButton, Spinner } from '../../ui/primitives';
import { VimField, type VimFieldHandle } from '../../ui/VimField';
import { display, hostOf, isLocalHost, normalize, portOf, withPort } from './address';
import { registerHooks, tabHook } from './hooks';
import { ctxOf, viewState } from './repo';
import { halfPage, useSurface } from './surface';

/** What a page host can do: a <webview> in the app, an <iframe> in a plain browser. */
interface Frame {
  el: HTMLElement;
  load(url: string): void;
  back(): void;
  forward(): void;
  reload(): void;
  stop(): void;
  canBack(): boolean;
  canForward(): boolean;
  focus(): void;
  scroll(js: string): void;
  /** the page's webContents id (webview), for keys main sends back */
  contents(): number | null;
  dispose(): void;
}

interface Events { nav(url: string): void; title(t: string): void; loading(on: boolean): void; fail(text: string, url: string): void; focus(): void; key(e: KeyLike): boolean }

interface BState {
  /** the page has the keyboard (TERMINAL) */
  page: boolean;
  /** the address bar's text while it is being edited; null shows the page's address */
  draft: string | null;
  loading: boolean;
  err?: { text: string; retry: () => void };
  /** an SSH machine's port, forwarded to this computer */
  via?: { name: string; host: string; port: number; local: number };
  /** the address loaded last, as loaded (the forwarded port for a remote) */
  loaded?: string;
  g: number;
}

const frames = new Map<string, Frame>();

/** A click into a page never reaches the window (it goes to the page's own process), but the window loses the
 *  focus to the frame: that is how a click into the page is noticed. */
function onClickIn(el: HTMLElement, ev: Events) {
  const blur = () => setTimeout(() => { if (document.activeElement === el) ev.focus(); }, 0);
  window.addEventListener('blur', blur);
  return () => window.removeEventListener('blur', blur);
}

function webviewFrame(ev: Events): Frame {
  const wv = document.createElement('webview') as HTMLElement & {
    src: string; loadURL(u: string): Promise<void>; goBack(): void; goForward(): void; reload(): void; stop(): void;
    canGoBack(): boolean; canGoForward(): boolean; getWebContentsId(): number; executeJavaScript(js: string): Promise<unknown>;
  };
  let ready = false;
  wv.setAttribute('partition', 'persist:skein-browser');
  wv.addEventListener('dom-ready', () => { ready = true; });
  wv.addEventListener('did-start-loading', () => ev.loading(true));
  wv.addEventListener('did-stop-loading', () => ev.loading(false));
  wv.addEventListener('did-navigate', e => ev.nav((e as unknown as { url: string }).url));
  wv.addEventListener('did-navigate-in-page', e => { const x = e as unknown as { url: string; isMainFrame: boolean }; if (x.isMainFrame) ev.nav(x.url); });
  wv.addEventListener('page-title-updated', e => ev.title((e as unknown as { title: string }).title));
  wv.addEventListener('did-fail-load', e => {
    const x = e as unknown as { errorCode: number; errorDescription: string; validatedURL: string; isMainFrame: boolean };
    if (x.isMainFrame && x.errorCode !== -3) ev.fail(x.errorDescription.replace(/^net::/, '') || `Error ${x.errorCode}`, x.validatedURL);
  });
  const off = onClickIn(wv, ev);
  const safe = (f: () => void) => { if (ready) try { f(); } catch { /* not attached yet */ } };
  return {
    el: wv,
    load: u => { if (ready) void wv.loadURL(u).catch(() => {}); else wv.src = u; },
    back: () => safe(() => wv.goBack()),
    forward: () => safe(() => wv.goForward()),
    reload: () => safe(() => wv.reload()),
    stop: () => safe(() => wv.stop()),
    canBack: () => { try { return ready && wv.canGoBack(); } catch { return false; } },
    canForward: () => { try { return ready && wv.canGoForward(); } catch { return false; } },
    focus: () => wv.focus(),
    scroll: js => safe(() => void wv.executeJavaScript(js).catch(() => {})),
    contents: () => { try { return ready ? wv.getWebContentsId() : null; } catch { return null; } },
    dispose: () => { off(); wv.remove(); },
  };
}

/** The plain-browser stand-in. It keeps its own history (a cross-origin frame's is out of reach); a same-origin
 *  page (what UI tests serve) also reports its title, in-page navigation and Skein's keys, like the webview. */
function iframeFrame(ev: Events): Frame {
  const f = document.createElement('iframe');
  f.setAttribute('title', 'Page');
  let hist: string[] = [], hi = -1;
  const go = (u: string) => { ev.loading(true); f.src = u; };
  const off = onClickIn(f, ev);
  f.addEventListener('load', () => {
    ev.loading(false);
    try {
      const w = f.contentWindow!, href = w.location.href;
      if (href !== 'about:blank' && href !== hist[hi]) { hist = [...hist.slice(0, hi + 1), href]; hi = hist.length - 1; ev.nav(href); }
      ev.title(w.document.title);
      w.addEventListener('keydown', e => { if (ev.key(e)) { e.preventDefault(); e.stopPropagation(); } }, true);
      w.addEventListener('focus', () => ev.focus());
    } catch { /* cross-origin: no title, no keys */ }
  });
  return {
    el: f,
    load: u => { hist = [...hist.slice(0, hi + 1), u]; hi = hist.length - 1; ev.nav(u); go(u); },
    back: () => { if (hi > 0) { hi--; ev.nav(hist[hi]); go(hist[hi]); } },
    forward: () => { if (hi < hist.length - 1) { hi++; ev.nav(hist[hi]); go(hist[hi]); } },
    reload: () => { if (hi >= 0) go(hist[hi]); },
    stop: () => { try { f.contentWindow?.stop(); } catch { /* */ } ev.loading(false); },
    canBack: () => hi > 0,
    canForward: () => hi < hist.length - 1,
    focus: () => { try { f.contentWindow?.focus(); } catch { /* */ } f.focus(); },
    scroll: js => { try { (f.contentWindow as unknown as { eval(s: string): unknown }).eval(js); } catch { /* cross-origin */ } },
    contents: () => null,
    dispose: () => { off(); f.remove(); },
  };
}

// main sends back the keys it kept from a page (webview): find the tab whose page it was
let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  api.on(e => {
    if (e.type !== 'browser.key') return;
    for (const [tabId, fr] of frames) if (fr.contents() === e.contents) { pageKey(tabId, e.key); return; }
  });
}

/** A key Skein keeps, pressed while a page had the keyboard. esc takes the keyboard back (NORMAL); anything else
 *  goes through the dispatcher as if the app had it, and the page keeps the keyboard (like a terminal). */
function pageKey(tabId: string, e: KeyLike) {
  const k = keyOf(e);
  if (k === 'esc') { leavePage(tabId); return; }
  // mod-l is not a terminal key (rule 11), so the dispatcher would pass it over in TERMINAL: the address bar takes it
  if (k === canon('mod-l')) { tabHook(tabId, 'addr'); return; }
  // the app takes this key and the next (a leader's second key, a palette's typing); the view gives the page
  // the keyboard back once nothing else wants it (see the effect in BrowserView)
  frames.get(tabId)?.el.blur();
  dispatchKey(e);
  update(s => { s.tick++; });
}

const stateOf = (tabId: string) => viewState<BState>(tabId + ':browser', () => ({ page: false, draft: null, loading: false, g: 0 }));

function leavePage(tabId: string) {
  const st = stateOf(tabId);
  st.page = false;
  frames.get(tabId)?.el.blur();
  document.querySelector<HTMLElement>(`[data-browser="${tabId}"]`)?.focus({ preventScroll: true });
  update(s => { s.tick++; });
}

export function BrowserView({ t, focused }: { t: Tab; focused: boolean }) {
  useApp();
  const st = stateOf(t.id);
  const host = useRef<HTMLDivElement>(null);
  const bar = useRef<VimFieldHandle>(null);
  const root = useRef<HTMLDivElement>(null);
  const ctx = ctxOf(t);
  const m = machineOf(ctx.machine);
  syncKeptKeys();

  /** The address as the user means it: a forwarded page's address put back on the remote's port. */
  const shown = (u: string) => (st.via && hostOf(u) === `localhost:${st.via.local}` ? withPort(u, st.via.port, st.via.host.replace(/:\d+$/, '')) : u);

  const go = async (url: string) => {
    st.err = undefined; st.draft = null;
    update(() => { t.url = url; t.title = undefined; });
    A.save();
    let target = url;
    const u = new URL(url);
    if (m?.ssh && isLocalHost(u.hostname)) {
      const port = portOf(url);
      st.loading = true; update();
      try {
        const local = await api.browser.forward(m.id, port);
        st.via = { name: m.name, host: u.host, port, local };
        target = withPort(url, local);
      } catch (e) {
        st.loading = false;
        st.err = { text: `Couldn't forward port ${port} from ${m.name}: ${(e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`, retry: () => void go(url) };
        update();
        return;
      }
    } else st.via = undefined;
    st.loaded = target;
    const fr = frames.get(t.id);
    if (fr) fr.load(target); else makeFrame(target);
    update();
  };

  // The page host lives as long as the tab (switching tabs only hides it, so the page keeps its state). It is made
  // with its first address: main refuses to attach a webview without an http(s) one.
  const makeFrame = (url: string) => {
    listen();
    const ev: Events = {
      nav: u => { if (!/^https?:/i.test(u)) return; const s = shown(u); if (s !== t.url) { t.url = s; t.title = undefined; A.save(); } st.loaded = u; update(); },
      title: x => { if (x && x !== t.title) { t.title = x; A.save(); update(); } },
      loading: on => { st.loading = on; if (on) st.err = undefined; update(); },
      fail: (text, u) => { st.err = { text: `Couldn't load ${display(shown(u) || t.url || '')}: ${text}`, retry: () => frames.get(t.id)?.reload() }; update(); },
      focus: () => {
        // a click into the page: it has the keyboard now, and its pane has the focus
        if (st.page) return;
        st.page = true;
        const hit = allTabs(ws()).find(x => x.tab.id === t.id);
        if (hit?.pane) A.activate(hit.pane.id, t.id); else update(() => { ws().pf = t.id; });
        update(s => { s.sideFocus = false; s.tick++; });
      },
      key: e => { const k = keyOf(e); if (!k || !keptKeys().has(k)) return false; pageKey(t.id, e); return true; },
    };
    const fr = (inElectron ? webviewFrame : iframeFrame)(ev);
    frames.set(t.id, fr);
    fr.load(url);
    host.current?.appendChild(fr.el);
  };
  const goRef = useRef(go); goRef.current = go;
  useEffect(() => {
    if (t.url) void goRef.current(t.url);
    return () => { const fr = frames.get(t.id); fr?.dispose(); frames.delete(t.id); st.loaded = undefined; };
  }, [t.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const fr = frames.get(t.id);
  const editAddress = () => {
    st.page = false;
    st.draft = display(t.url || '');
    update();
    requestAnimationFrame(() => { bar.current?.focus(true); bar.current?.el()?.select(); });
    return true;
  };
  const enterPage = () => {
    if (!fr || !t.url) return editAddress();
    st.page = true; update(s => { s.tick++; });
    fr.focus();
    return true;
  };
  const back = () => { if (!fr?.canBack()) return false; fr.back(); return true; };
  const forward = () => { if (!fr?.canForward()) return false; fr.forward(); return true; };
  const reload = () => { if (st.err) st.err.retry(); else if (t.url && !st.loaded) void go(t.url); else fr?.reload(); return true; };
  useEffect(() => registerHooks(t.id, { back, forward, addr: editAddress }));

  const { own } = useSurface(t.id, focused, {
    kind: 'terminal',
    mode: () => (st.page ? 'TERMINAL' : 'NORMAL'),
    key: k => {
      if (st.page) {
        // the page lost the keys to the app (a palette closed, a click on the bar): esc leaves, anything else goes back in
        if (k === 'esc') { leavePage(t.id); return true; }
        fr?.focus();
        return false;
      }
      const g = Date.now() - st.g < 1200; st.g = 0;
      const step = halfPage(host.current, 20) * 20;
      switch (k) {
        case 'i': case 'a': return enterPage();
        case 'o': case 'ctrl-l': return editAddress();
        case 'r': case 'f5': return reload();
        case '[': return back() || true;
        case ']': return forward() || true;
        case 'j': case 'down': fr?.scroll('scrollBy(0, 60)'); return true;
        case 'k': case 'up': fr?.scroll('scrollBy(0, -60)'); return true;
        case 'ctrl-d': case 'pagedown': fr?.scroll(`scrollBy(0, ${step})`); return true;
        case 'ctrl-u': case 'pageup': fr?.scroll(`scrollBy(0, -${step})`); return true;
        case 'G': case 'end': fr?.scroll('scrollTo(0, document.documentElement.scrollHeight)'); return true;
        case 'g': if (g) { fr?.scroll('scrollTo(0, 0)'); return true; } st.g = Date.now(); return false; // `g t`, `g i` stay sequences
        case 'enter': if (st.err) { st.err.retry(); return true; } return false;
      }
      return false;
    },
  });

  // coming back to a tab whose page had the keys (alt-l, a closed palette) gives them back to the page
  useEffect(() => {
    if (focused && st.page && !topLayer() && !S.sideFocus && !S.leader && !S.seq && fr && document.activeElement !== fr.el) fr.focus();
  });
  // a new, empty Browser tab starts in its address bar
  useEffect(() => { if (focused && !t.url) editAddress(); }, [focused]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = () => {
    const raw = st.draft ?? '';
    const url = normalize(raw);
    if (!url) { st.err = { text: `Not a web address: ${raw.trim() || '(empty)'}`, retry: () => editAddress() }; update(); return; }
    (document.activeElement as HTMLElement | null)?.blur();
    own();
    root.current?.focus({ preventScroll: true });
    void go(url);
  };
  const leaveBar = () => { st.draft = null; own(); (document.activeElement as HTMLElement | null)?.blur(); root.current?.focus({ preventScroll: true }); update(); };

  const value = st.draft ?? display(t.url || '');
  return (
    <div className="browser-v" ref={root} tabIndex={-1} data-browser={t.id} onMouseDown={e => { if (!(e.target as HTMLElement).closest('.br-bar')) own(); }}>
      <header className="tool-h">
        <IconButton icon="chev" className="flip" small label="Back" keys="ctrl-o" disabled={!fr?.canBack()} onClick={back} />
        <IconButton icon="chev" small label="Forward" keys="ctrl-i" disabled={!fr?.canForward()} onClick={forward} />
        {st.loading
          ? <IconButton icon="x" small label="Stop" onClick={() => fr?.stop()} />
          : <IconButton icon="retry" small label="Reload" keys="r" disabled={!t.url} onClick={reload} />}
        <label className="br-bar">
          {st.loading ? <Spinner label="Loading" /> : <Icon name={m?.ssh ? 'host' : 'globe'} size="sm" />}
          <VimField ref={bar} tabId={t.id} value={value} placeholder="localhost:5173" className="br-f"
            onChange={x => { st.draft = x.replace(/\n/g, ''); }}
            onEnter={submit} onLeave={leaveBar} />
          {st.via && st.draft === null && <span className="br-via" title={`${st.via.host} on ${st.via.name}, forwarded to localhost:${st.via.local}`}>{st.via.name} → :{st.via.local}</span>}
        </label>
        <IconButton icon="external" small label="Open in browser" disabled={!t.url} onClick={() => { if (t.url) void api.app.openExternal(st.loaded || t.url); }} />
      </header>
      {st.err && (
        <div className="br-err"><div className="err-row" role="alert">
          <Icon name="alert" /><span className="br-et" title={st.err.text}>{st.err.text}</span><span className="sp" />
          <Button small variant="primary" onClick={() => st.err?.retry()}>Retry</Button>
        </div></div>
      )}
      <div className={'br-page' + (t.url ? '' : ' blank')} ref={host}>
        {!t.url && <div className="r-empty"><Icon name="globe" size="xl" /><span className="dim">Type an address, or a port like 5173{m?.ssh ? ` on ${m.name}` : ''}</span></div>}
      </div>
    </div>
  );
}
