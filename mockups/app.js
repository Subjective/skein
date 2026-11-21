/* Skein mockup: state, pane tree, tabs, sidebar, menus, scenes.
   Mock only: no real terminals or agents. Views live in view-terminal.js / view-chat.js.

   Layout model: a tmux-style tree of splits whose leaves are panes. Every pane is a tab group.
   A tab is a thread (shown as chat or as its terminal, toggled per tab), a shell, a launcher,
   or a tool scoped to a thread (changes, files, browser, side chat). There is no global mode. */
(function () {
  // ---------- helpers ----------
  window.esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  window.md = (t, inline) => {
    // inline code that names a file (a path with an extension, or a file the project has) is a link to it
    const isFile = c => /^[\w.~\/-]+\.[a-z]{1,5}$/i.test(c) && (c.includes('/') || D.files.includes(c));
    const f = s => esc(s).replace(/`([^`]+)`/g, (m, c) => (isFile(c) ? `<code class="flink" data-act="openFile" data-p="${c}" title="Open ${c} · g f">${c}</code>` : `<code>${c}</code>`)).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    return inline ? f(t) : t.split(/\n\n+/).map(b => '<p>' + f(b) + '</p>').join('');
  };
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const el = html => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
  const base = p => p.replace(/^.*\//, '');
  const age = a => (a < 1 ? '' : a < 60 ? a + 'm' : a < 1440 ? Math.round(a / 60) + 'h' : Math.round(a / 1440) + 'd');
  const mach = id => D.machines.find(m => m.id === id);
  const sess = id => D.sessions.find(s => s.id === id);
  const subOf = t => (sess(t.sid).subs || []).find(g => g.id === t.gid);
  const sideOf = t => (sess(t.sid).sides || []).find(x => x.id === t.scid);
  const HN = { claude: 'Claude Code', codex: 'Codex' };
  // remote machines: one dot whose shape says the link state (G5). Connecting and reconnecting pulse.
  const LINK = { up: ['green', 'Connected'], connecting: ['amber pulse', 'Connecting'], reconnecting: ['amber pulse', 'Reconnecting'], auth: ['amber', 'Needs you to sign in'], down: ['red', 'Not connected'] };
  const linkOf = m => m.link || (m.up ? 'up' : 'down');
  const mdot = m => (m.ssh ? `<span class="dot ${LINK[linkOf(m)][0]}" role="img" aria-label="${LINK[linkOf(m)][1]}" title="${LINK[linkOf(m)][1]}"></span>` : '');
  const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);

  // ---------- state ----------
  const qs = new URLSearchParams(location.search);
  const OS = window.OS;
  const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
  const forced = { terminal: 'term', chat: 'chat' }[qs.get('mode')];     // ?mode= forces every thread tab, for screenshots
  const VIMRC = `" Skein vimrc
" Applies to composers, readers (terminal scrollback included) and app NORMAL.
" A terminal's input line belongs to the program running in it, so these maps do not apply there.

inoremap jk <Esc>

nnoremap T :termall<CR>
nnoremap C :chatall<CR>
`;
  const S = window.S = {
    theme: qs.get('theme') || store.get('ad2-theme') || document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'),
    sideView: qs.get('side') || store.get('ad2-side') || 'grouped',      // grouped | recent
    view: forced || store.get('ad2-view') || 'chat',                      // default view for a newly opened thread
    vimOn: (qs.get('vim') || store.get('ad2-vim') || 'on') === 'on',
    sideOpen: true, collapsed: {}, projects: {}, cursor: null, order: [],
    tree: null, focus: null, zoom: false,
    ws: [], wid: null,                                                   // workspaces, and the one on screen (its layout is the live S.tree ...)
    pops: [], pf: null,                                                  // floating popups: [{ t: tab, x, y }], and the id of the focused one
    vim: 'NORMAL', cn: false, cpos: 0, leader: false, lastModel: 'Opus 5.5',
    vimrc: store.get('ad2-vimrc') || VIMRC, imap: [], nmap: {}, lmap: {}, noteFocus: null,
    leaderKey: store.get('ad2-leader') || 'ctrl-space', notify: store.get('ad2-notify') || 'waiting',
  };
  document.documentElement.dataset.os = OS;
  // The mock honours three vimrc forms: `inoremap xy <Esc>`, `nnoremap X :command<CR>` and
  // `nnoremap <leader>X :command<CR>`. The keyboard popup writes the last two.
  function readVimrc() {
    S.imap = []; S.nmap = {}; S.lmap = {};
    for (const l of S.vimrc.split('\n')) {
      let m;
      if ((m = /^\s*inoremap\s+(\S\S)\s+<Esc>/i.exec(l))) S.imap.push(m[1]);
      else if ((m = /^\s*nnoremap\s+<leader>(\S)\s+:(.+?)<CR>/i.exec(l))) S.lmap[m[1]] = m[2];
      else if ((m = /^\s*nnoremap\s+(\S)\s+:(.+?)<CR>/i.exec(l))) S.nmap[m[1]] = m[2];
    }
  }

  // ---------- tabs and the pane tree ----------
  let uid = 0;
  const defaults = model => ({ model, effort: 'Medium', ultra: false, perm: D.perms[D.harnessOf(model)][0] });
  const T = {
    mk: (kind, x) => ({ id: 't' + (++uid), kind, draft: '', atts: [], notes: [], ...x }),
    file: (path, sid) => T.mk('file', { path, sid, mode: 'preview' }),
    vimrc: () => T.mk('vimrc', {}),
    sub: (sid, gid) => T.mk('sub', { sid, gid }),
    thread: (sid, view) => T.mk('thread', { sid, view: forced || view || S.view }),
    shell: (machine, dir, lines = []) => T.mk('shell', { machine, dir, lines }),
    fresh(from) { const w = S.ws.find(w => w.id === S.wid), c = from ? ctxOf(from) : { machine: w ? w.machine : 'local', dir: w ? w.dir : D.dirs.local[0] }; return T.mk('new', { machine: c.machine, dir: c.dir, sid: c.sid, worktree: false, ...defaults(S.lastModel) }); },
    tool: (kind, sid) => T.mk(kind, { sid, scope: 'uncommitted' }),     // changes | files | browser
    side: (sid, scid) => T.mk('side', { sid, scid }),
  };
  const P = {
    pane: (...tabs) => ({ type: 'pane', id: 'p' + (++uid), tabs, active: tabs[0].id }),
    split: (dir, a, b, ratio = 0.5) => ({ type: 'split', id: 'x' + (++uid), dir, ratio, a, b }),
    leaves(n = S.tree, out = []) { if (n.type === 'pane') out.push(n); else { P.leaves(n.a, out); P.leaves(n.b, out); } return out; },
    get: id => P.leaves().find(p => p.id === id),
    replace(id, fn, n = S.tree) { if (n.id === id) return fn(n); if (n.type === 'split') { n.a = P.replace(id, fn, n.a); n.b = P.replace(id, fn, n.b); } return n; },
    remove(id, n = S.tree) { if (n.type !== 'split') return n; if (n.a.id === id) return n.b; if (n.b.id === id) return n.a; n.a = P.remove(id, n.a); n.b = P.remove(id, n.b); return n; },
    splitAt(id, dir, node, before) { S.tree = P.replace(id, old => P.split(dir, before ? node : old, before ? old : node)); },
    path(id, n = S.tree, acc = []) { if (n.type === 'pane') return n.id === id ? acc : null; return P.path(id, n.a, [...acc, { s: n, side: 'a' }]) || P.path(id, n.b, [...acc, { s: n, side: 'b' }]); },
    swap(a, b) { const ta = { ...a }, tb = { ...b }; for (const k in a) delete a[k]; for (const k in b) delete b[k]; Object.assign(a, tb); Object.assign(b, ta); },
    corner(right) { let n = S.tree; while (n.type === 'split') n = n.dir === 'row' ? (right ? n.b : n.a) : n.a; return n; },   // top-right / top-left pane
  };
  const focused = () => P.get(S.focus) || P.leaves()[0];
  const cur = g => g.tabs.find(t => t.id === g.active) || g.tabs[0];
  const pop = id => S.pops.find(p => p.t.id === id);
  const curTab = () => (S.pf && pop(S.pf) ? pop(S.pf).t : cur(focused()));
  const allTabs = () => P.leaves().flatMap(g => g.tabs.map(t => ({ t, g })));
  const everyTab = () => [...allTabs().map(x => x.t), ...S.pops.map(p => p.t)];
  const evs = t => (t.kind === 'side' ? sideOf(t).events : t.kind === 'sub' ? subOf(t).events : sess(t.sid).events);
  const findTab = id => (pop(id) ? { t: pop(id).t, g: null } : allTabs().find(x => x.t.id === id));
  const ctxOf = t => { const s = t.sid && sess(t.sid); return s && t.kind !== 'new' ? { machine: s.machine, dir: s.dir, branch: s.branch, sid: s.id } : { machine: t.machine || 'local', dir: t.dir || D.dirs.local[0], sid: t.sid }; };
  const shown = sid => allTabs().find(x => x.t.kind === 'thread' && x.t.sid === sid);

  function tabMeta(t) {
    const c = ctxOf(t), m = mach(c.machine), s = t.sid && sess(t.sid);
    const st = s && t.kind === 'thread' ? threadStatus(s) : '';
    switch (t.kind) {
      case 'thread': return { icon: s.harness, title: s.title, st, ssh: m.ssh };
      case 'shell': return { icon: 'terminal', title: m.ssh ? 'bash' : OS === 'mac' ? 'zsh' : 'PowerShell', st, ssh: m.ssh };
      case 'side': return { icon: 'chat', title: sideOf(t).title, st };
      case 'sub': return { icon: 'agent', title: subOf(t).name, st: subOf(t).status === 'running' ? '<span class="spin"></span>' : '' };
      case 'changes': return { icon: 'diff', title: 'Changes', st };
      case 'files': return { icon: 'folder', title: 'Files', st };
      case 'file': return { icon: 'file', badge: Tools.lang(t.path), title: base(t.path), st };
      case 'vimrc': return { icon: 'sliders', title: 'vimrc', st };
      case 'browser': return { icon: 'globe', title: 'localhost:5173', st };
      default: return { icon: 'compose', title: 'New thread', st };
    }
  }

  // ---------- sidebar ----------
  function threadStatus(s) {
    let icon, label;
    switch (s.status) {
      case 'running': return '<span class="spin" role="img" aria-label="Working" title="Working"></span>';
      case 'unread': return '<span class="dot blue" role="img" aria-label="Unread reply" title="Unread reply"></span>';
      case 'wait': {
        const pending = s.events.find(e => e.t === 'approval' || e.t === 'plan');
        icon = pending ? 'shield' : 'chat';
        label = pending ? (pending.t === 'plan' ? 'Awaiting plan approval' : 'Awaiting approval') : 'Awaiting your reply';
        break;
      }
      case 'error': icon = 'alert'; label = 'Turn failed'; break;
      default: return '';
    }
    return `<span class="thread-state" role="img" aria-label="${label}" title="${label}">${ic(icon)}</span>`;
  }
  const projectName = (machine, dir) => store.get('ad2-project:' + machine + ':' + dir) || (machine === 'local' && dir === '~/projects/skein' ? 'Skein' : base(dir));

  function editSidebarName(row) {
    const label = row.querySelector('.t'), original = label.textContent;
    const session = row.dataset.sid && sess(row.dataset.sid);
    const input = document.createElement('input');
    input.className = 'sidebar-name-input';
    input.setAttribute('aria-label', session ? 'Thread name' : 'Project name');
    input.value = label.textContent;
    label.replaceChildren(input);
    input.focus();
    input.select();
    input.onclick = event => event.stopPropagation();
    input.onkeydown = event => {
      if (event.isComposing) return;
      if (event.key === 'Escape') input.value = original;
      if (event.key === 'Enter' || event.key === 'Escape') {
        event.preventDefault();
        input.blur();
      }
    };
    input.onblur = () => {
      const name = input.value.trim() || original;
      label.textContent = name;
      if (name === original) return;
      if (session) {
        session.title = name;
        store.set('ad2-title:' + session.id + ':', name);
        render();
        return;
      }
      const { m, d } = row.querySelector('.add').dataset;
      store.set('ad2-project:' + m + ':' + d, name);
      $$('#side .row .sfx').forEach(suffix => {
        const thread = sess(suffix.closest('.row').dataset.sid);
        if (thread.machine === m && thread.dir === d) suffix.lastElementChild.textContent = name;
      });
    };
  }

  function row(s, o = {}) {
    const ft = cur(focused()), m = mach(s.machine);
    const cls = ['row', shown(s.id) ? 'vis' : '', ft.sid === s.id && ft.kind === 'thread' ? 'foc' : '', S.cursor === s.id ? 'cur' : '', s.fresh ? 'fresh' : ''].join(' ');
    const d = o.d || 0;   // threads sit under their folder
    return `<div class="${cls}" style="--d:${d}" data-act="open" data-sid="${s.id}"${s.archived ? '' : ' draggable="true"'} title="${esc(s.title)} · ${esc(m.name)} ${esc(s.dir)}">
      ${ic(s.harness, 'hm')}<span class="t">${esc(s.title)}</span>
      ${o.sfx ? `<span class="sfx ${m.ssh ? 'ssh' : ''}">${m.ssh ? ic('host') : ''}<span>${esc(projectName(s.machine, s.dir))}</span></span>` : ''}
      <span class="row-actions">
        ${s.archived ? '' : `<button data-act="pin" title="${s.pinned ? 'Unpin' : 'Pin'}">${ic('pin')}</button>`}
        <button data-act="archive" title="${s.archived ? 'Restore thread' : 'Archive thread'}">${ic(s.archived ? 'retry' : 'archive')}</button>
      </span>
      <span class="st">${stIcon(s)}</span></div>`;
  }

  function projectOrder(machine, sessions) {
    let saved;
    try { saved = JSON.parse(store.get('ad2-dir-order:' + machine)); } catch {}
    const dirs = new Set(sessions.map(s => s.dir));
    const ordered = Array.isArray(saved) ? saved.filter(d => dirs.delete(d)) : [];
    return ordered.concat([...dirs]);
  }

  function renderSide() {
    const list = D.sessions;
    const archived = list.filter(s => s.archived);
    const pinned = list.filter(s => !s.archived && s.pinned), rest = list.filter(s => !s.archived && !s.pinned);
    let h = `<div class="s-top">
        <button class="ib" data-act="toggleSide" title="Hide sidebar · ${kb('ldr b')}">${ic('sidebar')}</button>
        <button class="ib" data-act="palette" title="Search · ${kb('mod-k')}">${ic('search')}</button>
        <span class="sp"></span>
        <button class="ib" data-act="view" title="${S.sideView === 'grouped' ? 'Grouped by machine and folder' : 'Most recently active'} · click to switch">${ic(S.sideView === 'grouped' ? 'tree' : 'clock')}</button>
      </div>
      <div class="s-nav"><button class="nav" data-act="newThread">${ic('compose')}<span>New thread</span></button></div>
      <div class="s-list">`;
    // a section heading (Pinned, Recent, a machine) folds its section on click; folded, it keeps its chevron
    const head = (k, label, machine) => `<div class="s-h ${S.collapsed[k] ? 'shut' : ''}" data-act="fold" data-k="${k}"${machine ? ` title="${machine.ssh ? 'Remote machine (SSH)' : 'Local machine'}"` : ''}><span>${esc(label)}</span>${machine ? ic(machine.ssh ? 'host' : 'laptop', 'machine-kind') : ''}${machine && machine.ssh ? (linkOf(machine) === 'auth' ? `<button class="mlink" data-act="machineLink" data-m="${esc(machine.id)}" title="Sign in to ${esc(label)}">${mdot(machine)}</button>` : mdot(machine)) : ''}${ic('chev', 'ch')}${machine ? `
      <span class="machine-actions">
        <button class="ib sm" data-act="machineActions" data-m="${esc(machine.id)}" title="Actions for ${esc(label)}">${ic('dots')}</button>
        <button class="ib sm" data-act="addProject" data-m="${esc(machine.id)}" title="Add a project on ${esc(label)}">${ic('plus')}</button>
      </span>` : ''}</div><div class="sidebar-group"${S.collapsed[k] ? ' inert' : ''}><div>`;
    if (pinned.length) h += head('h:pinned', 'Pinned') + pinned.map(s => row(s)).join('') + '</div></div>';
    if (S.sideView === 'recent') h += head('h:recent', 'Recent') + [...rest].sort((a, b) => a.age - b.age).map(s => row(s, { sfx: true })).join('') + '</div></div>';
    else for (const m of D.machines) {
      const ss = rest.filter(s => s.machine === m.id), extra = (S.projects[m.id] || []).filter(d => !ss.some(s => s.dir === d));
      if (!ss.length && !extra.length) continue;
      h += head('h:' + m.id, m.name, m);
      for (const d of [...projectOrder(m.id, ss), ...extra]) {
        const k = m.id + d, shut = S.collapsed[k];
        h += `<div class="s-d" draggable="true" data-machine="${esc(m.id)}" data-dir="${esc(d)}" data-act="fold" data-k="${esc(k)}">${ic(shut ? 'folder' : 'folderOpen', 'project-folder')}<span class="t">${esc(projectName(m.id, d))}</span>
          <button class="ib sm add" data-act="newIn" data-m="${m.id}" data-d="${esc(d)}" title="New thread in ${esc(d)}">${ic('compose')}</button></div>`;
        h += `<div class="project-threads"${shut ? ' inert' : ''}><div>`;
        h += ss.filter(s => s.dir === d).sort((a, b) => a.age - b.age).map(s => row(s, { d: 1 })).join('');
        h += '</div></div>';
      }
      h += '</div></div>';
    }
    h += `<div class="s-arch ${S.archiveOpen ? 'expanded' : ''}" data-act="toggleArchive">${ic('chev', 'ch')}<span>Archived</span></div>${S.archiveOpen ? archived.map(s => row(s, { sfx: true })).join('') : ''}</div>
      <div class="s-foot">
        <button class="mbtn" data-act="machines" title="Machines">${ic('host')}</button>
        <span class="sp"></span>
        <button class="ib" data-act="keys" title="Keyboard · ?">${ic('keyboard')}</button>
        <button class="ib" data-act="settings" title="Settings">${ic('sliders')}</button>
      </div>`;
    $('#side').innerHTML = h + '<div class="side-resize" title="Drag to resize sidebar"></div>';
    updateSidebarOrder(); paintNav();
  }

  function redrawDisclosure(header) {
    const start = getComputedStyle(header.querySelector('.ch')).transform;
    const scroll = header.parentElement.scrollTop;
    renderSide();
    $('#side .s-list').scrollTop = scroll;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const selector = header.dataset.k ? `[data-k="${CSS.escape(header.dataset.k)}"]` : '.s-arch';
    const arrow = $('#side ' + selector + ' .ch');
    arrow.animate([{ transform: start }, { transform: getComputedStyle(arrow).transform }], {
      duration: 160, easing: 'ease-out'
    });
  }

  function updateSidebarOrder() {
    S.order = $$('#side [data-act="open"]').filter(row => !row.closest('[inert]')).map(row => row.dataset.sid);
  }

  // ---------- panes ----------
  // chat | terminal. For Claude Code a small mark shows which of the two is driving the thread (G4).
  function viewSeg(t) {
    const s = sess(t.sid), drv = s.harness === 'claude' ? (s.drive === 'term' ? 'term' : 'chat') : null;
    const b = (v, i, n) => `<button class="${t.view === v ? 'on' : ''} ${drv === v ? 'drv' : ''}" data-act="setView" data-v="${v}" aria-pressed="${t.view === v}" title="${n}${drv === v ? ' · driving' : drv ? ' · read-only while the other view drives' : ''}">${ic(i)}</button>`;
    return `<div class="seg" role="group" aria-label="Chat or terminal · ldr t">${b('chat', 'chat', 'Chat')}${b('term', 'terminal', 'Terminal')}</div>`;
  }
  function tabBar(g) {
    const a = cur(g), tl = !S.sideOpen && g === P.corner(false), tr = g === (S.zoom ? focused() : P.corner(true));
    const tabs = g.tabs.map(t => {
      const m = tabMeta(t);
      return `<div class="tab ${t.id === a.id ? 'on' : ''} ${t.kind === 'file' && Tools.dirty(t) ? 'dirty' : ''}" data-act="tab" data-id="${t.id}" title="${esc(m.title)}">${m.badge || ic(m.icon)}${m.ssh ? ic('host') : ''}<span class="t">${esc(m.title)}</span>${m.st}<button class="tx" data-act="tabClose" data-id="${t.id}" title="Close tab · hold alt to pop it out">${ic('x')}${ic('popout')}</button></div>`;
    }).join('');
    const seg = a.kind === 'thread' ? viewSeg(a) : '';
    return `<header class="tb ${tl ? 'corner' : ''}">
      ${tl ? `<button class="ib" data-act="toggleSide" title="Show sidebar">${ic('sidebar')}</button><button class="ib" data-act="palette" title="Search · ${kb('mod-k')}">${ic('search')}</button>` : ''}
      <div class="tabs">${tabs}</div>
      <button class="ib sm" data-act="tabNew" title="New tab · ldr c">${ic('plus')}</button>
      <span class="drag"></span>
      ${seg}
      <button class="ib sm ${S.zoom ? 'on' : ''}" data-act="tabSearch" title="Search this pane · ${kb('mod-shift-a')}">${ic('down')}</button>
      ${tr && OS !== 'mac' ? `<span class="wc"><i>${ic('min')}</i><i>${ic('max')}</i><i class="cl">${ic('x')}</i></span>` : ''}
    </header>`;
  }

  // launcher: what a new tab shows. One composer (the model picks the harness) plus the other tab types.
  function launcher(t) {
    const m = mach(t.machine);
    const cards = [['shell', 'terminal', 'Shell'], ['changes', 'diff', 'Changes'], ['files', 'file', 'Files'], ['browser', 'globe', 'Browser']];
    return `<div class="newp"><div class="col">
      ${Chat.composer(t, t, { placeholder: 'Ask anything' })}
      <div class="under pick">
        <button class="chip" data-act="pickMachine" title="Machine">${ic(m.ssh ? 'host' : 'laptop')}<span>${esc(m.name)}</span>${m.up ? '' : '<span class="dot red"></span>'}${ic('down', 'sm')}</button>
        <button class="chip path" data-act="pickDir" title="Directory">${ic('folder')}<span>${esc(t.dir)}</span>${ic('down', 'sm')}</button>
        <span class="sp"></span>
        <button class="chip ${t.worktree ? 'on' : ''}" data-act="worktree" title="Start in a new git worktree">${ic('branch')}<span class="lbl">${t.worktree ? 'new worktree' : 'main'}</span></button>
      </div>
      <div class="cards">${cards.map(([k, i, n]) => `<button class="card" data-act="openKind" data-v="${k}">${ic(i)}<span>${n}</span></button>`).join('')}</div>
    </div></div>`;
  }

  function toolBody(t) {
    if (t.kind === 'changes') return Tools.changes(t, t.sid && sess(t.sid));
    if (t.kind === 'files') return Tools.files(t);
    if (t.kind === 'file') return Tools.file(t, t.sid && sess(t.sid));
    if (t.kind === 'vimrc') return Tools.vimrc();
    return `<div class="tool-b"><div class="r-url">${ic('globe')}<span>localhost:5173</span>${ic('retry')}</div><img class="r-shot" src="${D.img.shot}" data-zoom alt=""></div>`;
  }

  function tabBody(t) {
    if (t.kind === 'new') return launcher(t);
    if (t.kind === 'shell') return Term.shell(t, mach(t.machine));
    if (t.kind === 'thread') return t.view === 'term' ? Term.session(t, sess(t.sid)) : Chat.thread(t, sess(t.sid));
    if (t.kind === 'side') return Chat.side(t, sess(t.sid), sideOf(t));
    if (t.kind === 'sub') return Chat.sub(t, sess(t.sid), subOf(t));
    return toolBody(t);
  }
  const renderPane = g => `<section class="pane ${g.id === focused().id && !S.pf ? 'focus' : ''}" data-pane="${g.id}">${tabBar(g)}<div class="body" data-tab="${cur(g).id}">${tabBody(cur(g))}</div></section>`;
  const renderNode = n => n.type === 'pane' ? renderPane(n)
    : `<div class="split d-${n.dir}" data-x="${n.id}"><div class="cell" style="flex:${n.ratio}">${renderNode(n.a)}</div><div class="dv"></div><div class="cell" style="flex:${1 - n.ratio}">${renderNode(n.b)}</div></div>`;

  function renderWork() {
    const f = focused(), many = P.leaves().length > 1;
    let h = `<div class="panes ${many ? 'many' : 'one'}">${S.zoom && many ? renderPane(f) : renderNode(S.tree)}</div>`;
    if (S.zoom && many) h += `<div class="rail">${P.leaves().map(g => { const m = tabMeta(cur(g)); return `<button class="${g.id === f.id ? 'on' : ''}" data-act="railFocus" data-id="${g.id}" title="${esc(m.title)}">${ic(m.icon)}${m.st}</button>`; }).join('')}</div>`;
    // Popups float above the panes: drag one by its header, resize it from its corner. The x closes it;
    // with alt/option held the x becomes "put this back as a tab in the focused pane".
    S.pops.forEach((p, n) => {
      const t = p.t, m = tabMeta(t), wide = t.kind !== 'side';
      const seg = t.kind === 'thread' ? viewSeg(t) : '';
      h += `<section class="peek ${wide ? 'wide' : ''} ${S.pf === t.id ? 'focus' : ''}" data-tab="${t.id}" style="${p.x == null ? `right:${28 + n * 26}px;top:${56 + n * 26}px` : `left:${p.x}px;top:${p.y}px`}${p.w ? `;width:${p.w}px;height:${p.h}px` : ''}">${['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map(d => `<i class="rz rz-${d}" data-rz="${d}"></i>`).join('')}
        <header class="tb">${ic(m.icon)}<span class="pt">${esc(m.title)}</span>${m.st}<span class="drag"></span>${seg}
          <button class="ib sm px" data-act="peekClose" title="Close · hold alt to put it back as a tab">${ic('x')}${ic('dockin')}</button></header>
        <div class="body">${tabBody(t)}</div></section>`;
    });
    $('#work').innerHTML = h;
  }

  // ---------- status bar ----------
  const LEADER = [['v', 'split →'], ['s', 'split ↓'], ['%', 'shell →'], ['"', 'shell ↓'], ['c', 'new tab'], ['q', 'close tab'], ['t', 'chat ⇄ term'], ['z', 'zoom'], ['w', 'workspaces'], ['hjkl', 'focus'], ['HJKL', 'move'], ['<>', 'resize'], ['x', 'swap'], ['esc', 'normal']];
  const visual = () => S.cv || (window.Reader && Reader.visual);   // VISUAL in a composer, or over read-only text
  function renderStatus() {
    const c = ctxOf(curTab()), m = mach(c.machine);
    // the pill follows whatever has the keys: an open menu, visual selection, else the composer / app
    const menu = Menu.cur && !['slash', 'at'].includes(Menu.cur.o.tag) ? (Menu.cur.ins ? 'INSERT' : 'NORMAL') : null;
    const line = S.cv === 'V' || (window.Reader && Reader.on && Reader.mode === 'V');
    const ae = document.activeElement, term = S.vim === 'INSERT' && ae && ae.closest && ae.closest('.term') && ae.matches('[data-input]');
    const mode = menu || (visual() ? (line ? 'V-LINE' : 'VISUAL') : term ? 'TERMINAL' : S.vim);
    const mid = S.leader ? `<span class="lead">${LEADER.map(([k, l]) => `<span><kbd>${esc(k)}</kbd>${l}</span>`).join('')}</span>`
      : `<span class="loc">${ic(m.ssh ? 'host' : 'laptop')}<span>${esc(m.name)}</span><span class="dim">${esc(c.dir)}</span>${c.branch ? ic('branch') + '<span class="dim">' + esc(c.branch) + '</span>' : ''}</span>`;
    const w = WS.cur(), wsb = w ? `<button class="wsb" data-act="wsMenu" title="Workspaces · ctrl-tab goes to the last one">${esc(w.name)}${S.ws.some(x => x.id !== w.id && WS.waiting(x)) ? '<i class="wdot"></i>' : ''}</button>` : '';
    $('#status').innerHTML = `${S.vimOn ? `<span class="vim ${mode === 'INSERT' ? 'ins' : ''} ${mode === 'TERMINAL' ? 'trm' : ''} ${mode[0] === 'V' ? 'vis' : ''}" role="status" aria-live="polite" aria-label="Mode ${mode}">${mode}</span>` : ''}${wsb}${mid}<span class="sp"></span>
      <button class="ib sm" data-act="scenes" title="Mockup scenes (not part of the app)">${ic('layers')}</button>`;
  }

  // ---------- render ----------
  let renders = 0;
  function render() {
    if (drag) return;
    renders++;
    if (Menu.cur && Menu.cur.o.host) Menu.close();
    if (window.Reader) Reader.off();
    document.documentElement.dataset.theme = S.theme;
    $('#app').classList.toggle('noside', !S.sideOpen);
    renderSide(); renderWork(); renderStatus(); fitTabs();
    if (OS === 'mac' && !$('#app > .lights')) $('#app').insertAdjacentHTML('afterbegin', '<span class="lights" aria-hidden="true"><i></i><i></i><i></i></span>');
    $$('[data-scroll]').forEach(e => { e.scrollTop = e.scrollHeight; });
    $$('textarea[data-input]:not(.rc-ed)').forEach(t => { grow(t); paintBk(t); });
    $$('.chat:not(.side) > .thread').forEach(ticks);
    if (window.Annot) Annot.paint();
    const menuHasFocus = Menu.cur && Menu.cur.o.search;
    if ((S.vim === 'INSERT' || S.cn) && !menuHasFocus) refocus();
    if (S.restore) {   // put the keyboard back where it was (see popOut)
      const pl = S.restore; S.restore = null;
      if (pl.r) Reader.goto(pl.r); else if (pl.c) { S.vim = pl.c.vim; S.cn = pl.c.cn; S.cpos = pl.c.pos; refocus(); renderStatus(); }
    }
  }
  // B8: tabs that do not fit scroll sideways inside their bar, and the bar fades at the edge that has more.
  // The active tab is always scrolled into view; the pane's chevron menu lists every tab.
  function fitTabs() {
    $$('.pane .tabs').forEach(b => {
      const on = $('.tab.on', b); if (on) { const l = on.getBoundingClientRect().left - b.getBoundingClientRect().left + b.scrollLeft, r = l + on.offsetWidth; if (l < b.scrollLeft || on.offsetWidth > b.clientWidth) b.scrollLeft = Math.max(0, l - 4); else if (r > b.scrollLeft + b.clientWidth) b.scrollLeft = r - b.clientWidth + 4; }
      const mark = () => { b.classList.toggle('ovl', b.scrollLeft > 1); b.classList.toggle('ovr', b.scrollLeft + b.clientWidth < b.scrollWidth - 1); };
      mark(); b.onscroll = mark;
      b.onwheel = e => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { b.scrollLeft += e.deltaY; e.preventDefault(); } };
    });
  }
  // G10: below 900 px the sidebar hides itself; opened again there, it floats over the panes
  let sideAuto = false;
  function narrow() {
    const n = innerWidth < 900;
    if (n && S.sideOpen && !sideAuto) { S.sideOpen = false; sideAuto = true; render(); }
    else if (!n && sideAuto) { sideAuto = false; S.sideOpen = true; render(); }
  }
  addEventListener('resize', () => { narrow(); fitTabs(); });
  const grow = t => { t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 180) + 'px'; };
  function refocus() {
    const i = S.pf && pop(S.pf) ? $(`.peek[data-tab="${S.pf}"] [data-input]`) : $(`.pane[data-pane="${focused().id}"] [data-input]`);
    if (!i) {   // a pane whose only keyboard target is a row of buttons (the mirror bar, the handoff card)
      const b = S.pf && pop(S.pf) ? $(`.peek[data-tab="${S.pf}"] .kbrow .primary`) : $(`.pane[data-pane="${focused().id}"] .kbrow .primary`);
      S.vim = 'NORMAL'; S.cn = false; if (b) b.focus(); renderStatus(); return;
    }
    i.focus();
    if (S.cn && window.Vim && i.tagName === 'TEXTAREA') Vim.block(i, S.cpos); else { const n = i.value.length; i.setSelectionRange(n, n); }
  }
  function syncFocus() {  // cheap focus change without rebuilding the DOM under the pointer
    const f = focused(), ft = cur(f);
    $$('.pane').forEach(e => e.classList.toggle('focus', e.dataset.pane === f.id && !S.pf && !S.sf));
    $$('.peek').forEach(e => e.classList.toggle('focus', e.dataset.tab === S.pf));
    $$('#side .row[data-act=open]').forEach(e => e.classList.toggle('foc', ft.kind === 'thread' && e.dataset.sid === ft.sid));
    renderStatus();
  }

  // Timeline ticks: one per message you sent, all the same length; the one you are reading is dark.
  // Hovering lengthens the ticks around the pointer and shows that message with the start of the reply.
  function ticks(th) {
    const us = $$('[data-user]', th);
    if (us.length < 2) return;   // whether there is room for it is decided in CSS, so it follows the pane as it is resized
    const box = el(`<div class="ticks">${us.map(() => '<button><i></i></button>').join('')}</div>`), pop = el('<div class="tick-pop"></div>');
    const bs = $$('button', box);
    let hover = -1, active = -1;
    const updateReading = () => {
      const y = th.scrollTop + th.clientHeight * 0.4;
      let lo = 0, hi = us.length;
      while (lo + 1 < hi) {
        const mid = (lo + hi) >> 1;
        if (us[mid].offsetTop <= y) lo = mid;
        else hi = mid;
      }
      if (lo === active) return;
      bs[active]?.classList.remove('on');
      bs[lo].classList.add('on');
      active = lo;
    };
    const paintHover = () => bs.forEach((button, index) => {
      const distance = index - hover;
      const width = hover < 0 ? 10 : 10 + 12 * Math.exp(-(distance * distance) / 2.2);
      button.firstChild.style.width = width.toFixed(1) + 'px';
    });
    bs.forEach((b, i) => {
      b.addEventListener('mouseenter', () => {
        hover = i; paintHover();
        // the reply is the block after the message; its first prose, or failing that its first step, or that it is still working
        const r = us[i].nextElementSibling, rep = r && r.matches('.reply') ? r : null;
        const first = rep && ($('.prose', rep) || $('.tool, .live, .err-row', rep));
        const said = first ? ($(':scope > summary', first) || first).innerText.replace(/\s+/g, ' ').trim() : rep ? '' : 'Working…';
        pop.innerHTML = `<b>${esc(clip(us[i].textContent.replace(/\s+/g, ' ').trim(), 150))}</b>${said ? `<span>${esc(clip(said, 160))}</span>` : ''}`;
        pop.style.top = Math.max(8, box.offsetTop + b.offsetTop - 12) + 'px'; pop.classList.add('on');
      });
      b.addEventListener('mouseleave', () => { hover = -1; paintHover(); pop.classList.remove('on'); });
      b.addEventListener('click', () => th.scrollTo({ top: us[i].offsetTop - 24, behavior: 'smooth' }));
    });
    th.addEventListener('scroll', updateReading, { passive: true });
    th.parentElement.append(box, pop); paintHover(); updateReading();
  }

  // ---------- menu: one component for every list (palette, : line, slash, @, pickers) ----------
  const Menu = window.Menu = {
    cur: null,
    open(o) {
      Menu.close();
      const trigger = o.anchor?.matches?.('button:has(> .i-down)') ? o.anchor : null;
      if (trigger) trigger.setAttribute('aria-expanded', 'true');
      const e = el(`<div class="menu ${o.cls || ''}">${o.search ? `<div class="m-s">${o.search.prefix ? `<span class="pfx">${o.search.prefix}</span>` : ic('search')}<input spellcheck="false" role="combobox" aria-expanded="true" aria-autocomplete="list" aria-label="${esc(o.search.placeholder || o.search.prefix || 'Search')}" placeholder="${o.search.placeholder || ''}" value="${esc(o.search.value || '')}"><span class="m-q" aria-hidden="true"></span></div>` : ''}<div class="m-l" role="listbox"></div></div>`);
      if (!o.host && o.anchor?.closest?.('.comp, .under.pick')) e.classList.add('composer-menu');
      if (e.classList.contains('composer-menu')) {
        e.addEventListener('pointermove', event => {
          if (event.pointerType === 'touch') return;
          const row = event.target.closest('.mi[data-i]');
          if (!row || Menu.cur?.e !== e || Menu.cur.i === Number(row.dataset.i)) return;
          e.querySelector('.mi.sel')?.classList.remove('sel');
          row.classList.add('sel');
          Menu.cur.i = Number(row.dataset.i);
        });
      }
      let scrim = null;
      if (o.host) o.host.appendChild(e);
      else if (o.modal) { scrim = el('<div class="scrim"></div>'); scrim.appendChild(e); document.body.appendChild(scrim); scrim.addEventListener('mousedown', ev => { if (ev.target === scrim) { Menu.close(); refocusLater(); } }); }
      else {
        document.body.appendChild(e);
        const r = o.anchor.getBoundingClientRect();
        const preferredWidth = o.width === 'anchor' ? r.width : (o.width || 260);
        const w = Math.min(preferredWidth, innerWidth - 16);
        e.style.width = w + 'px';
        if ((o.place || 'top-start').startsWith('top')) e.style.bottom = (innerHeight - r.top + 6) + 'px'; else e.style.top = (r.bottom + 6) + 'px';
        if ((o.place || '').endsWith('end')) e.style.right = Math.max(8, innerWidth - r.right) + 'px'; else e.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + 'px';
      }
      Menu.cur = { o, e, scrim, trigger, i: 0, q: o.q || (o.search && o.search.value) || '', items: [] };
      // a searchable menu opens in INSERT (ready to type) unless it asks for NORMAL; see keys.js
      Menu.cur.ins = !!o.search && !(S.vimOn && o.normal);
      if (o.search) {
        const inp = $('input', e);
        inp.addEventListener('input', () => Menu.filter(inp.value));
        inp.addEventListener('focus', () => { if (Menu.cur && !Menu.cur.ins) Menu.mode(true); });
        $('.m-s', e).addEventListener('mousedown', ev => { if (Menu.cur && !Menu.cur.ins) { ev.preventDefault(); ev.stopPropagation(); Menu.mode(true); } });   // clicking the field starts typing
        if (Menu.cur.ins) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); } else if (document.activeElement) document.activeElement.blur();
      }
      e.classList.toggle('nm', !Menu.cur.ins);
      if (S.tree) renderStatus();
      e.addEventListener('mousedown', ev => { const it = ev.target.closest('.mi'), mk = ev.target.closest('[data-mk]');
        if (mk && it) { ev.preventDefault(); ev.stopPropagation(); Menu.cur.o.keys(mk.dataset.mk, Menu.cur.items[+it.dataset.i]); return; }   // a row's own buttons do what its keys do
        if (it && !it.classList.contains('head') && !it.classList.contains('off')) { ev.preventDefault(); Menu.cur.i = +it.dataset.i; Menu.accept(); } });
      Menu.filter(Menu.cur.q);
      const on = Menu.cur.items.findIndex(it => !it.head && !it.dis && it.on); if (on >= 0) { Menu.cur.i = on; Menu.draw(); }
    },
    filter(q) {
      const c = Menu.cur; c.q = q;
      const all = typeof c.o.items === 'function' ? c.o.items(q) : c.o.items;
      const match = c.o.match || ((it, q) => !q || (it.label + ' ' + (it.hint || '')).toLowerCase().includes(q.toLowerCase()));
      let its = all.filter(it => it.head || match(it, q));
      its = its.filter((it, i) => !it.head || it.html || (its[i + 1] && !its[i + 1].head));
      const keep = c.items[c.i] && its.findIndex(it => !it.head && it.label === c.items[c.i].label);
      c.items = its; c.i = c.o.keep && keep >= 0 ? keep : its.findIndex(it => !it.head && !it.dis);
      Menu.draw();
    },
    draw() {
      const c = Menu.cur, mq = $('.m-q', c.e);
      if (mq) { const v = $('input', c.e).value; mq.innerHTML = v ? esc(v.slice(0, -1)) + `<i class="ncur">${esc(v.slice(-1))}</i>` : `<span class="hc"><i></i></span><span class="ph">${esc(c.o.search.placeholder || '')}</span>`; }   // empty: the same slim block as an empty composer, over the placeholder
      $('.m-l', c.e).innerHTML = c.items.map((it, i) => it.html ? `<div class="mx" role="presentation">${it.html}</div>` : it.head ? `<div class="mi head" role="presentation">${it.icon || ''}${esc(it.label)}</div>`
        : `<div class="mi ${i === c.i ? 'sel' : ''} ${it.dis ? 'off' : ''}" data-i="${i}" role="option" id="mi-${i}" aria-selected="${i === c.i}"${it.dis ? ' aria-disabled="true"' : ''}>${it.icon ? `<span class="mic">${it.icon}</span>` : ''}<span class="ml">${esc(it.display || it.label)}</span>${it.hint ? `<span class="mh">${esc(it.hint)}</span>` : ''}<span class="mr">${it.right || ''}${it.kbd ? `<kbd>${esc(it.kbd)}</kbd>` : ''}${it.on ? ic('check') : ''}</span></div>`).join('');
      if (!c.items.length && c.o.empty) $('.m-l', c.e).innerHTML = `<div class="m-empty" role="status">${esc(c.o.empty)}</div>`;
      c.e.classList.toggle('none', !c.items.length && !c.o.search);
      const s = $('.mi.sel', c.e); if (s) s.scrollIntoView({ block: 'nearest' });
      const inp = c.o.search && $('input', c.e); if (inp) { if (s) inp.setAttribute('aria-activedescendant', s.id); else inp.removeAttribute('aria-activedescendant'); }
    },
    move(d) { const c = Menu.cur; let i = c.i + d; while (c.items[i] && (c.items[i].head || c.items[i].dis)) i += d; if (c.items[i]) { c.i = i; Menu.draw(); } },
    accept(stay) {
      const c = Menu.cur, it = c.items[c.i]; if (!it || it.dis) return;
      const keep = stay || (typeof c.o.keep === 'function' ? c.o.keep(it) : c.o.keep);
      if (!keep) Menu.close();
      c.o.onPick(it, c.q);
      if (keep && Menu.cur === c) Menu.filter(c.q);
      else if (!keep && !Menu.cur && (S.vim === 'INSERT' || S.cn)) refocus();   // back to the composer, unless the pick opened another menu (/model)
    },
    mode(ins) { const c = Menu.cur, inp = $('input', c.e); c.ins = ins; c.e.classList.toggle('nm', !ins); Menu.draw(); if (ins) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); } else inp.blur(); renderStatus(); },
    close() { const c = Menu.cur; if (!c) return; c.trigger?.setAttribute('aria-expanded', 'false'); (c.scrim || c.e).remove(); Menu.cur = null; Fly.close(); if (S.tree) renderStatus(); },
  };
  // Commits flyout: opens beside the scope menu and stays open while you tick boxes.
  // History is a line, so a selection is always one unbroken run of commits (a range in git terms):
  //   nothing ticked, tick one          -> that commit
  //   tick one outside the run          -> the run grows to reach it, taking everything between
  //   untick the newest or the oldest   -> the run shrinks by one from that end
  //   untick one in the middle          -> it and everything older go (the base of the diff moves forward)
  //   untick the last one               -> back to the scope you had before
  //   "All commits"                     -> every commit; ticked again -> clear. A dash means some.
  const Fly = {
    el: null, i: 0, tab: null,
    open(row, t) {
      Fly.close(); if (!row) return;
      row.setAttribute('aria-expanded', 'true');
      Fly.trigger = row;
      const e = el('<div class="menu fly"></div>'), r = row.getBoundingClientRect(), w = 340;
      document.body.appendChild(e);
      e.style.width = w + 'px'; e.style.top = (r.top - 6) + 'px'; e.style.left = (r.right + 8 + w > innerWidth ? r.left - w - 8 : r.right + 8) + 'px';
      // stop here: toggling redraws the list, and a redrawn target would look like a click outside the menus
      e.addEventListener('mousedown', ev => { ev.preventDefault(); ev.stopPropagation(); const m = ev.target.closest('.mi'); if (m) { Fly.i = +m.dataset.i; Fly.toggle(); } });
      Object.assign(Fly, { el: e, tab: t, i: t.range ? t.range[0] + 1 : 0 }); Fly.draw();
    },
    draw() {
      const r = Fly.tab.range, n = D.commits.length, all = r && r[0] === 0 && r[1] === n - 1;
      const box = st => `<span class="cb ${st}">${st === 'on' ? ic('check') : ''}</span>`;
      const range = !r ? '' : `<div class="fly-r">${esc(Tools.scopeLabel({ scope: 'c:range', range: r }))}<span>${r[1] - r[0] + 1} commit${r[1] === r[0] ? '' : 's'}</span></div>`;
      Fly.el.innerHTML = `<div class="m-l"><div class="mi ${Fly.i === 0 ? 'sel' : ''}" data-i="0">${box(all ? 'on' : r ? 'mix' : '')}<span class="ml">All commits</span></div>`
        + D.commits.map(([h, msg, when], j) => `<div class="mi ${Fly.i === j + 1 ? 'sel' : ''}" data-i="${j + 1}">${box(r && j >= r[0] && j <= r[1] ? 'on' : '')}<span class="ml hash">${h}</span><span class="mh">${esc(msg)}</span><span class="mr"><span class="age">${when}</span></span></div>`).join('') + '</div>' + range;
    },
    move(d) { const n = D.commits.length + 1; Fly.i = Math.max(0, Math.min(n - 1, Fly.i + d)); Fly.draw(); },
    toggle() {
      const t = Fly.tab, n = D.commits.length, c = Fly.i - 1; let r = t.range;   // r = [newest index, oldest index]; 0 is the newest commit
      if (Fly.i === 0) r = r && r[0] === 0 && r[1] === n - 1 ? null : [0, n - 1];
      else if (!r) r = [c, c];
      else if (c < r[0] || c > r[1]) r = [Math.min(r[0], c), Math.max(r[1], c)];
      else if (r[0] === r[1]) r = null;
      else if (c === r[0]) r = [c + 1, r[1]];
      else r = [r[0], c - 1];                                                     // the oldest one, or one in the middle
      if (r && t.scope !== 'c:range') t.before = t.scope;                         // remember what to go back to
      t.range = r; t.scope = r ? 'c:range' : (t.before || 'uncommitted');
      render(); if (Menu.cur) Menu.filter(Menu.cur.q); Fly.draw();
    },
    close() { if (Fly.el) { Fly.trigger.setAttribute('aria-expanded', 'false'); Fly.trigger = null; Fly.el.remove(); Fly.el = null; } },
  };
  const refocusLater = () => { if (S.vim === 'INSERT' || S.cn) refocus(); };
  const sw = on => `<span class="sw ${on ? 'on' : ''}"></span>`;

  // ---------- tabs and panes: actions ----------
  function activate(g, t) { g.active = t.id; S.focus = g.id; }
  function addTab(g, t) { g.tabs.push(t); activate(g, t); }
  function openThread(sid, o = {}) { S.sf = false;
    const out = S.pops.find(p => p.t.kind === 'thread' && p.t.sid === sid);   // already floating: just focus it
    if (out) { S.pf = out.t.id; S.cursor = sid; return render(); }
    const hit = shown(sid), s = sess(sid), g = focused(), a = cur(g);
    if (s.status === 'unread') s.status = 'idle';
    s.fresh = false; S.pf = false;
    if (hit) activate(hit.g, hit.t);
    else if (o.split) { const n = P.pane(T.thread(sid)); P.splitAt(g.id, 'row', n); S.focus = n.id; }
    else if (a.kind === 'thread' || a.kind === 'new') { const t = T.thread(sid, a.view); g.tabs[g.tabs.indexOf(a)] = t; g.active = t.id; }   // replace, like a browser tab
    else addTab(g, T.thread(sid));
    S.cursor = sid; render();
  }
  // A split lands in NORMAL (B10): | then \\ splits twice rather than typing a backslash. i or a click starts typing.
  function split(g, dir, tab) { const t = tab || T.fresh(cur(g)), n = P.pane(t); P.splitAt(g.id, dir, n); S.focus = n.id; S.zoom = false; S.cn = false; S.cv = false; S.vim = 'NORMAL'; if (document.activeElement) document.activeElement.blur(); render(); }
  const shellTab = g => { const c = ctxOf(cur(g)); return T.shell(c.machine, c.dir); };
  function closePane(g) {
    if (P.leaves().length === 1) { S.tree = P.pane(T.fresh(cur(g))); S.focus = S.tree.id; }
    else { const path = P.path(g.id), last = path[path.length - 1], sib = last.side === 'a' ? last.s.b : last.s.a; S.tree = P.remove(g.id); S.focus = P.leaves(sib)[0].id; }
    if (P.leaves().length === 1) S.zoom = false;
  }
  function closeTab(g, t) {
    const i = g.tabs.indexOf(t); g.tabs.splice(i, 1);
    if (!g.tabs.length) closePane(g); else if (g.active === t.id) g.active = g.tabs[Math.max(0, i - 1)].id;
    render();
  }
  // tools and docked side chats open next to the thread: in the pane to its right, or a new split
  function openBeside(g, t) { const n = neighbour(g, 'l'); if (n) addTab(n, t); else { const p = P.pane(t); P.splitAt(g.id, 'row', p, false); S.focus = p.id; } render(); }
  function neighbour(g, d) {
    const me = $(`.pane[data-pane="${g.id}"]`); if (!me) return null;
    const a = me.getBoundingClientRect(), cx = a.left + a.width / 2, cy = a.top + a.height / 2;
    let best = null, bd = Infinity;
    for (const e of $$('.pane')) {
      if (e === me) continue;
      const b = e.getBoundingClientRect();
      const ok = d === 'h' ? b.right <= a.left + 2 : d === 'l' ? b.left >= a.right - 2 : d === 'k' ? b.bottom <= a.top + 2 : b.top >= a.bottom - 2;
      if (!ok) continue;
      const dist = 'hl'.includes(d) ? Math.abs(d === 'h' ? a.left - b.right : b.left - a.right) * 4 + Math.abs(Math.max(b.top, Math.min(cy, b.bottom)) - cy)
        : Math.abs(d === 'k' ? a.top - b.bottom : b.top - a.bottom) * 4 + Math.abs(Math.max(b.left, Math.min(cx, b.right)) - cx);
      if (dist < bd) { bd = dist; best = e.dataset.pane; }
    }
    return best && P.get(best);
  }
  // The sidebar is the pane left of the leftmost pane: h from there focuses it, l (or esc, or opening a thread) leaves.
  const navEls = () => $$('#side .s-h[data-k], #side .s-d[data-k], #side .row[data-act=open]').filter(x => !x.closest('[inert]'));
  const navKey = x => (x.matches('.row') ? x.dataset.sid : 'fold:' + x.dataset.k);
  function sideFocus(on) {
    if (on) {
      if (!S.sideOpen) { S.sideOpen = true; render(); }
      Reader.off(); if (document.activeElement) document.activeElement.blur();
      S.sf = true; S.vim = 'NORMAL'; S.cn = false; S.cv = false;
      if (!navEls().some(x => navKey(x) === S.cursor)) { const t = cur(focused()); S.cursor = t.kind === 'thread' ? t.sid : (navEls()[0] && navKey(navEls()[0])); }
    } else S.sf = false;
    syncFocus(); paintNav();
  }
  function paintNav() {
    $$('#side .cur').forEach(x => x.classList.toggle('cur', false));
    $('#side').classList.toggle('focus', !!S.sf);
    const c = navEls().find(x => navKey(x) === S.cursor); if (c && (S.sf || c.matches('.row'))) { c.classList.add('cur'); c.scrollIntoView({ block: 'nearest' }); }
  }
  // keys while the sidebar has focus: j k move, h l fold / unfold (h on a thread goes to its project), enter opens,
  // o / O open (O in a split), x archives, p pins, c starts a thread in the project, esc or l back to the panes
  function sideKey(k, shift) {
    const els = navEls(), i = els.findIndex(x => navKey(x) === S.cursor), el = els[i];
    const go = j => { const n = els[Math.max(0, Math.min(els.length - 1, j))]; if (n) { S.cursor = navKey(n); paintNav(); } };
    const isFold = el && !el.matches('.row'), shut = isFold && S.collapsed[el.dataset.k];
    switch (k) {
      case 'j': case 'ArrowDown': return go(i + 1);
      case 'k': case 'ArrowUp': return go(i - 1);
      case 'g': return go(0);
      case 'G': return go(els.length - 1);
      case 'h': case 'ArrowLeft':
        if (isFold && !shut) { el.click(); return paintNav(); }
        if (el && el.matches('.row')) { const pt = el.closest('.project-threads') || el.closest('.sidebar-group'), pd = pt && pt.previousElementSibling; if (pd && pd.dataset.k) { S.cursor = 'fold:' + pd.dataset.k; paintNav(); } }
        return;
      case 'l': case 'ArrowRight':
        if (isFold && shut) { el.click(); return paintNav(); }
        if (isFold) return go(i + 1);
        return sideFocus(false);
      case 'Enter': case 'o': case 'O':
        if (!el) return;
        if (isFold) { el.click(); return paintNav(); }
        S.sf = false; openThread(el.dataset.sid, { split: shift || k === 'O' }); paintNav(); return;
      case 'x': if (el && el.matches('.row')) { const b = $('[data-act=archive]', el); go(i + 1); act.archive(b); paintNav(); } return;
      case 'm': if (el && el.matches('.row') && !sess(el.dataset.sid).archived) Move.menu(el.dataset.sid, el); return;
      case 'p': if (el && el.matches('.row')) { act.pin($('[data-act=pin]', el) || el); paintNav(); } return;
      case 'c': { const d = el && (el.matches('.s-d') ? el : (el.closest('.project-threads') || {}).previousElementSibling); const b = d && $('[data-act=newIn]', d); if (b) { S.sf = false; act.newIn(b); paintNav(); } return; }
      case 'Escape': return sideFocus(false);
    }
  }
  function focusDir(d) {
    if (S.sf) { if (d === 'l') sideFocus(false); return; }
    const n = neighbour(focused(), d);
    if (!n && d === 'h' && !S.pf) return sideFocus(true);
    if (n) { S.focus = n.id; if (S.vim === 'INSERT' || S.cn) { S.cn = false; S.vim = 'NORMAL'; if (document.activeElement) document.activeElement.blur(); } syncFocus(); } }
  function moveDir(d) { const f = focused(), n = neighbour(f, d); if (n) { P.swap(f, n); render(); } }
  function resize(axis, delta) {
    const hit = [...(P.path(focused().id) || [])].reverse().find(x => x.s.dir === axis); if (!hit) return;
    hit.s.ratio = Math.min(0.85, Math.max(0.15, hit.s.ratio + (hit.side === 'a' ? delta : -delta))); render();
  }
  function setView(t, v) {
    if (t.kind !== 'thread') return;
    t.view = v || (t.view === 'chat' ? 'term' : 'chat'); t.edit = null;
    const s = sess(t.sid);
    if (s.harness === 'claude' && t.view === 'term' && s.drive !== 'term') hand(s, 'term');   // showing the terminal hands it the thread
    else if (s.harness === 'claude' && t.view === 'chat' && s.pend === 'term') s.pend = null;  // went back before it opened: chat keeps it
    render();
    const b = $(`[data-tab="${t.id}"] .handoff .primary`) || $(`[data-tab="${t.id}"] .handoff button`);   // waiting: the card has the keys
    if (b) { if (document.activeElement) document.activeElement.blur(); b.focus(); S.vim = 'NORMAL'; S.cn = false; renderStatus(); }
  }
  // ---- Claude Code: one view drives a thread at a time (G4) ----
  // Chat drives through the Agent SDK. The terminal takes over only between turns: it waits for the turn to end
  // (or for an interrupt), then runs `claude --resume <id>`. While the terminal drives, chat mirrors it read-only;
  // Take back ends the TUI between turns and the SDK resumes the same session. Codex needs none of this: both
  // views attach to one app-server.
  const busy = s => s.status === 'running' || s.events.some(e => e.t === 'approval' || e.t === 'plan');
  function hand(s, to) {
    if (busy(s)) { s.pend = to; if (s.status === 'running' && !s.timer) s.timer = setTimeout(() => finishTurn(s), 5000); return; }
    s.pend = null;
    if (to === 'term') {
      s.drive = 'term'; s.starting = true;
      setTimeout(() => {   // the TUI is up: a terminal on screen in the focused pane takes the keys, as any terminal would
        s.starting = false; const t = cur(focused()), here = t.kind === 'thread' && t.sid === s.id && t.view === 'term' && !S.pf;
        if (here) S.vim = 'INSERT'; render();
      }, 900);
    }
    else { s.drive = 'chat'; toast(`${ic('chat')}<span>Chat has the thread again</span>`); }
  }
  const settle = s => { if (s.pend && !busy(s)) { hand(s, s.pend); render(); } };   // a turn ended: finish a handoff that was waiting for it
  function finishTurn(s) {   // mock: the running turn completes on its own
    s.timer = null; if (s.status !== 'running') return;
    s.events = s.events.filter(e => e.t !== 'live');
    s.events.push({ t: 'text', text: 'Added `sessions/restore.test.ts`. It fails before the fix and passes after it.' }, { t: 'worked', dur: '2m 10s' });
    (s.subs || []).forEach(g => { if (g.status === 'running') { g.status = 'done'; g.events = g.events.filter(e => e.t !== 'live'); } });
    s.status = 'idle'; render(); settle(s);
  }
  function tabStep(d) { const g = focused(), i = g.tabs.indexOf(cur(g)); g.active = g.tabs[(i + d + g.tabs.length) % g.tabs.length].id; render(); }

  // ---------- threads ----------
  const reply = (list, done) => { list.push({ t: 'live', text: 'Thinking', dur: '2s' }); setTimeout(() => { const i = list.findIndex(e => e.t === 'live'); if (i >= 0) list.splice(i, 1, { t: 'text', text: 'This is a mockup, so no agent is attached. In the app the reply streams in here, and the same turn shows in the thread\'s other view.' }); done(); }, 1600); };
  function send(t) {
    if (t.kind === 'shell') return shellRun(t);
    if (t.kind === 'new') return start(t);
    if (t.kind === 'thread' && t.view === 'chat') {
      const draft = (t.edit || t).draft.trimEnd();
      if (['/subagents', '/sidechats', '/side'].includes(draft)) {
        const input = $(`[data-tab="${t.id}"] ${t.edit ? '.m-edit' : '.compw'} textarea[data-input="draft"]`);
        if (input) return openThreadPicker(t, draft, input);
      }
    }
    if (/^\/model\s*$/.test(t.edit ? t.edit.draft : t.draft)) {   // "/model" on its own is ours: open the selector rather than send it
      const chip = () => $(`[data-tab="${t.id}"] ${t.edit ? '.m-edit ' : ''}[data-act=pickModel]`);
      if (chip()) { (t.edit || t).draft = ''; render(); return modelMenu(chip(), t); }
    }
    if (t.edit) return act.editSave(null, t);
    if (t.kind === 'thread' && t.view === 'term' && /^\/(exit|quit)\s*$/.test(t.draft.trim()) && sess(t.sid).harness === 'claude') {   // quitting the TUI gives the thread back to chat
      const s = sess(t.sid); t.draft = ''; s.drive = 'chat'; t.view = 'chat'; render(); return toast(`${ic('claude')}<span>Claude Code exited. Chat has the thread again</span>`);
    }
    const text = t.draft.trim(); if (!text && !t.atts.length) return;
    const msg = { t: 'user', text, images: t.atts.map(a => a.url) };   // quotes stay in the text as items
    t.draft = ''; t.atts = []; t.notes = []; t.caret = null;
    if (t.kind === 'sub') {   // prompting a subagent: it picks the message up and runs again
      const g = subOf(t); g.events = g.events.filter(e => e.t !== 'live'); g.events.push(msg); g.status = 'running'; g.dur = '0s'; render();
      return reply(g.events, () => { g.status = 'done'; g.dur = '2s'; render(); });
    }
    if (t.kind === 'side') { const sc = sideOf(t); sc.events.push(msg); sc.running = true; render(); return reply(sc.events, () => { sc.running = false; render(); }); }
    const s = sess(t.sid);
    s.events = s.events.filter(e => e.t !== 'live');
    const previous = s.events.at(-1);
    if (previous && previous.t !== 'user') previous.age ??= s.age;
    s.events.push(msg);
    if (s.title === 'New thread' && text) s.title = clip(Tok.strip(text), 40);
    s.status = 'running'; s.age = 0; s.fresh = false; render();
    reply(s.events, () => { s.status = 'idle'; render(); settle(s); });
  }
  function newThread(model, machine, dir) {
    const s = { id: 'n' + (++uid), harness: D.harnessOf(model), title: 'New thread', machine, dir, branch: 'main', status: 'idle', age: 0, ctx: 0, events: [], fresh: true, ...defaults(model) };
    D.sessions.unshift(s); return s;
  }
  function start(t) {
    const m = mach(t.machine);
    if (!m.up) return toast(`${ic('host')}<b>${esc(m.name)}</b> is offline`);
    S.lastModel = t.model;
    const s = newThread(t.model, t.machine, t.dir);
    Object.assign(s, { effort: t.effort, ultra: t.ultra, perm: t.perm, branch: t.worktree ? 'skein/' + s.id : 'main' });
    Object.assign(t, { kind: 'thread', sid: s.id, view: S.view }); S.cursor = s.id;
    if (t.draft.trim() || t.atts.length) send(t); else render();
  }
  function shellRun(t) {
    const m = mach(t.machine), cmd = t.draft.trim(), w = cmd.split(/\s+/)[0];
    t.lines.push({ ps: Term.ps1(m, t.dir), text: cmd }); t.draft = '';
    if (w === 'claude' || w === 'codex') {
      // The app notices the harness process in this pty and adopts it as a thread.
      const s = newThread(D.models[w][0].n, t.machine, t.dir);
      Object.assign(t, { kind: 'thread', sid: s.id, view: 'term', scrollback: t.lines }); S.cursor = s.id;
      toast(`${ic(w)}<span><b>${HN[w]}</b> detected in this shell</span>`);
    } else if (w === 'clear') t.lines = [];
    else if (w === 'ls') t.lines.push({ text: 'README.md  bench  migrations  package.json  queue  sessions  ui' });
    else if (w === 'git') t.lines.push({ text: '## main...origin/main\n M sessions/restore.ts' });
    else if (w) t.lines.push({ text: (m.ssh ? 'bash: ' + w + ': command not found' : OS === 'mac' ? 'zsh: command not found: ' + w + '  (mock shell: try  claude  or  codex)' : w + ': The term is not recognized as a cmdlet. (Mock shell: try  claude  or  codex)') });
    render();
  }
  function resolve(t, ok) {
    const s = sess(t.sid), i = s.events.findIndex(e => e.t === 'approval'); if (i < 0) return;
    const a = s.events[i];
    if (a.from) s.events.splice(i, 1, { t: 'tool', name: 'Bash', arg: a.cmd, meta: ok ? a.from : a.from + ' · denied' });   // a subagent's request: its own transcript carries on
    else s.events.splice(i, 1, ...(ok ? [{ t: 'tool', name: 'Bash', arg: a.cmd, out: '✓ built in 3.4s\n✓ wrote shots/composer.png' }, { t: 'image', img: D.img.shot, cap: 'shots/composer.png' }, { t: 'text', text: 'Rebuilt and captured. The label now sits on the same baseline as the text beside it.' }]
      : [{ t: 'text', text: 'Okay, I will not run it. Tell me what to do instead.' }]));
    s.status = s.events.some(e => e.t === 'approval') ? 'wait' : 'idle'; render(); settle(s);
  }
  // A terminal's esc belongs to the program (G1). Running: it interrupts the turn. Idle: esc esc clears the
  // line, or on an empty line opens the harness's rewind list (Claude Code and Codex both do this).
  const isTerm = t => !!t && (t.kind === 'shell' || (t.kind === 'thread' && t.view === 'term'));
  let lastEsc = 0;
  function termEsc(t, inp) {
    const now = Date.now(), twice = now - lastEsc < 600; lastEsc = twice ? 0 : now;
    if (!t || t.kind !== 'thread') return;
    const s = sess(t.sid);
    if (s.status === 'running') {
      s.events = s.events.filter(e => e.t !== 'live'); s.events.push({ t: 'interrupted' }); s.status = 'idle';
      (s.subs || []).forEach(g => { if (g.status === 'running') g.status = 'stopped'; });
      render(); return settle(s);
    }
    if (!twice) return;
    if (t.draft) { t.draft = ''; inp.value = ''; return; }
    const users = s.events.map((e, i) => ({ e, i })).filter(x => x.e.t === 'user');
    if (!users.length) return;
    const host = $('[data-menu-host]', inp.closest('[data-tab]'));
    Menu.open({ host, cls: 'tui', tag: 'tui', items: [{ head: true, label: s.harness === 'claude' ? 'Rewind the conversation to' : 'Edit a previous message' }, ...users.reverse().map(x => ({ label: clip(Tok.strip(x.e.text), 70), ev: x.i }))],
      onPick: it => { s.events = s.events.slice(0, it.ev); t.draft = Tok.strip(users.find(x => x.i === it.ev).e.text); S.vim = 'INSERT'; render(); } });
    Menu.cur.i = 1; Menu.draw(); host.closest('.term').scrollTop = 1e9;
  }
  // Pasting an image (G14).
  //   chat, side chat, subagent, new thread   a structured attachment in the message: nothing is copied anywhere
  //   terminal, local                          saved to ~/.skein/inbox, and the path is pasted into the program
  //   terminal over SSH                        uploaded to the remote's ~/.skein/inbox first, then its path is pasted
  //   shell                                    the same path, as plain text
  // The TUI recognises an image path and shows it as [Image #n].
  let pastes = 0;
  function addAtt(t, url, name, o = {}) {
    if (!t) return;
    const m = mach(ctxOf(t).machine), n = ++pastes, file = `paste-${n}.png`;
    const local = OS === 'mac' ? `/Users/joshua/.skein/inbox/${file}` : `C:\\Users\\joshua\\.skein\\inbox\\${file}`;
    const path = m.ssh ? `/home/${m.addr.split('@')[0]}/.skein/inbox/${file}` : local;
    if (t.kind === 'shell') { t.draft += (t.draft && !/\s$/.test(t.draft) ? ' ' : '') + path + ' '; S.vim = 'INSERT'; return render(); }
    if (!['thread', 'side', 'sub', 'new'].includes(t.kind)) return;
    if (t.kind !== 'thread' || t.view !== 'term') { t.atts.push({ url, name }); S.vim = 'INSERT'; S.cn = false; return render(); }
    if (sess(t.sid).harness === 'claude' && sess(t.sid).drive !== 'term') return;   // the terminal is not open yet
    const typed = () => {   // the path lands in the prompt, then the TUI turns it into an image chip
      t.paste = { state: 'path', path, name: file }; render();
      setTimeout(() => { t.paste = null; t.atts.push({ url, name: file }); render(); }, 650);
    };
    S.vim = 'INSERT'; S.cn = false;
    if (!m.ssh) return typed();
    t.paste = { state: 'up', pct: 0, name: file, host: m.name, url };
    if (o.fail) { t.paste.pct = 40; t.paste.state = 'fail'; S.vim = 'NORMAL'; render(); const b = $(`[data-tab="${t.id}"] .t-over .primary`); if (b) b.focus(); renderStatus(); return; }
    render();
    const tick = () => { if (!t.paste || t.paste.state !== 'up') return; t.paste.pct = Math.min(100, t.paste.pct + 17); render(); if (t.paste.pct < 100) setTimeout(tick, 160); else typed(); };
    setTimeout(tick, 160);
  }
  // float a tab above the panes; it keeps everything it had (drafts, view, scroll of events)
  // where the keyboard is right now: reading at a spot, or in a pane's composer in some mode at some position
  const where = () => {
    const R = window.Reader, a = document.activeElement, r = R && (R.on ? R.mark() : R.last && R.last.tick === R.tick ? R.last : null);
    return r ? { r } : a && a.matches && a.matches('[data-input]') ? { c: { vim: S.vim, cn: S.cn, pos: a.selectionStart } } : null;
  };
  // a click takes focus out of a composer before the click is handled, so note where the keyboard was as the button goes down
  let pre = null;
  document.addEventListener('mousedown', () => { pre = where(); }, true);
  document.addEventListener('keydown', () => { pre = null; }, true);
  function popOut(t) { const p = { t, x: null, y: null, from: S.focus, place: where() || pre }; S.pops.push(p); return p; }   // from: the pane it was opened from
  const homePane = p => { if (p && p.from && $(`.pane[data-pane="${p.from}"]`)) S.focus = p.from; };
  function popClose(id) { const p = pop(id); S.pops = S.pops.filter(p => p.t.id !== id); if (S.pf === id) { S.pf = null; homePane(p); S.restore = p && p.place; }   /* back to where you were before it opened */ if (S.back === id) S.back = null; }
  function sidePeek(sid, scid) {
    const hit = allTabs().find(x => x.t.kind === 'side' && x.t.scid === scid);
    if (hit) { activate(hit.g, hit.t); S.pf = false; }
    else { S.pf = (S.pops.find(p => p.t.kind === 'side' && p.t.scid === scid) || popOut(T.side(sid, scid))).t.id; S.vim = 'INSERT'; S.cn = false; }
    render();
  }
  function openSub(sid, gid) {
    const hit = allTabs().find(x => x.t.kind === 'sub' && x.t.gid === gid);
    if (hit) { activate(hit.g, hit.t); S.pf = null; }
    else S.pf = (S.pops.find(p => p.t.kind === 'sub' && p.t.gid === gid) || popOut(T.sub(sid, gid))).t.id;
    S.vim = 'INSERT'; S.cn = false; S.cv = false; render();   // a subagent opens ready to type to it, like a side chat
  }
  // /subagents: the thread's subagents listed above the composer, running ones first
  function subList(sid, anchor) {
    const gs = sess(sid).subs || [];
    const item = g => ({ label: g.name, icon: ic('agent'), hint: g.task, right: g.status === 'running' ? '<span class="spin"></span>' : `<span class="age">${g.dur}</span>`, g });
    Menu.open({ anchor, place: 'top-start', width: 'anchor', cls: 'composer-menu', search: { placeholder: 'Search subagents' },
      empty: gs.length ? 'No matching subagents' : 'No subagents in this thread',
      items: [{ head: true, label: 'Active' }, ...gs.filter(g => g.status === 'running').map(item), { head: true, label: 'Finished' }, ...gs.filter(g => g.status !== 'running').map(item)],
      onPick: it => openSub(sid, it.g.id) });
  }
  function newSide(sid, at, title) {
    const s = sess(sid), sc = { id: 'c' + (++uid), title: title || 'New side chat', at, events: [] };
    (s.sides = s.sides || []).push(sc); return sc;
  }
  // ---- quoted selections ----
  // A quote lives in the composer's text as one item, wrapped in invisible marks, so it can sit
  // anywhere between what you type. t.notes holds where each one points.
  const TK = '\u2063', TOK = /\u2063[^\u2063]*\u2063/g;
  const tokOf = n => TK + '“' + clip(n.text, 40) + '”' + TK;
  window.Tok = { re: TOK, strip: s => s.replace(/\u2063/g, ''), html: h => h.replace(TOK, m => `<span class="qtok">${m}</span>`) };
  // keep t.notes in step with the items still present in the text, in order
  function syncNotes(t) {
    const pool = [...t.notes];
    t.notes = (t.draft.match(TOK) || []).map(m => { const i = pool.findIndex(n => tokOf(n) === m); return i < 0 ? null : pool.splice(i, 1)[0]; }).filter(Boolean);
  }
  // the layer behind a composer's textarea: draws each quote as a chip, and in VISUAL / V-LINE the
  // cursor (the end of the selection that moves), so you can see which way the selection will grow
  function paintBk(ta) {
    const bk = ta.previousElementSibling; if (!bk || !bk.classList.contains('bk')) return;
    const v = ta.value, part = s => esc(s).replace(TOK, m => `<span class="tok">${m}</span>`);
    const c = S.cv && document.activeElement === ta && S.cpos < v.length && v[S.cpos] !== '\n' ? S.cpos : -1;
    const hol = c < 0 && S.cn && !S.cv && document.activeElement === ta && ta.classList.contains('hollow') ? Math.min(S.cpos, v.length) : -1;
    bk.innerHTML = (hol >= 0 ? part(v.slice(0, hol)) + '<span class="hc"><i></i></span>' + part(v.slice(hol))
      : c < 0 ? part(v) : part(v.slice(0, c)) + `<span class="vcur">${esc(v[c])}</span>` + part(v.slice(c + 1))) + '\u200b';
    bk.scrollTop = ta.scrollTop;
  }
  function chooseSide(sid, anchor, at, title, cb, fromComposer = false) {
    const list = sess(sid).sides || [], fresh = () => cb(newSide(sid, at, title));
    if (!list.length && !fromComposer) return fresh();
    const placement = { anchor, place: fromComposer ? 'top-start' : 'bottom-start', width: fromComposer ? 'anchor' : 290, cls: 'composer-menu' };
    const rename = `<span class="wact"><button data-mk="r" title="Rename side chat">${ic('pencil')}</button></span>`;
    Menu.open({ ...placement, search: { placeholder: 'Search side chats' }, empty: 'No matching side chats',
      items: [{ label: 'New side chat', icon: ic('plus') }, ...list.map(sc => ({ label: sc.title, icon: ic('chat'), sc, right: rename }))],
      keys(key, item) {
        if (key !== 'r' || !item?.sc) return;
        const sc = item.sc;
        Menu.open({ ...placement, search: { prefix: 'Rename', placeholder: 'Side chat name', value: sc.title },
          items: q => [{ label: q.trim() || sc.title, icon: ic('chat') }], match: () => true,
          onPick: it => { sc.title = it.label; store.set('ad2-title:' + sid + ':' + sc.id, it.label); render(); } });
        $('input', Menu.cur.e).select();
      },
      onPick: it => (it.sc ? cb(it.sc) : fresh()) });
  }
  function openThreadPicker(t, command, input, keep) {   // keep: the command came mid-message, so the rest of the draft stays
    const draft = box(t, input), anchor = input.closest('.comp');
    if (!keep) {
      draft.draft = '';
      draft.caret = 0;
      input.value = '';
      grow(input);
      paintBk(input);
    }
    if (command === '/subagents') return subList(t.sid, anchor);
    const at = sess(t.sid).events.map(e => e.t).lastIndexOf('text');
    chooseSide(t.sid, anchor, at, null, sc => {
      openSide(t.sid, sc); S.vim = 'INSERT'; S.cn = false; render();
    }, true);
  }
  function openSide(sid, sc) {   // the tab for a side chat: its docked tab if there is one, else the popup
    const hit = allTabs().find(x => x.t.kind === 'side' && x.t.scid === sc.id);
    if (hit) { activate(hit.g, hit.t); S.pf = false; return hit.t; }
    const p = S.pops.find(x => x.t.kind === 'side' && x.t.scid === sc.id) || popOut(T.side(sid, sc.id));
    S.pf = p.t.id; return p.t;
  }
  // A quoted selection lands in a composer: the thread's (Add to Chat) or a side chat's (Add to Side Chat).
  function addNote(host, note, kind, rect) {
    const sid = host.sid || (allTabs().find(x => x.t.kind === 'thread') || { t: {} }).t.sid;
    if (!sid) return toast('Open a thread first');
    const put = t => {
      if (t.kind === 'thread' && t.view === 'term') { t.draft += `"${note.text}" `; t.caret = t.draft.length; }   // a terminal prompt only takes text
      else {
        const d = t.draft, p = t.caret == null ? d.length : Math.min(t.caret, d.length), pre = d.slice(0, p), lead = pre && !/\s$/.test(pre) ? ' ' : '';
        t.draft = pre + lead + tokOf(note) + ' ' + d.slice(p); t.caret = (pre + lead + tokOf(note) + ' ').length; t.notes.push(note); syncNotes(t);
      }
      S.vim = 'INSERT'; S.cn = false; S.cv = false; render();
      const i = document.activeElement; if (i && i.matches('[data-input=draft]')) i.setSelectionRange(t.caret, t.caret);
    };
    if (kind === 'side') {
      const m = /^ev:[^:]+:(\d+)$/.exec(note.key), s = sess(sid), at = m ? +m[1] : s.events.map(e => e.t).lastIndexOf('text');
      return chooseSide(sid, { getBoundingClientRect: () => rect, contains: () => false }, at, clip(note.text, 28), sc => put(openSide(sid, sc)));
    }
    if (host.kind === 'thread' || host.kind === 'side' || host.kind === 'sub') return put(host);
    const hit = shown(sid); S.pf = false;
    if (hit) { activate(hit.g, hit.t); put(hit.t); } else { const t = T.thread(sid, 'chat'); addTab(focused(), t); put(t); }
  }
  function noteGo(t, n) {   // go to the text a quote points at, opening its source if it is not on screen
    if (Annot.reveal(n)) return;
    const k = n.key.split(':');
    if (k[0] === 'ev') openThread(k[1]); else if (k[0] === 'file') openFile(k.slice(1).join(':'), t.sid); else return;
    setTimeout(() => Annot.reveal(n), 30);
  }
  function dropNote(t, i) {   // remove the i-th quote from a composer's text
    let k = -1; t.draft = t.draft.replace(TOK, m => (++k === i ? '' : m)).replace(/ {2,}/g, ' '); syncNotes(t); render();
  }
  // which quote, if any, is under the pointer in a composer
  function tokUnder(e) {
    const w = e.target.closest && e.target.closest('.taw'); if (!w) return null;
    const i = $$('.bk .tok', w).findIndex(sp => [...sp.getClientRects()].some(r => e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom));
    if (i < 0) return null;
    const t = box(tabAt(w), w), sp = $$('.bk .tok', w)[i], rs = sp.getClientRects();
    return t && t.notes[i] ? { t, i, n: t.notes[i], rect: rs[rs.length - 1] } : null;
  }
  function findNote(id) { for (const t of everyTab()) { const n = t.notes.find(x => x.id === id); if (n) return { t, n }; } }
  function fileNav(t, path, keepHist) {
    if (!path || path === t.path) return;
    t.bufs = t.bufs || {}; if (t.buf != null) t.bufs[t.path] = t.buf;
    if (!keepHist) { const h = t.hist || [t.path], i = t.hi ?? h.length - 1; t.hist = [...h.slice(0, i + 1), path]; t.hi = t.hist.length - 1; }
    t.path = path; t.buf = t.bufs[path] ?? null; t.mode = 'preview'; render();
  }
  function fileStep(t, d) { const h = t.hist || [t.path], i = (t.hi ?? h.length - 1) + d; if (i < 0 || i >= h.length) return false; t.hi = i; fileNav(t, h[i], true); return true; }
  function openFile(path, sid, g) {
    const hit = allTabs().find(x => x.t.kind === 'file' && x.t.path === path);
    if (hit) { activate(hit.g, hit.t); render(); } else openBeside(g || focused(), T.file(path, sid));
  }

  // ---------- inputs: draft sync, slash menu, @ files ----------
  // what a composer writes into: the tab, or the tab's edit-in-place box (a composer with its own draft)
  const box = (t, node) => (t.edit && node && node.closest && node.closest('.m-edit') ? t.edit : t);
  function draftChanged(t, inp) {
    if (inp.dataset.input === 'tq') {   // the changed-files search: filter the tree, keep typing
      t.tq = inp.value; const c = inp.selectionStart; render();
      const n = $(`[data-tab="${t.id}"] [data-input=tq]`); if (n) { n.focus(); n.setSelectionRange(c, c); } return;
    }
    if (inp.dataset.input === 'vimrc') { S.vimrc = inp.value; store.set('ad2-vimrc', S.vimrc); readVimrc(); return; }
    if (inp.dataset.input === 'file') {   // a file being edited: keep its text with the tab, and the gutter and the unsaved marks in step
      t.buf = inp.value; const n = inp.value.split('\n').length, d = Tools.dirty(t), body = inp.closest('.body') || inp.closest('.peek');
      inp.rows = n; inp.previousElementSibling.textContent = Array.from({ length: n }, (x, i) => i + 1).join('\n');
      if (body) $('.tool-h', body).classList.toggle('dirty', d); $$(`.tab[data-id="${t.id}"]`).forEach(x => x.classList.toggle('dirty', d));
      return;
    }
    const b = box(t, inp);
    b.draft = inp.value; b.caret = inp.selectionStart;
    if (inp.tagName === 'TEXTAREA') { grow(inp); syncNotes(b); paintBk(inp); }
    if (t.kind === 'shell') return;
    const hn = t.kind === 'new' ? D.harnessOf(t.model) : sess(t.sid).harness;
    // a chat composer takes a / command anywhere a word starts (the token at the caret); a terminal prompt only at the start,
    // because the TUI owns its own line
    const pre = b.draft.slice(0, inp.selectionStart ?? b.draft.length);
    const host0 = $('[data-menu-host]', inp.closest('[data-tab]'));
    const sl = host0 ? /^\/(\S*)$/.exec(b.draft) : /(?:^|\s)(\/\S*)$/.exec(pre), at = /(?:^|\s)@(\S*)$/.exec(b.draft);
    if (sl && !host0) sl[0] = sl[1];
    const mid = !!(sl && !host0 && pre.length - sl[0].length > 0);   // the command is not the whole message so far
    // put the picked command where the token was, keep the rest of the message, and leave the caret after it
    // (read again at pick time: the menu stays open while the token grows)
    const put = (inp, text) => { const v = inp.value, c0 = inp.selectionStart ?? v.length, p0 = v.slice(0, c0), tok = /\/\S*$/.exec(p0)[0];
      const head = p0.slice(0, p0.length - tok.length), tail = v.slice(c0); b.draft = head + text + ((head + text).endsWith(' ') || !(head + text) ? tail.replace(/^ /, '') : tail); inp.value = b.draft; const c = (head + text).length; inp.focus(); inp.setSelectionRange(c, c); b.caret = c; if (inp.tagName === 'TEXTAREA') { grow(inp); paintBk(inp); } };
    const host = host0;
    const common = { host, cls: host ? 'tui' : 'composer-menu', anchor: inp.closest('.comp') || inp, place: 'top-start', width: 'anchor' };
    if (sl) {
      // a chat composer lists the harness's commands, the app's own /side, and the harness's skills;
      // a terminal prompt shows only what the TUI itself offers
      const icons = { clear: 'compose', new: 'plus', compact: 'layers', model: 'agent', plan: 'tree', resume: 'clock',
        review: 'check', init: 'file', mcp: 'clip', permissions: 'shield', approvals: 'shield', status: 'host',
        diff: 'diff', mention: 'clip', sidechats: 'chat', subagents: 'agent' };
      const cmd = ([label, hint]) => {
        if (host) return { label, hint };
        const name = label.slice(1);
        const display = ({ mcp: 'MCP', sidechats: 'Side chats' })[name] || (name[0].toUpperCase() + name.slice(1)).replaceAll('-', ' ');
        return { label, hint, display, icon: ic(icons[name] || 'bolt') };
      };
      const items = host ? D.slash[hn].map(cmd) : [...D.slash[hn].map(cmd), ...(t.kind === 'thread' ? [cmd(['/sidechats', 'Open or start a side chat']), cmd(['/subagents', "List this thread's subagents"])] : []),
        { head: true, label: 'Skills' }, ...D.skills[hn].map(cmd)];
      if (Menu.cur && Menu.cur.o.tag === 'slash') Menu.filter(sl[0]);
      else if (mid && !items.some(it => !it.head && it.label.startsWith(sl[0]))) {}   // a path like /usr/bin mid-sentence: no menu
      else Menu.open({ ...common, tag: 'slash', q: sl[0], items, match: (it, q) => it.label.startsWith(q),
        onPick: it => {
          // app commands act at once; mid-message they take only their own word out and keep the rest of the draft
          if (!host && mid && (it.label === '/subagents' || it.label === '/sidechats' || it.label === '/model')) {
            put(inp, '');
            if (it.label === '/model') return modelMenu($('[data-act=pickModel]', inp.closest('.comp')), t);
            return openThreadPicker(t, it.label, inp, true);
          }
          if (!host && (it.label === '/subagents' || it.label === '/sidechats')) return openThreadPicker(t, it.label, inp);
          if (it.label === '/model' && !host) { b.draft = ''; inp.value = ''; paintBk(inp); return modelMenu($('[data-act=pickModel]', inp.closest('.comp')), t); }
          if (!host) return put(inp, it.label + ' ');
          b.draft = it.label + ' '; inp.value = b.draft; inp.focus();
        } });
    } else if (at) {
      if (Menu.cur && Menu.cur.o.tag === 'at') Menu.filter(at[1]);
      else Menu.open({ ...common, tag: 'at', q: at[1], items: D.files.map(f => ({ label: f, icon: ic('file') })),
        onPick: it => { b.draft = b.draft.replace(/@\S*$/, '@' + it.label + ' '); inp.value = b.draft; inp.focus(); } });
    } else if (Menu.cur && (Menu.cur.o.tag === 'slash' || Menu.cur.o.tag === 'at')) Menu.close();
    if (mid && Menu.cur && Menu.cur.o.tag === 'slash' && !Menu.cur.items.some(it => !it.head)) Menu.close();
    if (host) host.closest('.term').scrollTop = 1e9;
  }

  // ---------- overlays ----------
  function toast(html, ms = 3200) { $$('.toast').forEach(t => t.remove()); const t = el(`<div class="toast">${html}</div>`); document.body.appendChild(t); if (ms) setTimeout(() => t.remove(), ms); }
  const stIcon = s => threadStatus(s) || `<span class="age">${age(s.age)}</span>`;
  const tool = k => () => { const g = focused(), c = ctxOf(cur(g)); openBeside(g, T.tool(k, c.sid)); };
  const ACTIONS = [
    ['New thread', 'compose', 'ldr c', () => act.tabNew(null, focused())], ['Split right', 'splitR', 'ldr v', () => split(focused(), 'row')], ['Split down', 'splitD', 'ldr s', () => split(focused(), 'col')],
    ['Shell to the right', 'terminal', 'ldr %', () => split(focused(), 'row', shellTab(focused()))], ['Show thread as chat / terminal', 'chat', 'ldr t', () => setView(cur(focused()))],
    ['Open changes beside', 'diff', '', tool('changes')], ['Open files beside', 'file', '', tool('files')], ['Open browser beside', 'globe', '', tool('browser')],
    ['Zoom pane', 'zoom', 'ldr z', () => act.zoom()], ['Close tab', 'x', 'ldr q', () => closeTab(focused(), cur(focused()))],
    ['Workspaces', 'layers', 'ctrl-tab', () => WS.menu()], ['Machines', 'host', '', () => act.machines()], ['Settings', 'sliders', '', () => Sett.open()], ['Keyboard shortcuts', 'keyboard', '?', () => keysSheet()],
  ];
  // ---------- folders ----------
  // Wherever a folder is chosen (a workspace, a new thread's directory) the field works the same way:
  //   nothing typed   a few recent folders, and the machine itself to browse
  //   some text       filters every folder the app knows (ones with threads, ones used before)
  //   a path          ~/... or /... lists that folder as you type; tab (l in NORMAL) goes into the folder under
  //                   the cursor, h goes back up, enter chooses it
  // So there is no "add folder" step: walk or type to any folder, and once used it is known from then on.
  // A machine with no known folders needs nothing special either; it is there to browse like any other.
  const Dirs = {
    kids: (m, parent) => [...new Set([...(FS[m] || []), ...(D.dirs[m] || [])].filter(p => p.startsWith(parent) && p.length > parent.length).map(p => p.slice(parent.length).split('/')[0]))].sort(),
    exists: (m, d) => [...(FS[m] || []), ...(D.dirs[m] || [])].some(p => p === d || p.startsWith(d + '/')),
    // { m, pre, parent, leaf } when the text is a path; with hosts, "machine:~/..." names another machine
    parse(q, m0, hosts) {
      const x = /^(?:(.+?):)?\s*(~|~\/.*|\/.*)$/.exec(q.trim()); if (!x || (x[1] && !hosts)) return null;
      const m = x[1] ? D.machines.find(m => [m.id, m.name].some(n => n.toLowerCase() === x[1].trim().toLowerCase())) : m0; if (!m) return null;
      const p = x[2] === '~' ? '~/' : x[2], parent = p.slice(0, p.lastIndexOf('/') + 1);
      return { m, pre: x[1] ? x[1] + ':' : '', parent, leaf: p.slice(parent.length) };
    },
    rows(p) {
      if (!p.m.up) return [{ head: true, label: p.m.name }, { label: 'Not connected', icon: ic('host'), hint: 'open Machines to reconnect', right: '<i class="wdot down"></i>', run: () => act.machines() }];
      const cur = p.parent.slice(0, -1), here = p.parent.length > 2 && !p.leaf && Dirs.exists(p.m.id, cur) ? [{ label: base(cur), icon: ic('folder'), hint: 'this folder', dir: { m: p.m, dir: cur } }] : [];
      const sub = Dirs.kids(p.m.id, p.parent).filter(k => k.toLowerCase().startsWith(p.leaf.toLowerCase())).map(k => ({ label: k, icon: ic('folder'), hint: p.parent + k, right: Dirs.kids(p.m.id, p.parent + k + '/').length ? ic('chev') : '', dir: { m: p.m, dir: p.parent + k }, into: p.pre + p.parent + k + '/' }));
      return [{ head: true, label: p.m.name + ' · ' + p.parent }, ...here, ...sub, ...(here.length + sub.length ? [] : [{ label: 'No folder here', none: true }])];
    },
    up: p => (p.parent.length > 2 ? p.pre + p.parent.slice(0, p.parent.lastIndexOf('/', p.parent.length - 2) + 1) : ''),   // from the top, back to the list
    set(v) { const inp = $('input', Menu.cur.e); inp.value = v; Menu.filter(v); },
    browse(v) { Dirs.set(v); if (Menu.cur && !Menu.cur.ins) Menu.mode(true); },   // starting to browse a machine: straight into typing the path
    use(m, d) { const l = D.dirs[m] || (D.dirs[m] = []); if (!l.includes(d)) l.unshift(d); },   // a folder you have used is known from then on
    menu: { match: () => true, keep: it => !!it.none || (!!it.into && !it.dir), tab(it) { if (it && it.into) (it.dir ? Dirs.set : Dirs.browse)(it.into); } },
  };

  // ---------- workspaces ----------
  // A workspace is a whole layout (panes, tabs, popups) with a default machine and folder: tmux's session.
  // Threads are not owned by one; a workspace only holds views onto them, and a hidden one keeps running.
  let wsN = 0;
  // mock only: what is on each machine's disk beyond the folders the app already knows
  const FS = { local: ['~/projects/skein/src', '~/projects/skein/mockups', '~/projects/site', '~/projects/sandbox', '~/Documents', '~/Downloads'],
    linux: ['~/repo/trade-ticker/bench', '~/repo/trade-ticker/migrations', '~/repo/orders-api', '~/repo/infra', '~/data/ticks', '~/data/fills'], build: [] };
  const WS = {
    cur: () => S.ws.find(w => w.id === S.wid),
    mk: (name, machine, dir, tree) => ({ id: 'w' + (++uid), name, machine, dir, tree, focus: null, zoom: false, pops: [], pf: null, at: ++wsN }),
    recent: () => [...S.ws].sort((a, b) => b.at - a.at),
    tree: w => (w.id === S.wid ? S.tree : w.tree),
    tabs: w => [...P.leaves(WS.tree(w)).flatMap(g => g.tabs), ...(w.id === S.wid ? S.pops : w.pops).map(p => p.t)],
    waiting: w => WS.tabs(w).some(t => t.kind === 'thread' && sess(t.sid).events.some(e => e.t === 'approval')),   // a thread in it wants an answer
    // its layout, drawn small: the picture you recognise it by
    mini(w) { const d = n => (n.type === 'pane' ? '<i></i>' : `<span class="${n.dir === 'row' ? 'r' : 'c'}">${[n.a, n.b].map((x, i) => `<span style="flex:${(i ? 1 - n.ratio : n.ratio).toFixed(2)}">${d(x)}</span>`).join('')}</span>`); return `<span class="wmini">${d(WS.tree(w))}</span>`; },
    row: w => ({ label: w.name, icon: WS.mini(w), hint: mach(w.machine).name + ' · ' + w.dir, right: WS.waiting(w) ? '<i class="wdot" title="A thread here is waiting for you"></i>' : '', on: w.id === S.wid, w }),
    go(id) {
      const w = S.ws.find(x => x.id === id); if (!w) return;
      if (id !== S.wid) {
        const c = WS.cur(); if (c) Object.assign(c, { tree: S.tree, focus: S.focus, zoom: S.zoom, pops: S.pops, pf: S.pf });
        S.wid = id; Object.assign(S, { tree: w.tree, focus: w.focus, zoom: w.zoom, pops: w.pops, pf: w.pf, back: null });
        if (!P.get(S.focus)) S.focus = P.leaves()[0].id;
      }
      w.at = ++wsN; Object.assign(S, { vim: 'NORMAL', cn: false, cv: false, cursor: null }); if (document.activeElement) document.activeElement.blur(); render();
    },
    make(name, machine, dir) { const w = WS.mk(name, machine, dir, P.pane(T.mk('new', { machine, dir, worktree: false, ...defaults(S.lastModel) }))); S.ws.push(w); return w; },
    close(id) { if (S.ws.length < 2) return; if (id === S.wid) WS.go(WS.recent().find(w => w.id !== id).id); S.ws = S.ws.filter(w => w.id !== id); },
    // ctrl-tab: most recent first. The first press lands on the one you were in last; holding ctrl and pressing
    // tab again walks further back; letting go of ctrl switches. A quick tap flips between the last two.
    cycle(d) {
      const c = Menu.cur;
      if (c && c.o.tag === 'wsw') { const n = c.items.length; c.i = (c.i + d + n) % n; return Menu.draw(); }
      if (S.ws.length < 2) return;
      Menu.open({ modal: true, cls: 'pal ws wsw', tag: 'wsw', items: WS.recent().map(WS.row), onPick: it => WS.go(it.w.id) });
      Menu.cur.i = d > 0 ? 1 : Menu.cur.items.length - 1; Menu.draw();
    },
    // The one place to find, make and manage them: type to filter, or to name a new one; r renames, d closes.
    // The one place to find, make and manage them. Folders work as everywhere (see Dirs); here a path may also
    // start with a machine, "linux:~/repo/", and r / d rename and close the workspace under the cursor.
    menu(q0) {
      const acts = `<span class="wact"><button data-mk="r" title="Rename · r">${ic('pencil')}</button><button data-mk="d" title="Close workspace · d">${ic('x')}</button></span>`;
      const path = q => Dirs.parse(q, mach(WS.cur().machine), true);
      const mrow = m => ({ label: m.name, icon: ic(m.ssh ? 'host' : 'laptop'), hint: m.up ? '~/' : 'not connected', right: m.ssh ? `<i class="wdot ${m.up ? 'up' : 'down'}"></i>` : '', into: m.name + ':~/' });
      const items = q => {
        const name = q.trim(), lq = name.toLowerCase(), p = path(q), hit = (...t) => !lq || t.join(' ').toLowerCase().includes(lq);
        if (p) return Dirs.rows(p);
        const known = D.machines.flatMap(m => (D.dirs[m.id] || []).map(dir => ({ m, dir }))).filter(x => !S.ws.some(w => w.machine === x.m.id && w.dir === x.dir) && hit(x.dir, x.m.name));
        const have = S.ws.some(w => w.name.toLowerCase() === lq);
        return [{ head: true, label: 'Workspaces' }, ...WS.recent().filter(w => hit(w.name, w.dir, mach(w.machine).name)).map(w => { const r = WS.row(w); return { ...r, right: r.right + (S.ws.length > 1 ? acts : '') }; }),
          { head: true, label: name ? 'Folders' : 'Recent folders' }, ...known.slice(0, name ? 8 : 4).map(x => ({ label: base(x.dir), icon: ic('folder'), hint: x.m.name + ' · ' + x.dir, dir: x })),
          { head: true, label: 'Browse' }, ...D.machines.filter(m => hit(m.name)).map(mrow), ...(name ? [] : [{ label: 'Add a machine', icon: ic('plus'), run: () => act.machines() }]),
          ...(name && !have ? [{ head: true, label: 'New' }, { label: `New workspace "${name}"`, icon: ic('plus'), hint: 'in ' + ctxOf(curTab()).dir, make: name }] : [])];
      };
      Menu.open({ anchor: $('#status .wsb'), place: 'top-start', width: 420, cls: 'ws dirs', tag: 'ws', search: { placeholder: 'Workspace, folder or path', value: q0 || '' }, items, ...Dirs.menu,
        keys(k, it) {
          const p = path(Menu.cur.q);
          if (k === 'h' && p) return Dirs.set(Dirs.up(p));
          if (!it || !it.w) return;
          if (k === 'r') WS.rename(it.w);
          else if (k === 'd') { WS.close(it.w.id); renderStatus(); if (Menu.cur) Menu.filter(Menu.cur.q); }
        },
        onPick(it) {
          if (it.none) return; if (it.run) return it.run(); if (it.w) return WS.go(it.w.id);
          if (it.dir) { const w = S.ws.find(w => w.machine === it.dir.m.id && w.dir === it.dir.dir) || WS.make(base(it.dir.dir), it.dir.m.id, it.dir.dir); return WS.go(w.id); }   // already a workspace: go to it
          if (it.into) return Dirs.browse(it.into);
          const c = ctxOf(curTab()); WS.go(WS.make(it.make, c.machine, c.dir).id);
        } });
    },
    rename(w) {
      Menu.open({ anchor: $('#status .wsb'), place: 'top-start', width: 400, cls: 'ws', search: { prefix: 'Rename', value: w.name },
        items: q => [{ label: q.trim() || w.name, icon: WS.mini(w), hint: mach(w.machine).name + ' · ' + w.dir }], match: () => true,
        onPick: (it, q) => { w.name = q.trim() || w.name; renderStatus(); WS.menu(); } });
    },
  };

  function palette() {
    Menu.open({ modal: true, cls: 'pal', search: { placeholder: 'Search threads and actions' },
      items: () => [{ head: true, label: 'Threads' }, ...D.sessions.map(s => ({ label: s.title, icon: ic(s.harness, 'hm'), hint: mach(s.machine).name + ' · ' + base(s.dir), right: stIcon(s), sid: s.id })),
        { head: true, label: 'Actions' }, ...ACTIONS.map(([label, i, , run]) => ({ label, icon: ic(i), run }))],
      onPick: it => { if (it.sid) openThread(it.sid); else it.run(); } });
  }
  function fileSearch() {
    const c = ctxOf(curTab()), m = mach(c.machine);
    Menu.open({ modal: true, cls: 'pal', search: { placeholder: `Search files in ${m.ssh ? m.name + ':' : ''}${c.dir}` },
      items: D.files.map(p => ({ label: base(p), icon: ic('file'), hint: p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '', path: p })),
      match: (it, q) => !q || it.path.toLowerCase().includes(q.toLowerCase()),
      onPick: it => openFile(it.path, c.sid) });
  }
  const allView = v => { allTabs().forEach(x => { if (x.t.kind === 'thread') x.t.view = v; }); S.view = v; render(); };
  const CMDS = [
    ['vsplit', 'Split right', () => split(focused(), 'row')], ['split', 'Split down', () => split(focused(), 'col')], ['tabnew', 'New tab', () => act.tabNew(null, focused())],
    ['new', 'New thread  [machine] [dir]', a => { const t = T.fresh(cur(focused())), m = D.machines.find(m => m.id === a[0] || m.name === a[0]); if (m) { t.machine = m.id; t.dir = a[1] || D.dirs[m.id][0]; } split(focused(), 'row', t); }],
    ['shell', 'Shell below', () => split(focused(), 'col', shellTab(focused()))], ['vshell', 'Shell to the right', () => split(focused(), 'row', shellTab(focused()))],
    ['changes', 'Changes, beside this thread', tool('changes')], ['files', 'Files, beside this thread', tool('files')], ['browser', 'Browser, beside this thread', tool('browser')],
    ['q', 'Close tab', () => closeTab(focused(), cur(focused()))], ['only', 'Close all other panes', () => { S.tree = focused(); S.zoom = false; render(); }], ['zoom', 'Zoom pane', () => act.zoom()],
    ['chat', 'Show this thread as chat', () => setView(cur(focused()), 'chat')], ['term', 'Show this thread as its terminal', () => setView(cur(focused()), 'term')],
    ['chatall', 'Every thread as chat', () => allView('chat')], ['termall', 'Every thread as its terminal', () => allView('term')],
    ['recent', 'Sidebar: most recent', () => { S.sideView = 'recent'; render(); }], ['grouped', 'Sidebar: by machine and folder', () => { S.sideView = 'grouped'; render(); }],
    ['tabnext', 'Next tab', () => tabStep(1)], ['tabprev', 'Previous tab', () => tabStep(-1)], ['view', 'Thread as chat or terminal', () => setView(cur(focused()))],
    ['workspace', 'Workspaces: switch, or create  [name]', a => { if (!a.length) return WS.menu(); const n = a.join(' '), c = ctxOf(curTab()); WS.go((S.ws.find(x => x.name === n) || WS.make(n, c.machine, c.dir)).id); }],
    ['w', 'Save this file', () => act.fileSave(null, curTab())],
    ['theme', 'Toggle theme', () => act.theme()], ['novim', 'Turn Vim keys off', () => act.vimToggle()],
  ];
  function cmdline(v = '') {
    const first = q => q.trim().split(/\s+/)[0] || '';
    Menu.open({ cls: 'cmd', anchor: $('#status'), place: 'top-start', width: 420, search: { prefix: ':', value: v },
      items: CMDS.map(([label, hint, run]) => ({ label, hint, run })), match: (it, q) => it.label.startsWith(first(q)),
      onPick: (it, q) => { it.run(q.trim().split(/\s+/).slice(1)); refocusLater(); } });
  }
  // ---------- keyboard popup ----------
  // One short list. Rows whose action is a command can be rebound: press enter (or click the key),
  // then the new key, optionally after the leader. The binding is saved as an nnoremap line in the
  // vimrc, so the popup and the file always agree. Fixed keys (motions, ctrl-k ...) are shown dimmed.
  const KEYS = [
    ['Find', [{ label: 'Search threads and actions', def: kb('mod-k') }, { label: 'Search files in the project', def: kb('mod-p') }, { label: 'Search this pane and its thread', def: kb('mod-shift-a') }, { label: 'Command line', def: ':' }]],
    ['Panes', [{ label: 'Split right', cmd: 'vsplit', def: '|' }, { label: 'Split down', cmd: 'split', def: '\\' }, { label: 'Shell to the right', cmd: 'vshell', def: 'ldr %' },
      { label: 'Shell below', cmd: 'shell', def: 'ldr "' }, { label: 'Zoom pane', cmd: 'zoom', def: 'ldr z' }, { label: 'Focus a pane', def: kb('alt-h') + ' j k l' }]],
    ['Tabs', [{ label: 'New tab', cmd: 'tabnew', def: 'ldr c' }, { label: 'Close tab', cmd: 'q', def: 'ldr q' }, { label: 'Next tab', cmd: 'tabnext', def: 'L' },
      { label: 'Previous tab', cmd: 'tabprev', def: 'H' }, { label: 'Chat or terminal', cmd: 'view', def: 'ldr t' }]],
    ['Workspaces', [{ label: 'Switch workspace, most recent first', def: kb('ctrl-tab') }, { label: 'Search, create and manage', cmd: 'workspace', def: 'ldr w' }]],
    ['Threads', [{ label: 'Move in the sidebar', def: 'j k' }, { label: 'Open thread', def: 'enter' }, { label: 'Allow or deny a request', def: 'y n' },
      { label: 'Add selection to chat', def: kb('mod-l') }, { label: 'Add selection to a side chat', def: kb('mod-shift-s') }]],
    ['Terminal', [{ label: 'Read the scrollback', def: 'ldr [' }, { label: 'Back to the program', def: 'i' }]],
    ['Editing', [{ label: 'Undo', def: 'u' }, { label: 'Redo', def: kb('ctrl-r') }]],
    ['Changes and files', [{ label: 'Search the file tree', def: '/' }, { label: 'Stage the file under the cursor', def: 's' }, { label: 'Revert it (with Undo)', def: 'x' },
      { label: 'Show folded lines', def: 'enter' }, { label: 'Back, forward in an open file', def: kb('ctrl-o') + ' ' + kb('ctrl-i') }]],
  ];
  const mapsTo = cmd => l => new RegExp('^\\s*nnoremap\\s+\\S+\\s+:' + cmd + '<CR>', 'i').test(l);
  const bound = cmd => { const n = Object.keys(S.nmap).find(k => S.nmap[k] === cmd), l = Object.keys(S.lmap).find(k => S.lmap[k] === cmd); return l ? 'ldr ' + l : n || null; };
  const saveRc = lines => { S.vimrc = lines.join('\n'); store.set('ad2-vimrc', S.vimrc); readVimrc(); if (allTabs().some(x => x.t.kind === 'vimrc')) render(); };
  const Keys = {
    el: null, i: 0, cap: null, lead: false,
    rows: () => KEYS.flatMap(([, rs]) => rs),
    open() { closeSheet(); Object.assign(Keys, { cap: null, lead: false }); Keys.el = el('<div class="scrim sheet"><div class="keys2"></div></div>'); Keys.el.addEventListener('mousedown', e => { if (e.target === Keys.el) Keys.close(); }); document.body.appendChild(Keys.el); Keys.draw(); },
    close() { if (Keys.el) { Keys.el.remove(); Keys.el = null; } },
    draw() {
      if (!Keys.el || !Keys.el.isConnected) return;
      let n = -1;
      const chips = s => s.split(' ').map(x => `<kbd>${esc(x)}</kbd>`).join('');
      Keys.el.firstChild.innerHTML = `<header><h3>Keyboard</h3><span class="sp"></span><button class="btn sm" data-act="keyRc" title="Bindings live in the vimrc">${ic('sliders')}vimrc</button><button class="ib sm" data-act="keyClose" title="Close">${ic('x')}</button></header>
        <div class="k-list">${KEYS.map(([g, rs]) => `<h4>${g}</h4>` + rs.map(r => { n++; const set = r.cmd && bound(r.cmd), cap = Keys.cap === r;
          return `<div class="k-row ${S.vimOn && n === Keys.i ? 'cur' : ''} ${r.cmd ? 'can' : ''}" ${r.cmd ? `data-act="keyEdit" data-i="${n}"` : ''}><span class="kl">${esc(r.label)}</span>
            ${set && !cap ? `<button class="k-x" data-act="keyReset" data-i="${n}" title="Back to ${esc(r.def)}">${ic('retry')}</button>` : ''}
            <span class="kk ${cap ? 'cap' : ''} ${set ? 'set' : ''}">${cap ? (Keys.lead ? chips('ldr') : '') + '<i>press a key</i>' : chips(set || r.def)}</span></div>`; }).join('')).join('')}</div>`;
      const c = Keys.el.querySelector('.k-row.cur'); if (c) c.scrollIntoView({ block: 'nearest' });
    },
    edit(i) { const r = Keys.rows()[i]; Keys.i = i; if (!r || !r.cmd) return Keys.draw(); Keys.cap = r; Keys.lead = false; Keys.draw(); },
    reset(i) { const r = Keys.rows()[i]; Keys.i = i; if (r && r.cmd) saveRc(S.vimrc.split('\n').filter(l => !mapsTo(r.cmd)(l))); Keys.draw(); },
    bind(r, key, lead) {   // write the binding to the vimrc, replacing any line for this action or this key
      const lhs = (lead ? '<leader>' : '') + key, taken = l => { const m = /^\s*nnoremap\s+(\S+)\s/i.exec(l); return !!m && m[1] === lhs; };
      const lines = S.vimrc.replace(/\n+$/, '').split('\n').filter(l => !mapsTo(r.cmd)(l) && !taken(l));
      lines.push('nnoremap ' + lhs + ' :' + r.cmd + '<CR>', ''); saveRc(lines);
    },
    key(k, e) {
      if (Keys.cap) {   // waiting for the new key
        if (k === 'Escape') { Keys.cap = null; return Keys.draw(); }
        if (e.ctrlKey && e.code === (S.leaderKey === 'ctrl-\\' ? 'Backslash' : 'Space')) { Keys.lead = true; return Keys.draw(); }
        if (k.length !== 1 || e.ctrlKey || e.altKey || k === ' ') return;
        Keys.bind(Keys.cap, k, Keys.lead); Keys.cap = null; return Keys.draw();
      }
      const n = Keys.rows().length;
      if (k === 'Escape' || k === 'q' || k === '?') return Keys.close();
      if (k === 'j' || k === 'ArrowDown') { Keys.i = Math.min(n - 1, Keys.i + 1); return Keys.draw(); }
      if (k === 'k' || k === 'ArrowUp') { Keys.i = Math.max(0, Keys.i - 1); return Keys.draw(); }
      if (k === 'Enter') return Keys.edit(Keys.i);
      if (k === 'x' || k === 'Backspace') return Keys.reset(Keys.i);
    },
  };
  const keysSheet = () => Keys.open();
  const closeSheet = () => $$('.sheet, .lightbox').forEach(e => e.remove());

  // ---------- settings dialog ----------
  // Sections on the left, one row per setting on the right. Keys: j k rows, h l change a value,
  // H L (or tab) change section, enter activates, esc closes.
  const Sett = {
    sec: 0, row: 0,
    sections() {
      const save = (k, key) => v => { S[k] = v; store.set(key, v); };
      return [
        ['General', 'sliders', [
          { label: 'New threads open as', desc: 'Any thread can be switched from its tab', seg: [['chat', 'Chat'], ['term', 'Terminal']], get: () => S.view, set: save('view', 'ad2-view') },
          { label: 'Sidebar', desc: 'How threads are listed', seg: [['grouped', 'By folder'], ['recent', 'Recent']], get: () => S.sideView, set: save('sideView', 'ad2-side') },
          { label: 'On launch', desc: 'Workspaces, layouts, popups, drafts and reading positions', seg: [['restore', 'Restore'], ['empty', 'Start empty']], get: () => S.launch || 'restore', set: v => { S.launch = v; } },
        ]],
        ['Appearance', 'sun', [
          { label: 'Theme', seg: [['dark', 'Dark'], ['light', 'Light']], get: () => S.theme, set: save('theme', 'ad2-theme') },
        ]],
        ['Vim', 'keyboard', [
          { label: 'Vim keys', desc: 'Modal editing in composers, menus and read-only text', sw: () => S.vimOn, run: () => act.vimToggle() },
          { label: 'vimrc', desc: '~/.config/skein/vimrc', btn: 'Edit', run: () => { Sett.close(); const hit = allTabs().find(x => x.t.kind === 'vimrc'); if (hit) activate(hit.g, hit.t); else addTab(focused(), T.vimrc()); S.vim = 'NORMAL'; render(); } },
          { label: 'Leader', desc: OS === 'mac' ? 'macOS may take ⌃Space for input sources' : 'Pane and tab commands, also inside terminals', seg: [['ctrl-space', kb('ctrl-space')], ['ctrl-\\', kb('ctrl-\\')]], get: () => S.leaderKey, set: save('leaderKey', 'ad2-leader') },
        ]],
        ['Notifications', 'bell', [
          { label: 'Notify me', desc: 'When Skein is in the background or the thread is out of sight', seg: [['waiting', 'Waiting on me'], ['all', 'Every reply'], ['off', 'Never']], get: () => S.notify, set: save('notify', 'ad2-notify') },
          { label: 'A thread counts as read', desc: 'once its tab has been on screen and focused' },
        ]],
        ['Machines', 'host', [
          ...D.machines.map(m => ({ label: m.name, desc: m.ssh ? m.addr : m.os, html: ['claude', 'codex'].map(hn => `<span class="has ${m.has.includes(hn) ? '' : 'no'}" title="${HN[hn]} ${m.has.includes(hn) ? 'installed' : 'not found'}">${ic(hn)}</span>`).join('') + (mdot(m) || '<span class="dot" style="visibility:hidden"></span>') })),
          { label: 'Add SSH host', desc: 'from ~/.ssh/config', btn: 'Add', run: () => toast('Mock: this would list hosts from ~/.ssh/config') },
        ]],
      ];
    },
    open() { closeSheet(); Sett.el = el('<div class="scrim sheet"><div class="settings"></div></div>'); Sett.el.addEventListener('mousedown', e => { if (e.target === Sett.el) Sett.close(); }); document.body.appendChild(Sett.el); Sett.draw(); },
    close() { if (Sett.el) { Sett.el.remove(); Sett.el = null; } },
    draw() {
      if (!Sett.el || !Sett.el.isConnected) return;
      const secs = Sett.sections(), rows = secs[Sett.sec][2];
      Sett.row = Math.max(0, Math.min(Sett.row, rows.length - 1));
      const ctl = (r, i) => r.seg ? `<div class="seg txt">${r.seg.map(([v, n]) => `<button class="${r.get() === v ? 'on' : ''}" data-act="setOpt" data-i="${i}" data-v="${v}">${n}</button>`).join('')}</div>`
        : r.sw ? `<button class="swb" data-act="setRow" data-i="${i}">${sw(r.sw())}</button>`
        : r.btn ? `<button class="btn sm" data-act="setRow" data-i="${i}">${r.btn}</button>`
        : r.kbd ? `<kbd>${r.kbd}</kbd>` : `<span class="s-meta">${r.html || ''}</span>`;
      Sett.el.firstChild.setAttribute('role', 'dialog'); Sett.el.firstChild.setAttribute('aria-modal', 'true'); Sett.el.firstChild.setAttribute('aria-label', 'Settings');
      Sett.el.firstChild.innerHTML = `<nav class="settings-nav"><h4>Settings</h4>${secs.map(([n, i], k) => `<button class="${k === Sett.sec ? 'on' : ''}" data-act="setSec" data-i="${k}">${ic(i)}<span>${n}</span></button>`).join('')}</nav>
        <section class="s-body"><header><h3>${secs[Sett.sec][0]}</h3><button class="ib sm" data-act="setClose" title="Close">${ic('x')}</button></header>
        ${rows.map((r, i) => `<div class="s-row ${S.vimOn && i === Sett.row ? 'cur' : ''}"><div class="s-txt"><b>${esc(r.label)}</b>${r.desc ? `<span>${esc(r.desc)}</span>` : ''}</div>${ctl(r, i)}</div>`).join('')}</section>`;
    },
    step(r, d) { const i = r.seg.findIndex(x => x[0] === r.get()); r.set(r.seg[(i + d + r.seg.length) % r.seg.length][0]); render(); Sett.draw(); },
    run(i) { const r = Sett.sections()[Sett.sec][2][i]; if (!r) return; Sett.row = i; if (r.seg) return Sett.step(r, 1); if (r.run) { r.run(); render(); Sett.draw(); } else Sett.draw(); },
    key(k, e) {
      const secs = Sett.sections(), rows = secs[Sett.sec][2], r = rows[Sett.row], n = secs.length;
      const sec = d => { Sett.sec = (Sett.sec + d + n) % n; Sett.row = 0; Sett.draw(); };
      if (k === 'Escape' || k === 'q') return Sett.close();
      if (k === 'j' || k === 'ArrowDown') { Sett.row = Math.min(rows.length - 1, Sett.row + 1); return Sett.draw(); }
      if (k === 'k' || k === 'ArrowUp') { Sett.row = Math.max(0, Sett.row - 1); return Sett.draw(); }
      if (k === 'L' || (k === 'Tab' && !e.shiftKey)) return sec(1);
      if (k === 'H' || k === 'Tab') return sec(-1);
      if ((k === 'l' || k === 'ArrowRight' || k === 'h' || k === 'ArrowLeft') && r && r.seg) return Sett.step(r, k === 'l' || k === 'ArrowRight' ? 1 : -1);
      if (k === 'Enter' || k === ' ') return Sett.run(Sett.row);
    },
  };

  // ---------- SSH sign-in (G5) ----------
  // ssh asks for something before a link comes up: a key passphrase, trust for a new host key, or a code.
  // One small dialog for all three. Its field opens in INSERT; esc gives NORMAL on the buttons, esc again cancels.
  const Auth = {
    el: null,
    open(m, kind, done) {
      closeSheet(); Auth.m = m; Auth.kind = kind; Auth.done = done;
      const K = {
        passphrase: ['Unlock your key for ' + m.name, 'Passphrase for ~/.ssh/id_ed25519', 'password', 'Connect'],
        code: ['Verify it’s you on ' + m.name, 'Verification code from your authenticator', 'text', 'Connect'],
        hostkey: ['First connection to ' + m.name, '', '', 'Trust and connect'],
      }[kind];
      Auth.el = el(`<div class="scrim sheet"><div class="auth" role="dialog" aria-modal="true" aria-labelledby="auth-h">
        <header>${ic(kind === 'hostkey' ? 'shield' : 'lock')}<h3 id="auth-h">${esc(K[0])}</h3></header>
        ${kind === 'hostkey' ? `<p class="dim">${esc(m.addr)} isn’t in known_hosts yet. Check the fingerprint with whoever runs it.</p><code class="fp">ED25519 SHA256:9vVq3b+Kd2h0Lr7XcP1mN8tYw4sQe6uJ5aZ0fG2iH1o</code>`
          : `<label class="dim" for="auth-i">${esc(K[1])}</label><input id="auth-i" class="auth-i" type="${K[2]}" autocomplete="off" spellcheck="false">`}
        <div class="af kbrow"><button class="btn" data-act="authCancel" data-esc>Cancel</button><button class="btn primary" data-act="authOk">${K[3]}</button></div></div></div>`);
      Auth.el.addEventListener('mousedown', e => { if (e.target === Auth.el) Auth.close(); });
      document.body.appendChild(Auth.el);
      const i = $('.auth-i', Auth.el); if (i) { i.focus(); S.vim = 'INSERT'; } else { $('.auth .primary', Auth.el).focus(); S.vim = 'NORMAL'; }
      m.link = 'auth'; renderStatus();
    },
    close() { if (Auth.el) { Auth.el.remove(); Auth.el = null; S.vim = 'NORMAL'; render(); } },
    ok() {
      const m = Auth.m, done = Auth.done; Auth.el.remove(); Auth.el = null; m.link = 'connecting'; S.vim = 'NORMAL'; render();
      setTimeout(() => { m.link = 'up'; m.up = true; render(); toast(`${ic('host')}<span>Connected to <b>${esc(m.name)}</b></span>`); if (done) done(); }, 1100);
    },
    // keys while it is open: the field is a Field, the buttons a row
    key(e) {
      const k = e.key, inp = $('.auth-i', Auth.el), ae = document.activeElement;
      if (ae === inp) {
        if (k === 'Enter') { e.preventDefault(); return Auth.ok(); }
        if (k === 'Escape') { e.preventDefault(); if (S.vimOn) { $('.auth .primary', Auth.el).focus(); S.vim = 'NORMAL'; renderStatus(); } else Auth.close(); }
        return;
      }
      e.preventDefault();
      const bs = $$('.auth .af button', Auth.el), i = bs.indexOf(ae);
      if (k === 'h' || k === 'ArrowLeft') bs[Math.max(0, i - 1)].focus();
      else if (k === 'l' || k === 'ArrowRight') bs[Math.min(bs.length - 1, i + 1)].focus();
      else if ((k === 'i' || k === 'a' || k === 'k') && inp) { inp.focus(); S.vim = 'INSERT'; renderStatus(); }
      else if (k === 'Enter' || k === ' ') (ae && ae.matches('button') ? ae : bs[bs.length - 1]).click();
      else if (k === 'Escape' || k === 'q') Auth.close();
    },
  };

  // Moving a thread to another folder or machine (drag it onto a project or a machine, or m in the sidebar).
  // The harness's own session moves with it: Claude Code's JSONL under ~/.claude/projects/<folder>/, Codex's rollout
  // under ~/.codex/sessions/, copied over the SSH link and pointed at the new folder; Skein's record (machine, folder,
  // side chats, tabs) follows. Uncommitted changes can come along as a patch when the target is the same repo.
  // The original is kept in Archived until the thread has resumed at its new home. (Feasibility: tech spike thread.)
  const repoOf = d => d.replace(/\/$/, '').split('/').pop();
  const Move = {
    el: null,
    open(sid, mid, dir) {
      closeSheet(); if (Menu.cur) Menu.close(); const s = sess(sid), m = mach(mid), from = mach(s.machine);
      if (s.machine === mid && s.dir === dir) return;
      const same = repoOf(s.dir) === repoOf(dir), files = Tools.allFiles({}, s).length, run = s.status === 'running' || s.status === 'wait';
      const block = !m.has.includes(s.harness) ? `${D.harnessOf ? (s.harness === 'claude' ? 'Claude Code' : 'Codex') : s.harness} isn’t installed on ${m.name}.`
        : !m.up || linkOf(m) !== 'up' ? `${m.name} isn’t connected.` : '';
      Object.assign(Move, { sid, mid, dir, code: same && files > 0 ? 1 : 0, same, files, run, block });
      Move.el = el(`<div class="scrim sheet"><div class="auth mv" role="dialog" aria-modal="true" aria-labelledby="mv-h"></div></div>`);
      Move.el.addEventListener('mousedown', e => { if (e.target === Move.el) Move.close(); });
      document.body.appendChild(Move.el); Move.draw();
    },
    draw(step) {
      const s = sess(Move.sid), m = mach(Move.mid), from = mach(s.machine), box = $('.mv', Move.el);
      const where = (mm, d) => `<span class="mv-at">${ic(mm.ssh ? 'host' : 'laptop')}<b>${esc(mm.name)}</b><span>${esc(d)}</span></span>`;
      if (step != null) {   // moving: the steps tick off one by one
        const steps = Move.steps;
        box.innerHTML = `<header>${ic(s.harness)}<h3 id="mv-h">Moving “${esc(s.title)}”</h3></header>
          <ol class="mv-steps">${steps.map((x, i) => `<li class="${i < step ? 'done' : i === step ? 'now' : ''}">${i < step ? ic('check') : i === step ? '<span class="spin"></span>' : '<i></i>'}<span>${esc(x)}</span></li>`).join('')}</ol>`;
        return;
      }
      const notes = [
        Move.block && `<p class="mv-note bad">${ic('alert')}<span>${esc(Move.block)}</span></p>`,
        !Move.block && Move.run && `<p class="mv-note">${ic('clock')}<span>It moves when the current turn ends.</span></p>`,
        !Move.same && `<p class="mv-note">${ic('alert')}<span>${esc(Move.dir)} isn’t the same repository, so only the conversation moves. Its file changes stay in ${esc(s.dir)}.</span></p>`,
      ].filter(Boolean).join('');
      box.innerHTML = `<header>${ic(s.harness)}<h3 id="mv-h">Move “${esc(s.title)}”</h3></header>
        <div class="mv-route"><span>From</span>${where(from, s.dir)}<span>To</span>${where(m, Move.dir)}</div>
        ${notes}
        ${Move.code === 2 ? `<p class="mv-note">${ic('alert')}<span>Pushes branch skein/${esc(s.id)} to origin, which publishes it.</span></p>` : ''}
        <p class="dim">The conversation and its side chats move. The original is archived once the thread resumes there.</p>
        <div class="af kbrow">${Move.same && Move.files && !Move.block ? `<button class="btn mv-carry" data-act="moveCarry" title="Change what happens to the code">${ic('branch')}<span>${['Conversation only', `Bring ${Move.files} changed files`, 'Push a branch'][Move.code]}</span>${ic('down', 'sm')}</button>` : ''}<span class="sp"></span>
          <button class="btn" data-act="moveCancel" data-esc>Cancel</button><button class="btn primary" data-act="moveGo" ${Move.block ? 'disabled' : ''}>Move</button></div>`;
      const b = $('.mv .primary:not([disabled])', Move.el) || $('.mv [data-esc]', Move.el); b.focus(); S.vim = 'NORMAL'; renderStatus();
    },
    go() {
      const s = sess(Move.sid), m = mach(Move.mid), cross = s.machine !== Move.mid, h = s.harness === 'claude' ? 'Claude Code' : 'Codex';
      Move.steps = [Move.run && 'Wait for the turn to end', cross && `Check ${h} on ${m.name}`, cross && `Copy the ${h} session to ${m.name}`,
        Move.code === 1 && (cross ? `Send ${Move.files} changed files and local commits` : `Apply ${Move.files} changed files`), Move.code === 2 && 'Push the branch and check it out',
        'Move side chats and tabs', `Resume in ${Move.dir}`, 'Archive the original'].filter(Boolean);
      let i = 0; Move.draw(0);
      const tick = () => { i++; if (!Move.el) return; if (i < Move.steps.length) { Move.draw(i); setTimeout(tick, 520); } else Move.done(); };
      setTimeout(tick, 520);
    },
    done() {
      const s = sess(Move.sid), m = mach(Move.mid), old = { machine: s.machine, dir: s.dir };
      D.sessions.push({ ...JSON.parse(JSON.stringify(s)), id: s.id + '-was', archived: true, pinned: false, status: 'idle', title: s.title + ' (before move)' });
      Object.assign(s, { machine: Move.mid, dir: Move.dir, fresh: true }); if (s.status === 'running' || s.status === 'wait') s.status = 'idle';
      Dirs.use(Move.mid, Move.dir); S.collapsed['h:' + Move.mid] = false; S.collapsed[Move.mid + Move.dir] = false; S.cursor = s.id;
      Move.close(); render(); setTimeout(() => { s.fresh = false; }, 3000);
      toast(`${ic('check')}<span>Moved to <b>${esc(m.name)}</b> ${esc(Move.dir)}</span><button class="btn sm" data-act="moveUndo" data-sid="${s.id}" data-m="${esc(old.machine)}" data-d="${esc(old.dir)}">Undo</button>`, 7000);
    },
    close() { if (Move.el) { Move.el.remove(); Move.el = null; S.vim = 'NORMAL'; renderStatus(); } },
    key(e) {   // a row of buttons (rule 16): h / l along, enter presses, esc cancels
      const k = e.key, ae = document.activeElement, bs = $$('.mv .af button:not([disabled])', Move.el), i = bs.indexOf(ae);
      e.preventDefault(); if (!bs.length) return;
      if (k === 'h' || k === 'ArrowLeft') bs[Math.max(0, i - 1)].focus();
      else if (k === 'l' || k === 'ArrowRight') bs[Math.min(bs.length - 1, i + 1)].focus();
      else if (k === 'Enter' || k === ' ') (i >= 0 ? ae : bs[bs.length - 1]).click();
      else if (k === 'Escape' || k === 'q') Move.close();
    },
    // where a thread can go: every project on every machine, and any other folder (the same picker as a new thread's)
    menu(sid, anchor) {
      const s = sess(sid), proj = m => [...new Set([...D.sessions.filter(x => x.machine === m.id && !x.archived).map(x => x.dir), ...(S.projects[m.id] || [])])];
      Menu.open({ anchor, place: 'bottom-start', width: 300, search: { placeholder: 'Move to a project or folder' },
        items: () => D.machines.flatMap(m => [{ head: true, label: m.name },
          ...proj(m).filter(d => !(m.id === s.machine && d === s.dir)).map(d => ({ label: projectName(m.id, d), icon: ic('folder'), hint: d, m: m.id, d })),
          { label: 'Other folder…', icon: ic('folderOpen'), m: m.id, other: true }]),
        onPick: it => { Menu.close(); if (it.other) return Move.pickDir(sid, it.m, anchor); Move.open(sid, it.m, it.d); } });
    },
    pickDir(sid, mid, anchor) {
      const m = mach(mid), path = q => Dirs.parse(q, m, false);
      Menu.open({ anchor, place: 'bottom-start', width: 320, cls: 'dirs', search: { placeholder: 'Folder or path on ' + m.name }, ...Dirs.menu,
        items: q => { const p = path(q), lq = q.trim().toLowerCase(); if (p) return Dirs.rows(p); if (!m.up) return Dirs.rows({ m });
          return [{ head: true, label: 'Folders' }, ...(D.dirs[m.id] || []).filter(d => d.toLowerCase().includes(lq)).map(d => ({ label: d, icon: ic('folder'), dir: { m, dir: d } })), { head: true, label: 'Browse' }, { label: m.name, icon: ic(m.ssh ? 'host' : 'laptop'), hint: '~/', into: '~/' }]; },
        keys(k) { const p = path(Menu.cur.q); if (k === 'h' && p) Dirs.set(Dirs.up(p)); },
        onPick: it => { if (it.none) return; if (it.dir) { Menu.close(); Move.open(sid, mid, it.dir.dir); } else if (it.into) Dirs.browse(it.into); } });
    },
  };

  function lightbox(src) { closeSheet(); const l = el(`<div class="scrim lightbox"><img src="${src}" alt=""></div>`); l.addEventListener('click', closeSheet); document.body.appendChild(l); }

  // model + effort: one menu. New thread: every model, grouped by harness. Existing thread: its harness only.
  function modelMenu(anchor, t) {
    const m = t.kind === 'new' ? t : sess(t.sid), groups = t.kind === 'new' ? ['claude', 'codex'] : [D.harnessOf(m.model)];
    const stops = () => D.modelDef(m.model).e;
    const setEffort = i => { m.effort = stops()[Math.max(0, Math.min(stops().length - 1, i))]; render(); if (Menu.cur) Menu.filter(Menu.cur.q); };
    Menu.open({ anchor, place: 'top-end', width: 300, keep: it => it.k !== 'model', tag: 'model', cls: 'model', search: { placeholder: 'Search models' },   // opens in INSERT, ready to type; esc for NORMAL (j k pick, h l effort)
      effort: d => setEffort(stops().indexOf(m.effort) + d), effortTo: setEffort,
      match: (it, q) => it.k === 'ultra' || it.k === 'install' || !q || it.label.toLowerCase().includes(q.toLowerCase()),
      items: () => {
        const def = D.modelDef(m.model), e = def.e, i = Math.max(0, e.indexOf(m.effort)), pct = j => (e.length > 1 ? j / (e.length - 1) * 100 : 0);
        // effort: a stepped track. Click or drag it, or use ← → while the menu is open.
        const track = `<div class="eff"><div class="eh"><span>Effort</span><b>${e[i]}</b></div>
          <div class="trk" data-n="${e.length}"><i class="fill" style="width:${pct(i)}%"></i>${e.map((x, j) => `<i class="stp ${j <= i ? 'on' : ''}" style="left:${pct(j)}%"></i>`).join('')}<i class="thumb" style="left:${pct(i)}%"></i></div>
          <div class="et">${e.map((x, j) => `<span class="${j === i ? 'on' : ''}" style="left:${pct(j)}%" data-j="${j}">${x}</span>`).join('')}</div></div>`;
        // each row carries its harness mark; harnesses are set apart by a small gap, not a heading or a rule
        const mc = mach(t.kind === 'new' ? t.machine : m.machine), has = hn => mc.has.includes(hn);
        return [...groups.flatMap((hn, gi) => [...(gi ? [{ head: true, html: '<i class="mgap"></i>' }] : []), ...D.models[hn].map(x => ({ label: x.n, icon: ic(hn), on: m.model === x.n, k: 'model', dis: !has(hn), hint: has(hn) ? '' : 'not on ' + mc.name })),
          ...(has(hn) ? [] : [{ label: `Install ${HN[hn]} on ${mc.name}`, icon: ic('copy'), k: 'install', hn, hint: 'copies the command' }])]),
          { head: true, html: track },
          ...(def.ultra ? [{ label: 'Ultracode', right: sw(m.ultra), k: 'ultra' }] : [])];
      },
      onPick: it => {
        if (it.k === 'install') return toast(`${ic('copy')}<span>Copied <b>${it.hn === 'claude' ? 'npm i -g @anthropic-ai/claude-code' : 'npm i -g @openai/codex'}</b></span>`);
        if (it.k === 'ultra') m.ultra = !m.ultra;
        else { m.model = it.label; const d = D.modelDef(m.model); if (!d.e.includes(m.effort)) m.effort = d.e[d.e.length - 1]; if (!d.ultra) m.ultra = false; if (t.kind === 'new') m.perm = D.perms[D.harnessOf(m.model)][0]; }
        render();
      } });
  }

  // ---------- click actions ----------  (el, tab, event); tab is the one the click happened in
  const paneOf = t => { const x = t && findTab(t.id); return (x && x.g) || focused(); };
  const act = {
    contextUsage(button) {
      const panel = $('#context-usage'), s = sess(button.dataset.sid);
      panel.innerHTML = `<div class="cu-h">Context<span>${s.ctx}%</span></div>
        <div class="cu-bar" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${s.ctx}" aria-label="Context used" style="--p:${s.ctx}"><i></i></div>
        <div class="cu-f">${100 - s.ctx}% left · ${esc(s.model)}</div>`;
      panel.showPopover({ source: button });
      const r = button.getBoundingClientRect();
      panel.style.left = Math.max(8, Math.min(innerWidth - panel.offsetWidth - 8, r.right - panel.offsetWidth)) + 'px';
      panel.style.top = Math.max(8, r.top - panel.offsetHeight - 6) + 'px';
    },
    open: (e, t, ev) => openThread(e.dataset.sid, { split: ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey }),
    machineLink: e => { const m = mach(e.dataset.m); if (m.link === 'auth') Auth.open(m, m.authKind || 'passphrase'); },
    toggleArchive: e => { S.archiveOpen = !S.archiveOpen; redrawDisclosure(e); },
    archive: e => {
      const s = sess(e.closest('.row').dataset.sid);
      s.archived = !s.archived;
      renderSide();
    },
    pin: e => { const s = sess(e.closest('.row').dataset.sid); s.pinned = !s.pinned; render(); },
    fold: (e, t, event) => {
      const shut = S.collapsed[e.dataset.k] = !S.collapsed[e.dataset.k];
      e.nextElementSibling.inert = shut;
      updateSidebarOrder();
      if (e.matches('.s-h')) { e.classList.toggle('shut', shut); return; }
      e.querySelector('.project-folder').outerHTML = ic(shut ? 'folder' : 'folderOpen', 'project-folder');
      if (event.detail === 2) editSidebarName(e);
    },
    moveCarry() { Move.code = (Move.code + 1) % 3; Move.draw(); $('.mv .mv-carry', Move.el)?.focus(); },
    moveCancel() { Move.close(); },
    moveGo() { if (!Move.block) Move.go(); },
    moveUndo(e) { const s = sess(e.dataset.sid); Object.assign(s, { machine: e.dataset.m, dir: e.dataset.d }); D.sessions = D.sessions.filter(x => x.id !== s.id + '-was'); e.closest('.toast')?.remove(); render(); },
    // a machine's +: a folder that has no threads yet becomes a project in the sidebar
    addProject(e) {
      const m = mach(e.dataset.m), path = q => Dirs.parse(q, m, false), known = d => D.sessions.some(s => s.machine === m.id && s.dir === d) || (S.projects[m.id] || []).includes(d);
      Menu.open({ anchor: e, place: 'bottom-start', width: 320, cls: 'dirs', search: { placeholder: 'Folder or path on ' + m.name }, ...Dirs.menu,
        items: q => {
          const p = path(q), lq = q.trim().toLowerCase(); if (p) return Dirs.rows(p);
          if (!m.up) return Dirs.rows({ m });
          return [{ head: true, label: 'Folders' }, ...(D.dirs[m.id] || []).filter(d => !known(d) && d.toLowerCase().includes(lq)).slice(0, 8).map(d => ({ label: d, icon: ic('folder'), dir: { m, dir: d } })),
            { head: true, label: 'Browse' }, { label: m.name, icon: ic(m.ssh ? 'host' : 'laptop'), hint: '~/', into: '~/' }];
        },
        keys(k) { const p = path(Menu.cur.q); if (k === 'h' && p) Dirs.set(Dirs.up(p)); },
        onPick: it => {
          if (it.none) return; if (it.run) return it.run();
          if (it.dir) { const d = it.dir.dir; Menu.close(); if (!known(d)) (S.projects[m.id] = S.projects[m.id] || []).push(d); Dirs.use(m.id, d); S.collapsed['h:' + m.id] = false; render(); toast(`${ic('folder')}<span>Added ${esc(projectName(m.id, d))}</span>`); }
          else if (it.into) Dirs.browse(it.into);
        } });
    },
    newIn: e => { S.sf = false; const t = T.fresh(); t.machine = e.dataset.m; t.dir = e.dataset.d; addTab(focused(), t); S.vim = 'INSERT'; render(); },
    newThread: () => act.tabNew(null, focused()),
    toggleSide: () => { S.sideOpen = !S.sideOpen; render(); },
    palette, keys: keysSheet,
    view: () => { S.sideView = S.sideView === 'grouped' ? 'recent' : 'grouped'; store.set('ad2-side', S.sideView); render(); },
    theme: () => { S.theme = S.theme === 'dark' ? 'light' : 'dark'; store.set('ad2-theme', S.theme); render(); },
    vimToggle: () => { S.vimOn = !S.vimOn; S.cn = false; store.set('ad2-vim', S.vimOn ? 'on' : 'off'); render(); },
    // tabs
    tab: (e, t, ev, g) => { g.active = e.dataset.id; S.vim = 'NORMAL'; S.cn = false; render(); },
    // a tab's x: close it, or with alt/option held, pop it out as a floating popup
    tabClose(e, t, ev, g) {
      const tab = g.tabs.find(x => x.id === e.dataset.id);
      if (!(ev && ev.altKey)) return closeTab(g, tab);
      const i = g.tabs.indexOf(tab); g.tabs.splice(i, 1);
      if (!g.tabs.length) closePane(g); else if (g.active === tab.id) g.active = g.tabs[Math.max(0, i - 1)].id;
      S.pf = popOut(tab).t.id; render();
    },
    tabNew: (e, t, ev, g) => { g = g || focused(); const a = cur(g); if (a.kind === 'new') S.focus = g.id; else addTab(g, T.fresh(a)); S.vim = 'INSERT'; S.cn = false; render(); },
    setView: (e, t) => setView(t, e.dataset.v),
    // The tab dropdown is about the thread you are in: its side chats and its tools first,
    // then every open tab, then what you can do to this pane.
    tabSearch(e, t, ev, g) {
      const sid = ctxOf(cur(g)).sid, s = sid && sess(sid);
      const open = (find, make) => () => { const hit = allTabs().find(x => find(x.t)); if (hit) activate(hit.g, hit.t); else addTab(g, make()); render(); };
      // Everything that belongs to the thread in this pane's active tab, within this workspace: its side chats and
      // subagents, then its tabs wherever they are open (another thread's tabs are a ctrl-k away, not listed here).
      const ofThread = x => { const c = ctxOf(x.t); return c.sid === sid || (x.t.kind === 'shell' && s && c.machine === s.machine && c.dir === s.dir); };
      const tabs = s ? allTabs().filter(ofThread) : allTabs();
      const has = k => tabs.some(x => x.t.kind === k);
      const mine = !s ? [] : [{ head: true, label: s.title },
        ...(s.sides || []).map(c => ({ label: c.title, icon: ic('chat'), hint: 'side chat', run: open(x => x.kind === 'side' && x.scid === c.id, () => T.side(sid, c.id)) })),
        ...(s.subs || []).map(g => ({ label: g.name, icon: ic('agent'), hint: 'subagent', right: g.status === 'running' ? '<span class="spin"></span>' : '', run: () => openSub(sid, g.id) }))];
      const tabRows = tabs.map(x => { const m = tabMeta(x.t); return { label: m.title, icon: m.badge || ic(m.icon), right: m.st, on: x.g === g && x.t === cur(g), tab: x }; });
      const more = !s ? [] : [...[['changes', 'diff', 'Changes'], ['files', 'folder', 'Files'], ['browser', 'globe', 'Browser']].filter(([k]) => !has(k)).map(([k, i, label]) => ({ label, icon: ic(i), run: open(() => false, () => T.tool(k, sid)) })),
        { label: 'Shell', icon: ic('terminal'), hint: s.dir, run: () => { addTab(g, T.shell(s.machine, s.dir)); S.vim = 'INSERT'; render(); } }];
      const pane = [['Split right', 'splitR', 'ldr v', () => split(g, 'row')], ['Split down', 'splitD', 'ldr s', () => split(g, 'col')], ['Shell to the right', 'terminal', 'ldr %', () => split(g, 'row', shellTab(g))],
        [S.zoom ? 'Unzoom' : 'Zoom pane', 'zoom', 'ldr z', () => act.zoom(null, null, null, g)], ['Close pane', 'x', '', () => { closePane(g); render(); }]];
      Menu.open({ anchor: e, place: 'bottom-end', width: 320, search: { placeholder: s ? 'Search this thread' : 'Search tabs' },
        items: () => [...mine, { head: true, label: 'Tabs' }, ...tabRows, ...more,
          { head: true, label: 'Pane' }, ...pane.map(([label, i, , run]) => ({ label, icon: ic(i), run }))],
        onPick: it => { if (it.run) it.run(); else if (it.tab) { activate(it.tab.g, it.tab.t); render(); } } });
    },
    openKind(e, t, ev, g) {
      const k = e.dataset.v, c = ctxOf(t), i = g.tabs.indexOf(t);
      const n = k === 'shell' ? T.shell(t.machine, t.dir) : T.tool(k, c.sid || (D.sessions.find(s => s.machine === t.machine && s.dir === t.dir) || {}).id);
      g.tabs[i] = n; g.active = n.id; S.vim = k === 'shell' ? 'INSERT' : 'NORMAL'; render();
    },
    // panes
    splitR: (e, t, ev, g) => split(g, 'row'), splitD: (e, t, ev, g) => split(g, 'col'),
    zoom: (e, t, ev, g) => { if (g) S.focus = g.id; S.zoom = !S.zoom && P.leaves().length > 1; render(); },
    railFocus: e => { S.focus = e.dataset.id; render(); },
    // composer
    send: (e, t) => send(t),
    stop: (e, t) => { if (t.kind === 'sub') { const g = subOf(t); g.events = g.events.filter(x => x.t !== 'live'); g.status = 'done'; } else if (t.kind === 'side') { const sc = sideOf(t); sc.running = false; sc.events = sc.events.filter(x => x.t !== 'live'); } else { const s = sess(t.sid); s.events = s.events.filter(x => x.t !== 'live'); s.status = 'idle'; } render(); },
    attach: (e, t) => { if (box(t, e) !== t) { t.edit.atts.push({ url: D.img.shot, name: 'screenshot.png' }); render(); } else addAtt(t, D.img.shot, 'screenshot.png'); },
    rmAtt: (e, t) => { box(t, e).atts.splice(+e.dataset.i, 1); render(); },
    approve: (e, t) => resolve(t, true), deny: (e, t) => resolve(t, false),
    worktree: (e, t) => { t.worktree = !t.worktree; render(); },
    pickModel: (e, t) => modelMenu(e, t),
    pickPerm(e, t) {
      const m = t.kind === 'new' ? t : sess(t.sid);
      Menu.open({ anchor: e, place: 'top-start', width: 200, items: D.perms[D.harnessOf(m.model)].map(x => ({ label: x, on: m.perm === x })), onPick: it => { m.perm = it.label; render(); } });
    },
    pickMachine(e, t) {
      Menu.open({ anchor: e, place: 'top-start', width: 280,
        items: [...D.machines.map(m => ({ label: m.name, icon: ic(m.ssh ? 'host' : 'laptop'), hint: m.ssh ? m.addr : m.os, right: mdot(m), on: t.machine === m.id, id: m.id })), { label: 'Add SSH host', icon: ic('plus'), hint: '~/.ssh/config' }],
        onPick: it => {
          if (it.id) {
            t.machine = it.id; t.dir = D.dirs[it.id][0];
            const mc = mach(it.id), hn = D.harnessOf(t.model);
            if (!mc.has.includes(hn) && mc.has.length) {   // that machine lacks this harness: move to one it has, and say so
              Object.assign(t, defaults(D.models[mc.has[0]][0].n)); toast(`${ic(mc.has[0])}<span>${esc(mc.name)} has only ${HN[mc.has[0]]}. Switched to <b>${esc(t.model)}</b></span>`);
            }
            if (mc.ssh && mc.link === 'auth') return Auth.open(mc, 'passphrase', () => render());
          }
          render();
        } });
    },
    pickDir(e, t) {   // a new thread's directory: recent folders on its machine, or type / walk to any other (see Dirs)
      const m = mach(t.machine), path = q => Dirs.parse(q, m, false);
      Menu.open({ anchor: e, place: 'top-start', width: 360, cls: 'dirs', search: { placeholder: 'Folder or path on ' + m.name }, ...Dirs.menu,
        items: q => {
          const p = path(q), lq = q.trim().toLowerCase(); if (p) return Dirs.rows(p);
          if (!m.up) return Dirs.rows({ m });
          return [{ head: true, label: lq ? 'Folders' : 'Recent folders' }, ...(D.dirs[m.id] || []).filter(d => d.toLowerCase().includes(lq)).slice(0, lq ? 8 : 5).map(d => ({ label: d, icon: ic('folder'), on: t.dir === d, dir: { m, dir: d } })),
            { head: true, label: 'Browse' }, { label: m.name, icon: ic(m.ssh ? 'host' : 'laptop'), hint: '~/', into: '~/' }];
        },
        keys(k) { const p = path(Menu.cur.q); if (k === 'h' && p) Dirs.set(Dirs.up(p)); },
        onPick: it => { if (it.none) return; if (it.run) return it.run(); if (it.dir) { t.dir = it.dir.dir; Dirs.use(m.id, t.dir); render(); } else if (it.into) Dirs.browse(it.into); } });
    },
    // editing a sent message: click it, change it, resend from there
    // The message becomes a full composer in place (same model, permission and attach controls).
    // Enter or the send button resends from there; clicking anywhere else cancels.
    edit: (e, t) => { if (String(getSelection())) return; const i = +e.dataset.ev, ev = evs(t)[i]; t.edit = { i, draft: ev.text, atts: (ev.images || []).map(url => ({ url, name: 'image' })), notes: [], caret: null }; S.vim = 'INSERT'; S.cn = false; S.cv = false; render(); },
    // `stay`: cancelled from the keyboard, so the NORMAL cursor stays on the message that was being edited
    editCancel(e, t, stay) {
      const i = t.edit ? t.edit.i : null; t.edit = null; S.vim = 'NORMAL'; S.cn = false; S.cv = false; render();
      if (!stay || i == null || !Reader.enter(t)) return;
      Reader.prev = { vim: 'NORMAL', cn: true };
      Reader.at(t.kind === 'side' ? `sc:${t.scid}:${i}` : t.kind === 'sub' ? `sub:${t.gid}:${i}` : `ev:${t.sid}:${i}`);
    },
    editSave(e, t) {
      const s = sess(t.sid), ed = t.edit, text = ed.draft.trim(), i = ed.i; if (!text && !ed.atts.length) return;
      if (t.kind === 'side' || t.kind === 'sub') evs(t).splice(i);
      else { s.events = s.events.slice(0, i); (s.sides || []).forEach(x => { if (x.at >= i) x.at = -1; }); }
      const keep = { draft: t.draft, atts: t.atts, notes: t.notes };   // the main composer's own draft survives
      Object.assign(t, { edit: null, draft: text, atts: ed.atts }); send(t); Object.assign(t, keep); render();
    },
    // quoted selections in a composer
    // files, plans, diffs
    openFile: (e, t, ev, g) => openFile(e.dataset.p, t && t.sid, g),
    fileMode: (e, t) => { t.mode = e.dataset.v; render(); },
    // start editing a file at a spot in its text; `key` is the editing key that asked for it (it then acts as in any field)
    fileEdit(t, pos, key) {
      t.mode = 'edit'; if (t.buf == null) t.buf = Tools.docText(t.path); render();
      const ta = $(`[data-tab="${t.id}"] textarea.file-ed`); if (!ta) return;
      ta.focus(); S.cn = true; S.vim = 'NORMAL'; S.cv = false; Vim.block(ta, Math.min(pos, ta.value.length)); if (key) Vim.key(ta, key); renderStatus();
    },
    fileDone(t) { t.mode = 'source'; S.cn = false; S.cv = false; S.vim = 'NORMAL'; if (document.activeElement) document.activeElement.blur(); render(); },   // back to reading; unsaved text stays
    fileSave(e, t) { if (t.kind !== 'file' || t.buf == null) return; D.docs[t.path] = t.buf; render(); refocusLater(); },
    planOk(e, t) { const s = sess(t.sid), i = s.events.findIndex(x => x.t === 'plan'); if (i < 0) return; s.events.splice(i, 1, { t: 'text', text: 'Plan approved. Starting with the paste handler.' }, { t: 'live', text: 'Implementing the plan', dur: '3s' }); s.status = 'running'; s.perm = 'Accept edits'; render(); },
    commit: (e, t) => toast(`${ic('check')}<span>Mock: ${esc(Tools.commitLabel(t && sess(t.sid)).toLowerCase())} with ${(t.staged || []).length || 'all'} file${(t.staged || []).length === 1 ? '' : 's'}</span>`),
    commitMenu(e, t) {   // the commit button's other actions: what it does after committing, or a branch alone
      const s = sess(t.sid), main = /^(main|master)$/.test(s.branch);
      const its = main ? ['Create branch, commit & push', 'Create branch, commit & open PR', 'Create branch'] : ['Commit & push', 'Commit & open PR', 'Create branch'];
      Menu.open({ anchor: e.parentElement, trigger: e, place: 'bottom-end', width: 230, items: its.map(label => ({ label })),
        onPick: it => { Menu.close(); toast(`${ic('check')}<span>Mock: ${esc(it.label.toLowerCase())}</span>`); } });
    },
    gapOpen(e, t) { (t.gaps = t.gaps || []).push(e.dataset.k); render(); },
    stageFile(e, t) { const p = e.dataset.p, st = t.staged = t.staged || []; const i = st.indexOf(p); if (i < 0) st.push(p); else st.splice(i, 1); render(); },
    stageAll(e, t) { const set = Tools.changeSet(t, sess(t.sid)), st = t.staged || []; t.staged = set.every(f => st.includes(f.path)) ? [] : set.map(f => f.path); render(); },
    revertFile(e, t) {   // throws the file's changes away, so it says so and offers them back
      const p = e.dataset.p; (t.reverted = t.reverted || []).push(p); t.staged = (t.staged || []).filter(x => x !== p); render();
      toast(`${ic('retry')}<span>Reverted ${esc(p.replace(/^.*\//, ''))}</span><button class="btn sm" data-act="revertUndo" data-p="${esc(p)}" data-tab-id="${t.id}">Undo</button>`, 6000);
    },
    revertUndo(e) { const x = findTab(e.dataset.tabId); if (x) { x.t.reverted = (x.t.reverted || []).filter(p => p !== e.dataset.p); render(); } e.closest('.toast')?.remove(); },
    jumpFile(e, t) {   // a tree row: scroll its diff to the top and put the reader on its header
      const d = $(`[data-tab="${t.id}"] .cfile[data-p="${CSS.escape(e.dataset.p)}"]`); if (!d) return;
      d.open = true; d.scrollIntoView({ block: 'start' }); d.classList.add('flash'); setTimeout(() => d.classList.remove('flash'), 700);
    },
    toggleTree(e, t) { t.treeHidden = !t.treeHidden; render(); },
    // an open file: move to another file in the same tab, with back and forward like a browser
    fileGo(e, t) { fileNav(t, e.dataset.p); },
    fileBack(e, t) { fileStep(t, -1); },
    fileFwd(e, t) { fileStep(t, 1); },
    dirFold(e, t) { const d = e.dataset.d, c = t.closed = t.closed || []; const i = c.indexOf(d); if (i < 0) c.push(d); else c.splice(i, 1); render(); },
    crumb(e, t) {   // a folder in the path: what is in it
      const d = e.dataset.d, s = t.sid && sess(t.sid), all = [...new Set([...D.files, ...Tools.allFiles(t, s).map(f => f.path)])];
      const kids = all.filter(p => (d ? p.startsWith(d + '/') : true) && !p.slice(d ? d.length + 1 : 0).includes('/'));
      const subs = [...new Set(all.filter(p => (d ? p.startsWith(d + '/') : true)).map(p => p.slice(d ? d.length + 1 : 0)).filter(r => r.includes('/')).map(r => r.split('/')[0]))];
      Menu.open({ anchor: e, place: 'bottom-start', width: 240, search: { placeholder: 'Go to file' },
        items: [...subs.map(x => ({ label: x + '/', icon: ic('folder'), dir: (d ? d + '/' : '') + x })), ...kids.sort().map(p => ({ label: base(p), icon: Tools.lang(p), p, on: p === t.path }))],
        onPick: it => { Menu.close(); if (it.dir) { const b = $(`[data-tab="${t.id}"] .crumb[data-d="${CSS.escape(it.dir)}"]`); if (b) return act.crumb(b, t); fileNav(t, all.find(p => p.startsWith(it.dir + '/'))); } else fileNav(t, it.p); } });
    },
    pickScope(e, t) {
      const s = sess(t.sid), cnt = k => Tools.nums(Tools.counts(Tools.changeSet(t, s, k)), 'sm');
      const set = k => ({ label: Tools.SCOPE[k], k, on: t.scope === k, icon: ic(Tools.SCOPE_IC[k]), hint: '', right: cnt(k) });
      Menu.open({ anchor: e, place: 'bottom-start', width: 240, keep: true,
        items: () => [...Object.keys(Tools.SCOPE).map(set), { label: 'Commits', icon: ic('branch'), right: ic('chev'), fly: true, on: t.scope === 'c:range' }],
        onPick: it => { if (it.fly) return Fly.open($('.menu .mi.sel'), t); t.scope = it.k; t.range = null; Menu.close(); render(); } });
      Menu.cur.e.addEventListener('mouseover', ev => { const r = ev.target.closest('.mi'), it = r && Menu.cur && Menu.cur.items[+r.dataset.i]; if (it && it.fly && !Fly.el) { Menu.cur.i = +r.dataset.i; Menu.draw(); Fly.open($('.menu .mi.sel'), t); } });
    },
    // side chats
    sideOpen: e => sidePeek(e.dataset.sid, e.dataset.sc),
    subOpen: e => openSub(e.dataset.sid, e.dataset.g),
    sideNew: (e, t) => sidePeek(t.sid, newSide(t.sid, +e.dataset.ev).id),
    // a popup's x: close it, or with alt/option held, put it back as a tab in the focused pane
    peekClose(e, t, ev) { const id = t && pop(t.id) ? t.id : S.pf; if (!id) return; if (ev && ev.altKey) return act.peekDock(e, t); popClose(id); S.vim = 'NORMAL'; S.cn = false; render(); },
    peekDock(e, t) { const p = pop(t && pop(t.id) ? t.id : S.pf); if (!p) return; popClose(p.t.id); addTab(focused(), p.t); render(); },
    // ctrl-o: from a popup back to the pane it was opened from (the popup stays). ctrl-i: forward to that popup again.
    jumpBack: () => { const p = pop(S.pf); if (!p) return; p.own = where(); S.restore = p.place; S.back = p.t.id; S.pf = null; homePane(p); S.vim = 'NORMAL'; S.cn = false; S.cv = false; if (document.activeElement) document.activeElement.blur(); render(); },
    jumpFwd: () => { if (S.pf || !S.back || !pop(S.back)) return; pop(S.back).place = where(); S.restore = pop(S.back).own; S.pf = S.back; S.vim = 'NORMAL'; S.cn = false; S.cv = false; if (document.activeElement) document.activeElement.blur(); render(); },
    wsMenu: () => WS.menu(),
    handNow: (e, t) => { const s = sess(t.sid); clearTimeout(s.timer); s.timer = null; s.events = s.events.filter(x => x.t !== 'live'); s.events.push({ t: 'interrupted' }); s.status = 'idle'; (s.subs || []).forEach(g => { if (g.status === 'running') g.status = 'stopped'; }); settle(s); render(); },
    takeBack: (e, t) => { const s = sess(t.sid); hand(s, 'chat'); render(); if (s.drive === 'chat') { S.vim = 'INSERT'; refocus(); renderStatus(); } },
    takeCancel: (e, t) => { sess(t.sid).pend = null; render(); },
    pasteRetry: (e, t) => { const u = t.paste; t.paste = null; mach(ctxOf(t).machine).link = 'up'; pastes--; addAtt(t, u.url, u.name); },
    pasteDrop: (e, t) => { t.paste = null; S.vim = 'INSERT'; render(); },
    errFix(e, t) {
      const s = t && t.sid && sess(t.sid), k = e.dataset.k; if (!s) return;
      if (k === 'missing') return toast(`${ic('copy')}<span>Copied <b>${s.harness === 'claude' ? 'npm i -g @anthropic-ai/claude-code' : 'npm i -g @openai/codex'}</b></span>`);
      if (k === 'auth') return toast(`${ic(s.harness)}<span>Mock: opens <b>${s.harness === 'claude' ? 'claude /login' : 'codex login'}</b> in a terminal on ${esc(mach(s.machine).name)}</span>`);
      s.events = s.events.filter(x => !(x.t === 'err' && x.kind === k));
      if (k === 'crash' || k === 'rate') { s.status = 'running'; s.events.push({ t: 'live', text: k === 'crash' ? 'Resuming' : 'Retrying', dur: '1s' }); }
      render();
    },
    peekFocus: () => { if (!S.pops.length) return; const i = S.pops.findIndex(p => p.t.id === S.pf), nx = S.pops[i + 1]; S.pf = nx ? nx.t.id : null; S.vim = 'NORMAL'; S.cn = false; if (document.activeElement) document.activeElement.blur(); render(); },   // cycles: each popup in turn, then back to the panes
    gotoThread: e => { S.pf = false; const hit = shown(e.dataset.sid); if (hit) { activate(hit.g, hit.t); render(); } else openThread(e.dataset.sid); },
    sideToMain(e, t) { const last = [...sideOf(t).events].reverse().find(x => x.t === 'text'), hit = shown(t.sid); if (last && hit) { hit.t.draft = '> ' + last.text.replace(/[`*]/g, ''); S.pf = false; activate(hit.g, hit.t); S.vim = 'INSERT'; render(); } },
    // popovers
    machineActions(e) {
      const heading = e.closest('.s-h');
      Menu.open({ anchor: e, place: 'bottom-start', width: 200, items: [
        { label: heading.classList.contains('shut') ? 'Expand section' : 'Collapse section', icon: ic('tree'), run: () => heading.click() },
        { label: 'Machine settings', icon: ic('sliders'), run: () => {
          Sett.sec = Sett.sections().findIndex(([name]) => name === 'Machines');
          Sett.row = D.machines.findIndex(m => m.id === e.dataset.m);
          Sett.open();
        } }
      ], onPick: item => item.run() });
    },
    machines(e) {
      Menu.open({ anchor: e && e.closest ? e : $('.mbtn') || $('#status'), place: 'top-start', width: 330, cls: 'mach',
        items: [{ head: true, label: 'Machines' }, ...D.machines.map(m => ({ label: m.name, icon: ic(m.ssh ? 'host' : 'laptop'), hint: m.ssh ? m.addr : m.os, id: m.id,
          right: ['claude', 'codex'].map(hn => `<span class="has ${m.has.includes(hn) ? '' : 'no'}" title="${HN[hn]} ${m.has.includes(hn) ? 'installed' : 'not found'}">${ic(hn)}</span>`).join('') + mdot(m) })),
          { label: 'Add SSH host', icon: ic('plus'), hint: 'from ~/.ssh/config' }],
        onPick: it => { if (!it.id) return; const t = T.fresh(); t.machine = it.id; t.dir = D.dirs[it.id][0]; addTab(focused(), t); S.vim = 'INSERT'; render(); } });
    },
    settings: () => { Menu.close(); Sett.open(); },
    setSec: e => { Sett.sec = +e.dataset.i; Sett.row = 0; Sett.draw(); },
    setRow: e => Sett.run(+e.dataset.i),
    setOpt: e => { const r = Sett.sections()[Sett.sec][2][+e.dataset.i]; Sett.row = +e.dataset.i; r.set(e.dataset.v); render(); Sett.draw(); },
    setClose: () => Sett.close(),
    authOk: () => Auth.ok(), authCancel: () => Auth.close(),
    keyEdit: e => Keys.edit(+e.dataset.i), keyReset: e => Keys.reset(+e.dataset.i), keyClose: () => Keys.close(),
    keyRc: () => { Keys.close(); const hit = allTabs().find(x => x.t.kind === 'vimrc'); if (hit) activate(hit.g, hit.t); else addTab(focused(), T.vimrc()); S.vim = 'NORMAL'; render(); },
    scenes(e) { Menu.open({ anchor: e, place: 'top-end', width: 270, items: [{ head: true, label: 'Mockup scenes' }, ...Object.keys(scenes).map(k => ({ label: k, hint: NOTE[k] || '' }))], onPick: it => scene(it.label) }); },
  };

  // ---------- scenes (mockup only): jump to a state via ?scene=name ----------
  const L = (sid, view, ...more) => P.pane(T.thread(sid, view), ...more), X = P.split;
  const SH = (machine, dir, cmds) => { const m = mach(machine); return T.shell(machine, dir, cmds.map(c => typeof c === 'string' ? { text: c } : { ps: Term.ps1(m, dir), text: c[0] })); };
  const shLinux = () => SH('linux', '~/repo/trade-ticker', [['git status -sb'], '## perf/orders-index...origin/perf/orders-index\n M migrations/0043_restore_index.sql\n?? bench/p95.png']);
  const shLocal = () => SH('local', '~/projects/skein', [['pnpm dev'], '  VITE v6.2  ready in 412 ms\n  ➜  Local:   http://localhost:5173/']);
  const one = (sid, view) => { S.tree = L(sid, view || 'chat'); return S.tree; };
  const home = () => { S.tree = X('row', L('s1', 'chat', T.thread('s8', 'chat')), X('col', L('s2', 'term'), P.pane(T.tool('changes', 's1'), T.tool('files', 's1'), shLocal()), 0.56), 0.52); };
  const NOTE = { move: 'move a thread to another machine', home: 'chat, terminal and tools together', new: 'launcher in a new tab', single: 'one thread', grid: '2 × 2', tmux: 'uneven splits, shells, tabs', detect: 'harness started in a shell', recent: 'sidebar by activity', zoom: 'one pane + rail',
    slash: '/ menu', palette: 'ctrl-k', files: 'ctrl-p file search', cmdline: ': line', paste: 'image in chat over SSH', approval: 'permission request', machines: 'hosts', keys: 'shortcut sheet', model: 'model + effort', side: 'side chat popup', subagents: '/subagents list', subagent: 'a subagent in a popup', popups: 'several tabs popped out', docked: 'side chat as a tab',
    plan: 'comment on a plan file', changes: 'diff viewer scopes', annotate: 'select text, add to chat', reader: 'Vim visual mode over the thread', vimrc: 'vimrc editor',
    workspaces: 'find, create, manage workspaces', switcher: 'ctrl-tab between workspaces', folders: 'walk to a folder on a machine',
    edit: 'edit a sent message', vim: 'Vim NORMAL in a composer', ticks: 'timeline hover', tabs: 'tab search', settings: 'settings dialog', file: 'open file with changes',
    handoff: 'Claude: terminal waits for the turn', mirror: 'Claude: terminal drives, chat mirrors', codex: 'Codex: both views live',
    pasteLocal: 'image into a local terminal', pasteSsh: 'image into a terminal over SSH', pasteFail: 'upload fails mid-way',
    reconnect: 'SSH link drops mid-turn', sshAuth: 'key passphrase', hostKey: 'new host key', missing: 'harness not on that machine',
    approvals: 'several requests waiting', errors: 'crash, rate limit, sign-in, missing CLI', mac: window.OS === 'mac' ? 'reload as Windows' : 'reload as a Mac' };
  const scenes = {
    home,
    new() { S.tree = P.pane(T.fresh()); S.vim = 'INSERT'; },
    single() { one('s1'); },
    grid() { S.tree = X('row', X('col', L('s1', 'chat'), L('s3', 'term')), X('col', L('s2', 'chat'), L('s4', 'term'))); },
    tmux() { S.tree = X('row', L('s1', 'term'), X('col', X('row', L('s2', 'chat'), P.pane(shLinux()), 0.62), X('row', L('s3', 'chat'), X('col', L('s4', 'term'), P.pane(shLocal(), T.tool('browser', 's3')), 0.6), 0.5), 0.52), 0.4); },
    detect() { const sh = SH('linux', '~/repo/metrics', [['ls'], 'README.md  collectors  dashboards  pyproject.toml']), g = P.pane(sh); S.tree = X('row', L('s2', 'term'), g, 0.5); S.focus = g.id; sh.draft = 'claude'; return () => shellRun(sh); },
    recent() { home(); S.sideView = 'recent'; },
    zoom() { scenes.grid(); S.zoom = true; },
    slash() { const t = cur(one('s1')); t.draft = '/'; S.vim = 'INSERT'; return () => { const i = $('.pane [data-input]'); if (i) draftChanged(t, i); }; },
    palette() { home(); return palette; },
    files() { home(); return fileSearch; },
    cmdline() { home(); return () => cmdline('vs'); },
    paste() { const t = cur(one('s4')); return () => addAtt(t, D.img.shot, 'clipboard.png'); },
    approval() { one('s3'); },
    machines() { home(); return () => act.machines(); },
    keys() { home(); return keysSheet; },
    model() { S.tree = P.pane(T.fresh()); return () => modelMenu($('[data-act=pickModel]'), cur(S.tree)); },
    side() { S.tree = X('row', L('s1', 'chat'), L('s2', 'term'), 0.6); return () => sidePeek('s1', 'c1'); },
    subagents() { const t = cur(one('s1')); S.vim = 'INSERT'; return () => { subList('s1', $('.comp')); }; },
    subagent() { one('s1'); return () => openSub('s1', 'g2'); },
    popups() { home(); return () => { const a = popOut(T.tool('changes', 's1')), b = popOut(T.thread('s3', 'chat')), c = popOut(T.side('s1', 'c1')); Object.assign(a, { x: 300, y: 70 }); Object.assign(b, { x: 60, y: 250 }); S.pf = c.t.id; S.vim = 'NORMAL'; render(); }; },
    docked() { S.tree = X('row', L('s1', 'chat'), P.pane(T.side('s1', 'c1'), T.tool('changes', 's1'), T.side('s1', 'c2')), 0.58); },
    edit() { const t = cur(one('s1')); t.edit = { i: 7, draft: 'Add a regression test too.', atts: [], notes: [], caret: null }; S.vim = 'INSERT'; },
    vim() { const t = cur(one('s1')); t.draft = 'Also cover the case where the flush fails halfway'; S.cn = true; S.cpos = 20; },
    ticks() { one('s1'); return () => { const b = $$('.ticks button')[0]; if (b) b.dispatchEvent(new Event('mouseenter')); }; },
    tabs() { home(); return () => act.tabSearch($('.pane.focus [data-act=tabSearch]'), null, null, focused()); },
    settings() { home(); return () => { Sett.sec = 2; Sett.row = 0; Sett.open(); }; },
    plan() {
      const t = T.thread('s9', 'chat'); S.tree = X('row', P.pane(t), P.pane(T.file('PLAN.md', 's9')), 0.5);
      return () => { const a = Annot.quote('file:PLAN.md', 'after seven days'), b = Annot.quote('file:PLAN.md', 'one SSH control connection'); if (!a || !b) return; t.notes.push(a, b); t.draft = tokOf(a) + ' clean up on close instead; a week is too long. And ' + tokOf(b) + ' is fine, reuse it.'; render(); Annot.paint(a.id); };
    },
    // an open file with uncommitted changes: path, back/forward, the project tree, gutter marks
    file() { const g = P.pane(T.file('sessions/store.ts', 's1'), T.tool('changes', 's1')); S.tree = X('row', L('s1', 'chat'), g, 0.34); S.focus = g.id; },
    changes() { const g = P.pane(T.tool('changes', 's1')); S.tree = X('row', L('s1', 'chat'), g, 0.45); S.focus = g.id; return () => { act.pickScope($('[data-act=pickScope]'), cur(g)); Menu.cur.i = Menu.cur.items.findIndex(it => it.fly); Menu.accept(); Fly.i = 1; Fly.toggle(); Fly.i = 2; Fly.toggle(); }; },
    annotate() { one('s1'); return () => Annot.select('ev:s1:4', 'restore lock and wait for the flush'); },
    reader() { const t = cur(one('s1')); t.draft = 'Why wait for the flush?'; S.cn = true; return () => { Reader.enter(t); Reader.at('ev:s1:4'); Reader.key('v'); 'wwwwwww'.split('').forEach(Reader.key); }; },
    workspaces() { home(); sess('s4').events.push({ ...sess('s3').events.find(e => e.t === 'approval') }); sess('s4').status = sess('s3').status; return () => WS.menu(); },
    switcher() { scenes.workspaces(); return () => WS.cycle(1); },
    move() { scenes.home(); return () => Move.open('s1', 'linux', '~/repo/skein'); },
    folders() { home(); return () => WS.menu('linux:~/repo/'); },
    vimrc() { const g = P.pane(T.vimrc()); S.tree = X('row', L('s1', 'chat'), g, 0.55); S.focus = g.id; },
    // G4: Claude Code is mid-turn, so showing its terminal waits; chat keeps driving until the turn ends
    handoff() { const t = cur(one('s1')); return () => setView(t, 'term'); },
    // G4: the terminal has the thread; the chat view mirrors it read-only and can take it back
    mirror() { const s = sess('s7'); s.drive = 'term'; S.tree = X('row', L('s7', 'chat'), P.pane(T.tool('changes', 's7'), shLocal()), 0.6); },
    // Codex: chat and terminal attach to one app-server, so both are live
    codex() { S.tree = X('row', L('s4', 'term'), P.pane(T.tool('files', 's4')), 0.62); },
    pasteLocal() { const t = cur(one('s8', 'term')); return () => { refocus(); addAtt(t, D.img.shot, 'clipboard.png'); }; },
    pasteSsh() { const t = cur(one('s2', 'term')); return () => { refocus(); addAtt(t, D.img.shot, 'clipboard.png'); }; },
    pasteFail() { const t = cur(one('s2', 'term')); mach('linux').link = 'reconnecting'; return () => addAtt(t, D.img.shot, 'clipboard.png', { fail: true }); },
    reconnect() { mach('linux').link = 'reconnecting'; S.tree = X('row', L('s4', 'chat'), L('s2', 'term'), 0.55); },
    sshAuth() { mach('build').link = 'auth'; mach('build').up = false; home(); return () => Auth.open(mach('build'), 'passphrase'); },
    hostKey() { mach('build').link = 'auth'; mach('build').authKind = 'hostkey'; home(); return () => Auth.open(mach('build'), 'hostkey'); },
    missing() { Object.assign(mach('build'), { up: true, link: 'up' }); const t = T.fresh(); Object.assign(t, { machine: 'build', dir: '~/ci' }, defaults('GPT-6.2 Sol')); S.tree = P.pane(t); return () => modelMenu($('[data-act=pickModel]'), t); },
    approvals() {
      const s = sess('s3');
      s.events.push({ t: 'approval', cmd: 'pnpm test ui/composer', why: 'Check the composer tests still pass', from: 'Test runner' }, { t: 'approval', cmd: 'git stash list', why: 'See if older composer work was stashed', from: 'Explore' });
      one('s3');
    },
    errors() {
      const mk = (id, harness, title, machine, kind, ev) => { D.sessions.push({ id, harness, title, machine, dir: D.dirs[machine][0], branch: 'main', status: 'error', age: 3, model: D.models[harness][0].n, effort: 'Medium', perm: D.perms[harness][1], ctx: 30,
        events: [{ t: 'user', text: ev }, { t: 'tool', name: 'Read', arg: 'README.md', meta: '120 lines' }, { t: 'err', kind }] }); return id; };
      Object.assign(mach('build'), { up: true, link: 'up' });
      const a = mk('e1', 'claude', 'Port the importer', 'local', 'crash', 'Port the importer to the new API.'), b = mk('e2', 'codex', 'Backfill fills table', 'linux', 'rate', 'Backfill the fills table for October.');
      const c = mk('e3', 'claude', 'Summarise the incident', 'linux', 'auth', 'Summarise last night’s incident from the logs.'), d = mk('e4', 'claude', 'Fix the runner image', 'build', 'missing', 'Fix the runner image so CI can start.');
      S.tree = X('row', X('col', L(a, 'chat'), L(b, 'term')), X('col', L(c, 'chat'), L(d, 'chat')));
    },
    mac() { try { if (location.search) { const u = new URL(location.href); u.searchParams.set('os', OS === 'mac' ? 'win' : 'mac'); u.searchParams.set('scene', 'home'); location.href = u.href; } else { location.hash = OS === 'mac' ? 'win' : 'mac'; location.reload(); } } catch {} },
  };
  function scene(name) {
    if (!scenes[name]) name = 'home';
    Menu.close(); closeSheet(); $$('.toast').forEach(t => t.remove());
    D.reset();
    for (const session of D.sessions) {
      session.title = store.get('ad2-title:' + session.id + ':') || session.title;
      for (const side of session.sides || []) {
        side.title = store.get('ad2-title:' + session.id + ':' + side.id) || side.title;
      }
    }
    Object.assign(S, { ws: [], wid: null, zoom: false, pops: [], pf: null, cv: false, leader: false, vim: 'NORMAL', cn: false, collapsed: {}, projects: {}, focus: null, cursor: null });
    const after = scenes[name]();
    if (!S.focus) S.focus = P.leaves()[0].id;
    // two more workspaces behind the one on screen, each its own layout
    S.ws = [WS.mk('dotfiles', 'local', '~/projects/dotfiles', X('col', L('s7', 'chat'), P.pane(SH('local', '~/projects/dotfiles', [['git status -sb'], '## main...origin/main'])), 0.68)),
      WS.mk('trade-ticker', 'linux', '~/repo/trade-ticker', X('row', L('s2', 'chat'), X('col', L('s4', 'term'), P.pane(shLinux(), T.tool('browser', 's2')), 0.55), 0.56)),
      WS.mk('Skein', 'local', '~/projects/skein', null)];
    S.wid = S.ws[2].id;
    render();
    if (after) after();
    try { const u = new URL(location.href); u.searchParams.set('scene', name); history.replaceState(null, '', u); } catch {}   // not allowed in every frame
  }

  // ---------- DOM events ----------
  // While alt/option is held, a tab's x shows "pop out" and a popup's x shows "back into the focused pane".
  const alt = on => document.body.classList.toggle('alt', on);
  document.addEventListener('keydown', e => { if (e.key === 'Alt') alt(true); });
  document.addEventListener('keyup', e => { if (e.key === 'Alt') { alt(false); e.preventDefault(); } });
  window.addEventListener('blur', () => alt(false));
  const tabAt = n => { const e = n.closest('[data-tab]'); const x = e && findTab(e.dataset.tab); return x && x.t; };
  let draggedProject, markedProject;

  function clearProjectMark() {
    if (markedProject) delete markedProject.dataset.dropEdge;
    markedProject = null;
  }

  // a thread dragged onto a project (or a machine's heading, which asks for the folder) moves there
  let draggedThread = null, markedTarget = null;
  const unmark = () => { markedTarget?.classList.remove('drop-into'); markedTarget = null; };
  document.addEventListener('dragstart', e => {
    const tr = e.target.closest && e.target.closest('#side .row[data-sid]'); if (!tr) return;
    draggedThread = tr.dataset.sid; tr.classList.add('drag-source');
    e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', sess(draggedThread).title);
  });
  document.addEventListener('dragover', e => {
    if (!draggedThread) return; unmark();
    const s = sess(draggedThread), t = e.target.closest('#side .s-d, #side .s-h[data-k^="h:"]');
    if (!t || t.dataset.k === 'h:pinned' || t.dataset.k === 'h:recent') return;
    if (t.matches('.s-d') && t.dataset.machine === s.machine && t.dataset.dir === s.dir) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'move'; t.classList.add('drop-into'); markedTarget = t;
  });
  document.addEventListener('drop', e => {
    if (!draggedThread || !markedTarget) return; e.preventDefault();
    const t = markedTarget, sid = draggedThread; unmark(); draggedThread = null;
    if (t.matches('.s-d')) Move.open(sid, t.dataset.machine, t.dataset.dir);
    else { const mid = t.dataset.k.slice(2), m = mach(mid), match = (D.dirs[mid] || []).find(d => repoOf(d) === repoOf(sess(sid).dir));
      const blocked = !m.has.includes(sess(sid).harness) || !m.up;   // can't go there: show why rather than a folder picker
      if (match || blocked) Move.open(sid, mid, match || '~/' + repoOf(sess(sid).dir)); else Move.pickDir(sid, mid, t); }
  });
  document.addEventListener('dragend', () => { $$('#side .row.drag-source').forEach(x => x.classList.toggle('drag-source', false)); draggedThread = null; unmark(); });

  document.addEventListener('dragstart', e => {
    if (draggedThread) return;
    const row = e.target.closest('.s-d');
    if (!row) return;
    if (row.querySelector('input')) { e.preventDefault(); return; }
    draggedProject = row;
    const preview = document.createElement('div');
    preview.className = 's-d drag-preview';
    preview.append(row.querySelector('.project-folder').cloneNode(true), row.querySelector('.t').cloneNode(true));
    document.body.append(preview);
    e.dataTransfer.setDragImage(preview, 12, 15);
    requestAnimationFrame(() => {
      preview.remove();
      if (draggedProject === row) row.classList.add('drag-source');
    });
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', row.dataset.dir);
  });
  document.addEventListener('dragover', e => {
    if (!draggedProject) return;
    clearProjectMark();
    const row = e.target.closest('.s-d');
    if (!row || row === draggedProject || row.dataset.machine !== draggedProject.dataset.machine) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const bounds = row.getBoundingClientRect();
    row.dataset.dropEdge = e.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after';
    markedProject = row;
  });
  document.addEventListener('drop', e => {
    if (!draggedProject || !markedProject || e.target.closest('.s-d') !== markedProject) return;
    e.preventDefault();
    const { machine, dir } = draggedProject.dataset;
    const order = projectOrder(machine, D.sessions.filter(s => s.machine === machine)).filter(d => d !== dir);
    order.splice(order.indexOf(markedProject.dataset.dir) + Number(markedProject.dataset.dropEdge === 'after'), 0, dir);
    store.set('ad2-dir-order:' + machine, JSON.stringify(order));
    clearProjectMark();
    draggedProject = null;
    const scroll = $('.s-list').scrollTop;
    renderSide();
    $('.s-list').scrollTop = scroll;
  });
  document.addEventListener('dragend', () => { draggedProject?.classList.remove('drag-source'); draggedProject = null; clearProjectMark(); });

  let pendingRowClick;
  document.addEventListener('click', e => {
    clearTimeout(pendingRowClick);
    const row = e.target.closest('#side .row');
    if (row && e.target.closest('[data-act]') === row && e.detail && !(e.altKey || e.ctrlKey || e.metaKey || e.shiftKey)) {
      if (e.detail === 2) editSidebarName(row);
      else pendingRowClick = setTimeout(() => {
        if (row.isConnected) act[row.dataset.act](row, curTab(), e);
      }, 350);
      return;
    }
    const img = e.target.closest('img[data-zoom]'); if (img) return lightbox(img.src);
    // an edit-in-place box has no cancel button: a click anywhere outside it cancels
    let cancelled = false; const drawn = renders;
    if (!e.target.closest('.m-edit, .menu, .scrim, .seltb, .tokx')) everyTab().forEach(t => { if (t.edit) { t.edit = null; cancelled = true; } });
    const done = () => { if (cancelled && renders === drawn) { S.cn = false; S.cv = false; if (S.vim === 'INSERT') S.vim = 'NORMAL'; render(); } };
    const tk = tokUnder(e); if (tk && !e.target.closest('.tokx')) noteGo(tk.t, tk.n);   // a quote in a composer: go to what it points at
    const a = e.target.closest('[data-act]');
    const pe = e.target.closest('.pane'), g = pe ? P.get(pe.dataset.pane) : null;
    if (a) { if (g) { S.focus = g.id; S.pf = false; } else if (e.target.closest('.peek')) S.pf = e.target.closest('.peek').dataset.tab; if (a.matches('.flink')) e.preventDefault(); const fn = act[a.dataset.act]; if (fn) fn(a, tabAt(a) || curTab(), e, g || focused()); return done(); }
    const term = e.target.closest('.term');   // click anywhere in a terminal to type in it
    if (term && pe && !String(getSelection()) && e.target.tagName !== 'INPUT') { const i = $('[data-input]', term); if (i) i.focus(); }
    done();
  });
  // A composer shows a cursor only while it has the keyboard. When focus leaves it (the cursor moved up
  // into the thread, to another pane, to a menu), its NORMAL block is taken down so there is never a second one.
  document.addEventListener('focusout', e => {
    const ta = e.target; if (!ta.matches || !ta.matches('[data-input]')) return;
    setTimeout(() => { if (document.activeElement === ta || !ta.isConnected) return; ta.classList.remove('vn', 'vv', 'hollow'); if (ta.tagName === 'TEXTAREA') paintBk(ta); }, 0);
  });
  // quotes in a composer: hovering one lights up the text it points at and offers an x to remove it
  const tokx = el(`<button class="tokx" title="Remove">${ic('x')}</button>`);
  let hot = null;
  document.addEventListener('mousemove', e => {
    if (e.target === tokx || tokx.contains(e.target)) return;
    const tk = tokUnder(e);
    if (!tk) { if (hot) { hot = null; tokx.remove(); Annot.paint(); } return; }
    if (hot && hot.n === tk.n) return;
    hot = tk; Annot.paint(tk.n.id);
    tokx.style.left = (tk.rect.right - 4) + 'px'; tokx.style.top = (tk.rect.top - 9) + 'px'; document.body.appendChild(tokx);
  });
  tokx.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); if (hot) { const h = hot; hot = null; tokx.remove(); dropNote(h.t, h.i); } });
  // The mouse in a composer: a click puts you in INSERT at that spot; a drag or double-click is
  // VISUAL and a triple-click is VISUAL LINE, the same as v and V.
  // a click in the panes takes focus back from the sidebar; a click in the sidebar gives it focus there
  document.addEventListener('pointerdown', e => { if (!e.target.closest) return; const inSide = !!e.target.closest('#side'); if (inSide !== !!S.sf && (inSide || e.target.closest('#work'))) { S.sf = inSide; syncFocus(); paintNav(); } }, true);
  document.addEventListener('pointerdown', e => { const ta = e.target.closest && e.target.closest('textarea[data-input]'); if (ta) ta._ins = S.vim === 'INSERT' && !S.cn && document.activeElement === ta; }, true);
  document.addEventListener('mouseup', e => {
    const ta = e.target.closest && e.target.closest('textarea[data-input]'); if (!ta || !S.vimOn || !window.Vim) return;
    setTimeout(() => {
      if (document.activeElement !== ta) return;
      const a = ta.selectionStart, b = ta.selectionEnd;
      if (e.detail >= 3 || a !== b) { S.cn = true; S.vim = 'NORMAL'; S.cv = e.detail >= 3 ? 'V' : 'v'; S.va = a; S.cpos = Math.max(a, b - 1); Vim.span(ta); }
      else {
        S.cn = false; S.cv = false; S.vim = 'INSERT'; ta.classList.remove('vn', 'vv', 'hollow');
        const tk = Vim.tokAt(ta.value, a); if (tk && a > tk[0]) { const edge = a - tk[0] < tk[1] - a ? tk[0] : tk[1]; ta.setSelectionRange(edge, edge); }
        paintBk(ta);
      }
      renderStatus();
    }, 0);
  });
  document.addEventListener('pointerdown', e => {
    const pe = e.target.closest('.pane'), pk = e.target.closest('.peek');
    if (pk) { if (S.pf !== pk.dataset.tab) { S.pf = pk.dataset.tab; syncFocus(); } }
    else if (pe && (S.pf || pe.dataset.pane !== S.focus)) { S.pf = false; S.focus = pe.dataset.pane; syncFocus(); }
  });
  document.addEventListener('mousedown', e => {
    if (Menu.cur && !Menu.cur.o.modal && !Menu.cur.e.contains(e.target) && !e.target.closest('.fly') && !(Menu.cur.o.anchor && Menu.cur.o.anchor.contains(e.target))) Menu.close();
    if (window.Reader && Reader.on && !e.target.closest('.seltb')) Reader.off();
    if (!e.target.closest('[data-input], .menu, .scrim, .comp, .newp, .m-edit, .seltb') && (S.vim !== 'NORMAL' || S.cn)) { S.vim = 'NORMAL'; S.cn = false; renderStatus(); }
  });
  document.addEventListener('focusin', e => {
    if (!e.target.matches || !e.target.matches('[data-input]')) return;
    const pe = e.target.closest('.pane'); if (pe) { S.focus = pe.dataset.pane; S.pf = false; } else if (e.target.closest('.peek')) S.pf = e.target.closest('.peek').dataset.tab;
    if (!S.cn) { S.vim = 'INSERT'; e.target.classList.remove('vn', 'vv', 'hollow'); }
    syncFocus();
  });
  document.addEventListener('pointerdown', e => {
    if (!e.target.matches('.side-resize') || e.button !== 0) return;
    e.preventDefault();
    const side = $('#side'), startWidth = side.getBoundingClientRect().width;
    const handle = e.target;
    handle.setPointerCapture(e.pointerId);
    handle.onpointermove = ev => {
      if (ev.pointerId !== e.pointerId) return;
      const width = Math.min(innerWidth * 0.6, Math.max(200, startWidth + ev.clientX - e.clientX));
      $('#app').style.setProperty('--sidebar-width', width + 'px');
    };
    handle.onlostpointercapture = () => { handle.onpointermove = null; };
  });
  // popups resize from any edge or corner
  document.addEventListener('pointerdown', e => {
    const hd = e.target.closest('.peek > .rz'); if (!hd) return;
    e.preventDefault(); e.stopPropagation();
    const pk = hd.parentElement, p = pop(pk.dataset.tab), d = hd.dataset.rz, w = $('#work').getBoundingClientRect(), r = pk.getBoundingClientRect();
    const o = { x: r.left - w.left, y: r.top - w.top, w: r.width, h: r.height, px: e.clientX, py: e.clientY }, MW = 300, MH = 220;
    const move = ev => {
      let { x, y, w: ww, h } = o; const dx = ev.clientX - o.px, dy = ev.clientY - o.py;
      if (d.includes('e')) ww = Math.max(MW, o.w + dx);
      if (d.includes('s')) h = Math.max(MH, o.h + dy);
      if (d.includes('w')) { ww = Math.max(MW, o.w - dx); x = o.x + o.w - ww; }
      if (d.includes('n')) { h = Math.max(MH, o.h - dy); y = o.y + o.h - h; }
      Object.assign(p, { x, y, w: ww, h });
      Object.assign(pk.style, { right: 'auto', left: x + 'px', top: y + 'px', width: ww + 'px', height: h + 'px' });
    };
    const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.body.classList.remove('resizing'); };
    document.body.classList.add('resizing');
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
  });
  // the floating side chat: drag it by its header
  document.addEventListener('pointerdown', e => {
    const hd = e.target.closest('.peek > .tb'); if (!hd || e.target.closest('button')) return;
    if (document.activeElement?.matches('[data-input]')) document.activeElement.blur();
    if (S.vim !== 'NORMAL' || S.cn) { S.vim = 'NORMAL'; S.cn = false; renderStatus(); }
    const pk = hd.parentElement, w = $('#work').getBoundingClientRect(), r = pk.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    const move = ev => { const p = pop(pk.dataset.tab); if (!p) return; p.x = Math.max(0, Math.min(w.width - 80, ev.clientX - w.left - dx)); p.y = Math.max(0, Math.min(w.height - 40, ev.clientY - w.top - dy)); pk.style.right = 'auto'; pk.style.left = p.x + 'px'; pk.style.top = p.y + 'px'; };
    const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); };
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up); e.preventDefault();
  });
  // effort track in the model menu: click or drag to a stop
  document.addEventListener('pointerdown', e => {
    const lab = e.target.closest('.eff .et span'), trk = e.target.closest('.eff .trk'); if ((!lab && !trk) || !Menu.cur || !Menu.cur.o.effortTo) return;
    e.preventDefault();
    if (lab) return Menu.cur.o.effortTo(+lab.dataset.j);
    let last = -1;
    const at = ev => { const el = $('.eff .trk'); if (!el || !Menu.cur) return; const r = el.getBoundingClientRect(), n = +el.dataset.n, j = Math.round(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * (n - 1)); if (j !== last) { last = j; Menu.cur.o.effortTo(j); } };
    const up = () => { document.removeEventListener('pointermove', at); document.removeEventListener('pointerup', up); };
    document.addEventListener('pointermove', at); document.addEventListener('pointerup', up); at(e);
  });
  document.addEventListener('input', e => {
    if (e.target.matches('[data-input]')) draftChanged(tabAt(e.target), e.target);
  });
  document.addEventListener('paste', e => {
    const f = [...(e.clipboardData ? e.clipboardData.files : [])].find(f => f.type.startsWith('image/'));
    if (!f) return;
    e.preventDefault(); addAtt(curTab(), URL.createObjectURL(f), f.name || 'clipboard.png');
  });

  // dividers: drag to resize a split
  document.addEventListener('pointerdown', e => {
    const dv = e.target.closest('.dv'); if (!dv) return;
    e.preventDefault();
    const box = dv.parentElement, [a, , b] = box.children, row = box.classList.contains('d-row');
    let node; (function find(n) { if (n.id === box.dataset.x) node = n; else if (n.type === 'split') { find(n.a); find(n.b); } })(S.tree);
    dv.setPointerCapture(e.pointerId); dv.classList.add('on');
    const move = ev => { const r = box.getBoundingClientRect(); node.ratio = Math.min(0.88, Math.max(0.12, row ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height)); a.style.flex = node.ratio; b.style.flex = 1 - node.ratio; };
    const up = () => { dv.classList.remove('on'); dv.removeEventListener('pointermove', move); dv.removeEventListener('pointerup', up); };
    dv.addEventListener('pointermove', move); dv.addEventListener('pointerup', up);
  });

  // ---------- dragging tabs ----------
  // Picking up a tab lifts it out of the bar onto a layer above the app: it follows the pointer at
  // its own size. The bar keeps an empty slot of exactly that width, which moves to where the tab
  // would land while the other tabs flow around it. Dropping on a pane's centre adds the tab to that
  // pane; on an edge it becomes a new pane there, which is drawn in advance. A thread row dragged
  // from the sidebar behaves the same way.
  let drag = null, ghost = null, origin = null, lift = null, press = null, swallow = false;
  const hint = el('<div class="drop"></div>');
  const zone = (r, e) => { const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height; if (x > .28 && x < .72 && y > .28 && y < .72) return 'c'; const d = { l: x, r: 1 - x, t: y, b: 1 - y }; return Object.keys(d).reduce((a, b) => d[b] < d[a] ? b : a); };
  const dropOk = pe => { if (!drag || !pe) return false; if (!drag.tab) return true; const x = findTab(drag.tab); return x && (x.g.id !== pe.dataset.pane || x.g.tabs.length > 1); };
  const liveTabs = el => $$('.tab:not(.dragging)', el);
  // move the slot in the DOM and let every tab glide from where it is drawn to where it now belongs
  function place(parent, before) {
    if (!ghost || (ghost.parentElement === parent && ghost.nextElementSibling === before)) return;
    const was = new Map($$('.pane .tabs .tab').map(t => [t, t.getBoundingClientRect().left]));
    if (parent) parent.insertBefore(ghost, before); else ghost.remove();
    for (const t of $$('.pane .tabs .tab')) {
      t.getAnimations().forEach(a => a.cancel());
      const dx = (was.has(t) ? was.get(t) : NaN) - t.getBoundingClientRect().left;
      if (dx) t.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { duration: 170, easing: 'cubic-bezier(.2, .8, .2, 1)' });
    }
  }
  const goHome = () => { if (origin && origin.src.isConnected) place(origin.tabs, origin.src); else place(null); };
  // keep the slot under the pointer within a bar: one neighbour at a time, by layout position
  function slot(bar, x) {
    const tabs = $('.tabs', bar), base = tabs.getBoundingClientRect().left - tabs.offsetLeft, mid = t => base + t.offsetLeft + t.offsetWidth / 2;
    if (ghost.parentElement !== tabs) { const o = liveTabs(tabs), i = x == null ? -1 : o.findIndex(t => x < mid(t)); return place(tabs, i < 0 ? null : o[i]); }
    if (x == null) return;
    for (let n = 0; n < 12; n++) {
      const o = liveTabs(tabs), i = o.indexOf(ghost), p = o[i - 1], nx = o[i + 1];
      if (p && x < mid(p)) place(tabs, p); else if (nx && x > mid(nx)) place(tabs, nx.nextElementSibling); else break;
    }
  }
  function begin(p) {
    const tb = p.src.matches('.tab') ? p.src : null;
    let m, src = tb;
    if (tb) { drag = { tab: tb.dataset.id }; m = tabMeta(findTab(tb.dataset.id).t); }
    else { const sid = p.src.dataset.sid, hit = shown(sid), s = sess(sid); drag = hit ? { tab: hit.t.id } : { sid }; m = { icon: s.harness, title: s.title }; src = hit ? $(`.pane .tab[data-id="${hit.t.id}"]`) : null; }
    drag.icon = m.icon;
    lift = el(`<div class="tab on lift">${ic(m.icon)}<span class="t">${esc(m.title)}</span></div>`);
    document.body.appendChild(lift);
    const r = src ? src.getBoundingClientRect() : null, w = r ? r.width : lift.offsetWidth;   // the lifted tab keeps the width it had
    lift.style.width = w + 'px';
    drag.dx = tb ? p.x - r.left : w / 2; drag.dy = tb ? p.y - r.top : 14;
    ghost = el('<div class="tab ghost"></div>'); ghost.style.width = w + 'px';                  // ...and so does the slot it leaves
    origin = src ? { tabs: src.parentElement, src } : null;
    if (src) { src.parentElement.insertBefore(ghost, src); src.classList.add('dragging'); }
    document.body.classList.add('dragging-tab');
  }
  function track(x, y) {
    lift.style.transform = `translate(${x - drag.dx}px, ${y - drag.dy}px)`;
    const under = document.elementFromPoint(x, y), bar = under && under.closest('.pane > .tb'), pe = under && under.closest('.pane');
    drag.over = null;
    if (bar) { hint.remove(); drag.z = null; slot(bar, x); drag.over = { bar, pe }; return; }
    if (!dropOk(pe)) { hint.remove(); drag.z = null; goHome(); return; }
    const r = pe.getBoundingClientRect(), z = zone(r, { clientX: x, clientY: y }), s = hint.style, tb = 40;
    if (z === 'c') slot($('.tb', pe), null);               // centre: it joins this pane's tabs and takes over the body
    else place(null);                                      // edge: it becomes its own pane in that half
    if (z !== drag.z || pe !== drag.pe) { drag.z = z; drag.pe = pe; hint.innerHTML = (z === 'c' ? '' : `<div class="tb"><div class="tabs"><div class="tab ghost" style="width:${ghost.style.width}"></div></div></div>`) + `<div class="dz">${ic(drag.icon, 'xl')}</div>`; }
    s.left = (z === 'r' ? r.left + r.width / 2 : r.left) + 'px'; s.top = (z === 'b' ? r.top + r.height / 2 : z === 'c' ? r.top + tb : r.top) + 'px';
    s.width = ('lr'.includes(z) ? r.width / 2 : r.width) + 'px'; s.height = ('tb'.includes(z) ? r.height / 2 : z === 'c' ? r.height - tb : r.height) + 'px';
    document.body.appendChild(hint); drag.over = { pe, z };
  }
  function finish(cancel) {
    const o = drag.over; hint.remove(); lift.remove(); document.body.classList.remove('dragging-tab');
    if (!cancel && o) {
      const tgt = P.get(o.pe.dataset.pane), same = drag.tab && findTab(drag.tab).g === tgt;
      const take = () => {   // lift the tab out of the model, as it already is on screen
        if (drag.sid) return T.thread(drag.sid);
        const x = findTab(drag.tab), t = x.t; x.g.tabs.splice(x.g.tabs.indexOf(t), 1);
        if (!x.g.tabs.length && x.g !== tgt) closePane(x.g); else if (x.g.active === t.id && x.g.tabs.length) x.g.active = x.g.tabs[0].id;
        return t;
      };
      if (o.bar) { const i = Math.max(0, liveTabs(o.bar).indexOf(ghost)), t = take(); tgt.tabs.splice(i, 0, t); activate(tgt, t); }
      else if (o.z === 'c') { if (!same) addTab(tgt, take()); }
      else { const t = take(), n = P.pane(t); P.splitAt(tgt.id, 'lr'.includes(o.z) ? 'row' : 'col', n, o.z === 'l' || o.z === 't'); S.focus = n.id; }
      S.pf = false;
    }
    drag = null; origin = null; lift = null; ghost = null;
    render();
  }
  document.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const src = e.target.closest('.pane .tab, .row[data-act=open]');
    press = src && !e.target.closest('.tx, .row-actions') ? { src, x: e.clientX, y: e.clientY } : null;
  });
  document.addEventListener('pointermove', e => {
    if (drag) { e.preventDefault(); return track(e.clientX, e.clientY); }
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 5) { const p = press; press = null; if (p.src.isConnected) { begin(p); track(e.clientX, e.clientY); } }
  });
  document.addEventListener('pointerup', () => { press = null; if (drag) { swallow = true; finish(false); setTimeout(() => { swallow = false; }, 0); } });
  document.addEventListener('click', e => { if (swallow) { e.stopPropagation(); e.preventDefault(); } }, true);   // the click that ends a drag is not a click
  document.addEventListener('keydown', e => { if (drag && e.key === 'Escape') { e.stopImmediatePropagation(); e.preventDefault(); finish(true); } }, true);

  // ---------- public surface for keys.js ----------
  window.App = {
    popOut, WS, Fly, Sett, fileStep, toast, sideKey, sideFocus, Move, Keys, Auth, bound, OS, isTerm, termEsc, everyTab, addNote, paintBk, runCmd(str) { const [n, ...a] = str.trim().split(/\s+/), c = CMDS.find(x => x[0] === n); if (c) c[2](a); },
    S, P, T, mach, sess, age, focused, cur, curTab, findTab, tabAt, render, renderStatus, refocus, send, split, shellTab, closeTab, focusDir, moveDir, resize, setView, tabStep,
    openThread, palette, fileSearch, cmdline, keysSheet, closeSheet, resolve, act, scene,
    rotate() { const path = P.path(focused().id); if (path && path.length) { const s = path[path.length - 1].s; s.dir = s.dir === 'row' ? 'col' : 'row'; render(); } },
    swapNext() { const ls = P.leaves(), i = ls.indexOf(focused()); if (ls.length > 1) { P.swap(ls[i], ls[(i + 1) % ls.length]); render(); } },
    cursor(d) { const o = S.order; if (!o.length) return; let i = o.indexOf(S.cursor); if (i < 0) { const t = cur(focused()); i = t.kind === 'thread' ? o.indexOf(t.sid) : -1; } S.cursor = o[Math.max(0, Math.min(o.length - 1, i + d))]; renderSide(); const c = $('#side .row.cur'); if (c) c.scrollIntoView({ block: 'nearest' }); },
    boot() { readVimrc(); scene(qs.get('scene') || location.hash.slice(1).replace(/^mac$/, 'home') || 'home'); narrow(); },
  };
})();
