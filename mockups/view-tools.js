/* Tool tabs: the diff viewer (Changes), the file list, the file inspector, and the vimrc editor.
   Their text carries data-src, so it can be selected and added to a chat like any message. */
(function () {
  const inl = s => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  const base = p => p.replace(/^.*\//, '');

  // Small Markdown renderer for file previews: headings, lists, paragraphs, inline code and bold.
  window.mdDoc = text => {
    const out = []; let list = null;
    const flush = () => { if (list) { out.push(`<${list.t}>${list.items.map(x => `<li>${inl(x)}</li>`).join('')}</${list.t}>`); list = null; } };
    const item = (t, x) => { if (!list || list.t !== t) { flush(); list = { t, items: [] }; } list.items.push(x); };
    for (const line of text.split('\n')) {
      let m;
      if ((m = /^(#{1,3}) (.*)/.exec(line))) { flush(); out.push(`<h${m[1].length}>${inl(m[2])}</h${m[1].length}>`); }
      else if ((m = /^\d+\. (.*)/.exec(line))) item('ol', m[1]);
      else if ((m = /^- (.*)/.exec(line))) item('ul', m[1]);
      else if (!line.trim()) flush();
      else { flush(); out.push(`<p>${inl(line)}</p>`); }
    }
    flush(); return out.join('');
  };

  const SCOPE = { turn: 'Last agent turn', uncommitted: 'Uncommitted', staged: 'Staged', unstaged: 'Unstaged', all: 'All changes' };
  const SCOPE_IC = { turn: 'retry', uncommitted: 'diff', staged: 'check', unstaged: 'pencil', all: 'layers' };
  const row = (k, n, s, key) => `<div class="dl ${k === '+' ? 'add' : k === '-' ? 'del' : ''}"${key ? ` data-gk="${key}"` : ''}><span class="n">${n}</span><span class="c">${esc(s)}</span></div>`;
  // a diff with its unchanged runs folded: "12 unmodified lines" opens in place (click, or enter on the row)
  const lines = (d, t, path) => d.map((r, i) => {
    if (r[0] !== '~') return row(...r);
    const key = path + ':' + i, from = r[1], ls = r[2];
    if ((t.gaps || []).includes(key)) return ls.map((x, j) => row(' ', from + j, x, key)).join('');
    return `<button class="dgap" data-act="gapOpen" data-k="${esc(key)}" title="Show ${ls.length} unmodified lines">${ic('down', 'sm')}<span>${ls.length} unmodified line${ls.length > 1 ? 's' : ''}</span></button>`;
  }).join('');
  const LANG = { ts: ['TS', 'ts'], tsx: ['TSX', 'ts'], js: ['JS', 'js'], json: ['{ }', 'json'], css: ['CSS', 'css'], sql: ['SQL', 'sql'], md: ['MD', 'md'] };
  const lang = p => { const l = LANG[(p.split('.').pop() || '').toLowerCase()] || ['', '']; return l[0] ? `<span class="lang ${l[1]}">${l[0]}</span>` : ic('file'); };
  const cbox = (on, act, path, label) => `<button class="cb ${on === 'mix' ? 'mix' : on ? 'on' : ''}" role="checkbox" aria-checked="${on === 'mix' ? 'mixed' : !!on}" aria-label="${esc(label)}" data-act="${act}"${path != null ? ` data-p="${esc(path)}"` : ''}>${on && on !== 'mix' ? ic('check') : ''}</button>`;
  const counts = set => [set.reduce((a, f) => a + f.add, 0), set.reduce((a, f) => a + f.del, 0)];
  const nums = ([a, d], cls = '') => `<span class="nums ${cls}"><span class="c-add">+${a}</span><span class="c-del">−${d}</span></span>`;

  // A small highlighter for the mock: comments, strings, numbers, keywords, types. Leading spaces become indent guides.
  const KW = /^(import|from|export|const|let|var|function|async|await|return|if|else|for|while|try|catch|finally|new|type|interface|class|extends|typeof|of|in|true|false|null|undefined|test|expect)$/;
  const hl = (line, path) => {
    if (!/\.(ts|tsx|js|json|css|sql)$/.test(path)) return esc(line);
    const ind = /^ */.exec(line)[0].length, g = Math.floor(ind / 2);
    let out = g ? `<span class="ig">${'<i>  </i>'.repeat(g)}</span>${' '.repeat(ind - g * 2)}` : ' '.repeat(ind);
    const rest = line.slice(ind), re = /(\/\/.*$)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`[^`]*`)|(\b\d[\d_.]*\b)|([A-Za-z_$][\w$]*)|([^A-Za-z_$\d'"`\/]+|\/)/g;
    let m; while ((m = re.exec(rest))) {
      const [x, cm, st, nu, id] = m;
      out += cm ? `<span class="sx-c">${esc(x)}</span>` : st ? `<span class="sx-s">${esc(x)}</span>` : nu ? `<span class="sx-n">${esc(x)}</span>`
        : id ? (KW.test(id) ? `<span class="sx-k">${id}</span>` : /^[A-Z]/.test(id) ? `<span class="sx-t">${id}</span>` : rest[re.lastIndex] === '(' ? `<span class="sx-f">${id}</span>` : esc(id)) : esc(x);
    }
    return out;
  };

  window.Tools = {
    SCOPE, SCOPE_IC, counts, nums, lang,
    scopeLabel(t) {
      if (SCOPE[t.scope]) return SCOPE[t.scope];
      const [a, b] = t.range, c = D.commits;   // newest first
      return a === 0 && b === c.length - 1 ? 'All commits' : a === b ? c[a][0] : `${c[b][0]}^..${c[a][0]}`;   // inclusive of the oldest: in git, A..B leaves A out
    },
    // every file with work in it (mock: the thread's edits, the new test, and the rest of the checkout's uncommitted work)
    allFiles(t, s) {
      const eds = (s ? s.events : []).filter(e => e.t === 'tool' && e.name === 'Edit' && e.diff).map(e => ({ path: e.arg, add: e.add, del: e.del, diff: e.diff }));
      const extra = (s && D.extraChanges[s.id]) || [];
      return [...eds, { path: 'sessions/restore.test.ts', add: D.newTest.length, del: 0, isNew: true, diff: D.newTest }, ...extra].filter(f => !(t.reverted || []).includes(f.path));
    },
    // which files a scope shows
    changeSet(t, s, scope = t.scope) {
      const all = Tools.allFiles(t, s), st = t.staged || [];
      if (scope === 'staged') return all.filter(f => st.includes(f.path));
      if (scope === 'unstaged') return all.filter(f => !st.includes(f.path));
      if (scope === 'turn' || (scope === 'c:range' && t.range[0] === t.range[1])) return all.slice(0, 1);
      return all;
    },
    // the commit button names what it will do: off the default branch it commits; on it, it makes a branch first
    commitLabel: s => (!s || /^(main|master)$/.test(s.branch) ? 'Create branch & commit' : 'Commit'),
    changes(t, s) {
      const set = Tools.changeSet(t, s), st = t.staged || [], q = (t.tq || '').toLowerCase();
      const tree = !t.treeHidden;
      // the file tree: folders, then files, each with its stage box, counts and what happened to it
      const shown = set.filter(f => !q || f.path.toLowerCase().includes(q));
      const dirs = [...new Set(shown.map(f => f.path.includes('/') ? f.path.replace(/\/[^/]*$/, '') : ''))].sort((a, b) => (a === '') - (b === '') || a.localeCompare(b));
      const fileRow = (f, d) => `<div class="tf${d ? ' in' : ''}">${cbox(st.includes(f.path), 'stageFile', f.path, 'Stage ' + f.path)}<button class="tfn" data-act="jumpFile" data-p="${esc(f.path)}" title="${esc(f.path)}">${lang(f.path)}<span class="t">${esc(base(f.path))}</span></button>${nums([f.add, f.del], 'sm')}<span class="fst ${f.isNew ? 'a' : 'm'}" title="${f.isNew ? 'Added' : 'Modified'}"></span></div>`;
      const allOn = set.length && set.every(f => st.includes(f.path)), someOn = set.some(f => st.includes(f.path));
      const treeHtml = `<aside class="ctree" aria-label="Changed files">
          <label class="tq">${ic('search', 'sm')}<input data-input="tq" placeholder="Search files" value="${esc(t.tq || '')}" aria-label="Search changed files"></label>
          <div class="tf all">${cbox(allOn ? true : someOn ? 'mix' : false, 'stageAll', null, 'Stage all')}<span class="t">${set.length} file${set.length === 1 ? '' : 's'} changed</span></div>
          ${dirs.map(d => (d ? `<div class="td">${ic('down', 'sm')}<span>${esc(d)}</span></div>` : '') + shown.filter(f => (f.path.includes('/') ? f.path.replace(/\/[^/]*$/, '') : '') === d).map(f => fileRow(f, d)).join('')).join('')}
          ${q && !shown.length ? '<div class="tf none">No matching files</div>' : ''}
        </aside>`;
      const files = set.map(f => `<details class="cfile" open data-p="${esc(f.path)}"><summary>${ic('chev', 'ch')}${lang(f.path)}<span class="f">${esc(f.path)}</span>${nums([f.add, f.del])}${f.isNew ? '<span class="tag">New</span>' : ''}<span class="sp"></span>
            <button class="ib sm" data-act="revertFile" data-p="${esc(f.path)}" title="Revert file">${ic('retry')}</button>${cbox(st.includes(f.path), 'stageFile', f.path, 'Stage ' + f.path)}</summary>
          <div class="diff flat" data-src="diff:${esc(f.path)}">${lines(f.diff, t, f.path)}</div></details>`).join('');
      const label = Tools.commitLabel(s);
      return `<div class="tool-h">
          <button class="chip" data-act="pickScope" title="What to compare">${ic(t.scope.startsWith('c:') ? 'branch' : SCOPE_IC[t.scope] || 'diff')}<span>${esc(Tools.scopeLabel(t))}</span>${nums(counts(set))}${ic('down', 'sm')}</button>
          <button class="chip" title="Branch">${ic('branch')}<span>${esc(s ? s.branch : 'main')}</span>${ic('down', 'sm')}</button>
          <span class="sp"></span><button class="ib sm" title="More">${ic('dots')}</button>
          <span class="split"><button class="btn primary sm" data-act="commit">${label}</button><button class="btn primary sm caret" data-act="commitMenu" aria-haspopup="menu" aria-label="More commit actions">${ic('down', 'sm')}</button></span>
          <button class="ib sm ${tree ? 'on' : ''}" data-act="toggleTree" title="Changed files" aria-pressed="${tree}">${ic('panelR')}</button></div>
        <div class="cbody ${tree ? 'tree' : ''}">
          <div class="tool-b" data-read>${set.length ? files : `<div class="r-empty">${ic('diff', 'xl')}<span>${t.scope === 'staged' ? 'Nothing staged yet' : 'No changes'}</span></div>`}</div>
          ${tree ? treeHtml : ''}</div>`;
    },
    files(t) {
      const row = (p, cls) => `<button class="rf ${cls}" data-act="openFile" data-p="${esc(p)}">${ic('file')}${esc(base(p))}</button>`;
      const dir = d => `<div class="rf dir">${ic('folder')}${d}</div>${D.files.filter(x => x.startsWith(d + '/')).map(p => row(p, 'in')).join('')}`;
      return `<div class="tool-b">${D.files.filter(x => !x.includes('/')).map(p => row(p, '')).join('')}${dir('sessions')}${dir('ui')}</div>`;
    },
    // A file: rendered preview for Markdown, numbered source for everything. It is read like any other text
    // (cursor, visual mode, quoting into a chat) until you press an editing key; then the source becomes a
    // field at that spot, with the same NORMAL / INSERT as a composer. :w or Save writes it; esc from NORMAL
    // goes back to reading. Unsaved text stays with the tab and is what Preview shows.
    // a file's text: its mock content, else what its diff says the new version holds, else a stub
    docText: path => {
      if (D.docs[path]) return D.docs[path];
      const f = Object.values(D.extraChanges).flat().find(x => x.path === path) || (path === 'sessions/restore.test.ts' ? { diff: D.newTest } : null);
      if (f) return f.diff.flatMap(r => (r[0] === '~' ? r[2] : r[0] === '-' ? [] : [r[2]])).join('\n');
      return `// ${path}\n// Mock file: no content in the mockup.`;
    },
    // lines that differ from the last commit, for the gutter bars: added (green) or changed (amber)
    marks(t, s) {
      const f = Tools.allFiles(t, s).find(x => x.path === t.path), m = {};
      if (!f || D.docs[t.path]) return m;   // the restore.ts mock text and its diff do not share line numbers
      f.diff.forEach((r, i) => { if (r[0] === '+') m[r[1]] = f.diff.some(x => x[0] === '-' && x[1] === r[1]) || (f.diff[i - 1] && f.diff[i - 1][0] === '-') ? 'g-chg' : 'g-add'; });
      return m;
    },
    text: t => (t.buf != null ? t.buf : Tools.docText(t.path)),
    dirty: t => t.buf != null && t.buf !== Tools.docText(t.path),
    file(t, s) {
      const text = Tools.text(t), lines = text.split('\n');
      const isMd = /\.md$/.test(t.path), edit = t.mode === 'edit', preview = isMd && !edit && t.mode !== 'source';
      const hist = t.hist || [t.path], hi = t.hi ?? hist.length - 1, tree = !t.treeHidden, marks = Tools.marks(t, s);
      // breadcrumb: the project, each folder (opens a list of what is in it), the file
      const parts = t.path.split('/'), proj = s ? s.dir.replace(/^.*\//, '') : 'project';
      const crumb = [`<button class="crumb" data-act="crumb" data-d="">${esc(proj)}</button>`, ...parts.slice(0, -1).map((d, i) => `<button class="crumb" data-act="crumb" data-d="${esc(parts.slice(0, i + 1).join('/'))}">${esc(d)}</button>`), `<span class="crumb now">${esc(parts[parts.length - 1])}</span>`].join(ic('chev', 'sep'));
      return `<div class="tool-h ${Tools.dirty(t) ? 'dirty' : ''}">
          <button class="ib sm" data-act="fileBack" title="Back · ctrl-o" ${hi > 0 ? '' : 'disabled'}>${ic('chev', 'flip')}</button><button class="ib sm" data-act="fileFwd" title="Forward · ctrl-i" ${hi < hist.length - 1 ? '' : 'disabled'}>${ic('chev')}</button>
          <nav class="crumbs" aria-label="Path">${crumb}</nav><span class="mod dim">Modified</span><span class="sp"></span>
          <button class="btn sm mod" data-act="fileSave" title="Save · :w">Save</button>
          ${isMd ? `<div class="seg txt"><button class="${preview ? 'on' : ''}" data-act="fileMode" data-v="preview">Preview</button><button class="${preview ? '' : 'on'}" data-act="fileMode" data-v="source">Source</button></div>` : ''}
          <button class="ib sm" title="Find in file">${ic('search')}</button>
          <button class="ib sm ${tree ? 'on' : ''}" data-act="toggleTree" title="Project files" aria-pressed="${tree}">${ic('panelR')}</button></div>
        <div class="cbody ${tree ? 'tree' : ''}"><div class="tool-b" data-read>${edit ? `<div class="ed"><pre class="ed-n">${lines.map((l, i) => i + 1).join('\n')}</pre><textarea class="rc-ed file-ed" data-input="file" spellcheck="false" wrap="off" rows="${lines.length}">${esc(text)}</textarea></div>`
          : preview ? `<article class="doc prose" data-src="file:${esc(t.path)}">${mdDoc(text)}</article>`
          : `<div class="src" data-src="file:${esc(t.path)}">${lines.map((l, i) => `<div class="dl ${marks[i + 1] || ''}"><span class="n">${i + 1}</span><span class="c">${hl(l, t.path) || ' '}</span></div>`).join('')}</div>`}</div>
          ${tree ? Tools.projTree(t, s) : ''}</div>`;
    },
    // the whole project, folders first; the open file picked out, ignored folders dimmed, uncommitted work marked
    projTree(t, s) {
      const ch = {}; Tools.allFiles(t, s).forEach(f => { ch[f.path] = f.isNew ? 'A' : 'M'; });
      const all = [...new Set([...D.files, ...Object.keys(ch)])];
      const dirs = [...new Set(all.filter(p => p.includes('/')).map(p => p.replace(/\/[^/]*$/, '')))].sort();
      const fr = (p, d) => `<button class="tf pf${d ? ' in' : ''}${p === t.path ? ' on' : ''}" data-act="fileGo" data-p="${esc(p)}" title="${esc(p)}">${lang(p)}<span class="t">${esc(base(p))}</span>${ch[p] ? `<span class="gst ${ch[p].toLowerCase()}" title="${ch[p] === 'A' ? 'Added' : 'Modified'}">${ch[p]}</span>` : ''}</button>`;
      const open = t.closed || [];
      return `<aside class="ctree" aria-label="Project files"><div class="tf root">${esc(s ? s.dir.replace(/^.*\//, '') : 'project')}</div>
        ${['.git', 'dist', 'node_modules'].map(d => `<div class="td ign">${ic('folder', 'sm')}<span>${d}</span></div>`).join('')}
        ${dirs.map(d => `<button class="td" data-act="dirFold" data-d="${esc(d)}" aria-expanded="${!open.includes(d)}">${ic(open.includes(d) ? 'folder' : 'folderOpen', 'sm')}<span>${esc(d)}</span></button>${open.includes(d) ? '' : all.filter(p => p.replace(/\/[^/]*$/, '') === d && p.includes('/')).sort().map(p => fr(p, true)).join('')}`).join('')}
        ${all.filter(p => !p.includes('/')).sort().map(p => fr(p, false)).join('')}</aside>`;
    },
    vimrc() {
      return `<div class="tool-h"><span class="path">~/.config/skein/vimrc</span><span class="sp"></span><span class="dim">applies as you type</span></div>
        <div class="tool-b"><textarea class="rc-ed" data-input="vimrc" spellcheck="false">${esc(S.vimrc)}</textarea></div>`;
    },
  };
})();
