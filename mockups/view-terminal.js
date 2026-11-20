/* Terminal view: renders a session's events the way the harness TUI prints them.
   In the real app this pane is an xterm.js terminal attached to the harness process, and the program owns
   its input line (G1): every key goes to it. Skein draws only a few overlays of its own on top, in the app's
   font rather than the terminal's: the Claude Code handoff, image uploads, and the SSH link state.

   How each harness gets here (from the tech spike):
     Codex        the TUI attaches to the same app-server the chat view uses (codex --remote), so both views are live.
     Claude Code  one view drives the thread at a time (G4). Chat drives through the Agent SDK; showing the terminal
                  waits for the turn to end, then runs `claude --resume <id>`. Chat then mirrors it read-only. */
(function () {
  const inl = s => esc(s).replace(/`([^`]+)`/g, '<span class="t-code">$1</span>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  const short = p => p.replace(/^.*\//, '');

  const diffLines = d => d.map(([k, n, s]) =>
    `<div class="t-dl ${k === '+' ? 'add' : k === '-' ? 'del' : ''}"><span class="n">${n}</span><span class="k">${k}</span>${esc(s)}</div>`).join('');

  // Per-harness glyphs and phrasing.
  const skin = {
    claude: {
      user: '❯', dot: '●', elbow: '⎿',
      tool(e) {
        if (e.name === 'Edit') return [`<b>Update</b>(${esc(e.arg)})`, `Updated ${esc(e.arg)} with ${e.add} addition${e.add === 1 ? '' : 's'} and ${e.del} removal${e.del === 1 ? '' : 's'}`];
        if (e.name === 'Bash') return [`<b>Bash</b>(${esc(e.arg)})`, e.out || e.meta || ''];
        if (e.name === 'Grep') return [`<b>Search</b>(pattern: "${esc(e.arg)}")`, `Found ${e.meta}`];
        return [`<b>Read</b>(${esc(e.arg)})`, `Read ${e.meta}`];
      },
      todoHead: '<b>Update Todos</b>', box: { done: '☒', now: '☐', todo: '☐' },
      live: e => `<span class="c-claude t-star">✻</span> ${esc(e.text)}… <span class="dim">(${e.dur} · ↓ 1.2k tokens · esc to interrupt)</span>`,
    },
    codex: {
      user: '›', dot: '•', elbow: '└',
      tool(e) {
        if (e.name === 'Edit') return [`<b>Edited</b> ${esc(e.arg)} <span class="dim">(</span><span class="c-add">+${e.add}</span> <span class="c-del">-${e.del}</span><span class="dim">)</span>`, ''];
        if (e.name === 'Bash') return [`<b>Ran</b> ${esc(e.arg)}`, e.out || e.meta || ''];
        if (e.name === 'Grep') return ['<b>Explored</b>', `Search ${esc(e.arg)}`];
        return ['<b>Explored</b>', `Read ${esc(short(e.arg))}`];
      },
      todoHead: '<b>Updated Plan</b>', box: { done: '✔', now: '□', todo: '□' },
      live: e => `<span class="t-star">•</span> ${esc(e.text)} <span class="dim">(${e.dur} • esc to interrupt)</span>`,
    },
  };

  function event(e, k, s) {
    switch (e.t) {
      case 'user': {
        const chips = (e.images || []).map((_, i) => `<span class="t-chip">[Image #${i + 1}]</span> `).join('');
        const imgs = (e.images || []).map(u => `<img class="t-img" src="${u}" data-zoom alt="">`).join('');
        return `<div class="t-user"><span class="pr">${k.user}</span><span>${chips}${inl(Tok.strip(e.text))}</span></div>${imgs}`;
      }
      case 'agents': return e.ids.map(id => (s.subs || []).find(g => g.id === id)).filter(Boolean).map(g =>
        `<div class="t-ev"><span class="b ${g.status === 'running' ? '' : 'c-add'}">${k.dot}</span><span><b>Task</b>(${esc(g.name)}: ${esc(g.task)})</span></div><div class="t-sub"><span class="el">${k.elbow}</span><span>${g.status === 'running' ? 'Running… ' + g.dur : 'Done (' + g.dur + ')'}</span></div>`).join('');
      case 'plan': return `<div class="t-ev"><span class="b c-add">${k.dot}</span><span><b>${s.harness === 'claude' ? 'Write' : 'Added'}</b>${s.harness === 'claude' ? '(' + esc(e.file) + ')' : ' ' + esc(e.file)}</span></div><div class="t-sub"><span class="el">${k.elbow}</span><span>Plan ready. Approve to start, or reply with changes.</span></div>`;
      case 'text': return `<div class="t-ev"><span class="b">${k.dot}</span><span>${inl(e.text)}</span></div>`;
      case 'tool': {
        const [head, sub] = k.tool(e);
        const dot = `<span class="b ${e.name === 'Edit' || e.name === 'Bash' ? 'c-add' : ''}">${k.dot}</span>`;
        let body = sub ? `<div class="t-sub"><span class="el">${k.elbow}</span><span>${esc(sub)}</span></div>` : '';
        if (e.diff) body += `<div class="t-diff">${diffLines(e.diff)}</div>`;
        return `<div class="t-ev">${dot}<span>${head}</span></div>${body}`;
      }
      case 'todo':
        return `<div class="t-ev"><span class="b">${k.dot}</span><span>${k.todoHead}</span></div>` + e.items.map(([st, tx], i) =>
          `<div class="t-sub is-${st}"><span class="el">${i ? ' ' : k.elbow}</span><span>${k.box[st]} ${esc(tx)}</span></div>`).join('');
      case 'image':
        return `<div class="t-ev"><span class="b">${k.dot}</span><span><b>${s.harness === 'claude' ? 'Read' : 'Viewed Image'}</b>${s.harness === 'claude' ? '(' + esc(e.cap) + ')' : ' ' + esc(e.cap)}</span></div><img class="t-img" src="${e.img}" data-zoom alt="">`;
      case 'worked': return `<div class="t-rule"><span>Worked for ${e.dur}</span></div>`;
      case 'err': return Term.err(e, s, k);
      case 'interrupted': return s.harness === 'claude'
        ? `<div class="t-sub"><span class="el">${k.elbow}</span><span><span class="c-del">Interrupted</span> <span class="dim">· What should Claude do instead?</span></span></div>`
        : `<div class="t-ev"><span class="b c-del">■</span><span>Conversation interrupted <span class="dim">- tell the model what to do differently</span></span></div>`;
      case 'live': return `<div class="t-live">${k.live(e)}</div>`;
      default: return '';
    }
  }

  function approval(e, s) {
    const claude = s.harness === 'claude', all = s.events.filter(x => x.t === 'approval'), more = all.length > 1 ? ` <span class="dim">(1 of ${all.length}${e.from ? ' · ' + esc(e.from) : ''})</span>` : '';
    const opts = claude
      ? ['Yes', "Yes, and don't ask again for <b>pnpm</b> commands", 'No, and tell Claude what to do differently <span class="dim">(esc)</span>']
      : ['Yes, proceed <span class="dim">(y)</span>', "Yes, and don't ask again for this command <span class=\"dim\">(a)</span>", 'No, and tell Codex what to do differently <span class="dim">(esc)</span>'];
    return `<div class="t-appr">
      <div><b>${claude ? 'Bash command' : 'Would you like to run the following command?'}</b>${more}</div>
      <div class="ind">${claude ? '' : '<span class="dim">$ </span>'}${esc(e.cmd)}</div>
      <div class="ind dim">${esc(e.why)}</div>
      ${claude ? '<div>Do you want to proceed?</div>' : ''}
      ${opts.map((o, i) => `<div class="t-opt ${i ? '' : 'sel'}" data-act="${i === 2 ? 'deny' : 'approve'}"><span class="pr">${i ? ' ' : (claude ? '❯' : '›')}</span><span>${i + 1}. ${o}</span></div>`).join('')}
    </div>`;
  }

  // the command Skein ran in this pty: Claude Code resumes the SDK's session, Codex attaches to the app-server
  const launch = s => `<div class="t-launch dim">${s.harness === 'claude' ? `claude --resume ${s.uuid || sid(s)}` : `codex --remote unix://~/.skein/run/${s.id}.sock`}</div>`;
  const sid = s => (s.uuid = ('4f2a91c0-' + s.id + '000-7b3e-9d1c').slice(0, 23) + '…');
  function banner(s) {
    return s.harness === 'claude'
      ? `<div class="t-banner"><span class="c-claude">✻</span> <b>Claude Code</b> <span class="dim">${esc(s.model)} · ${esc(s.dir)}</span></div>`
      : `<div class="t-banner"><b>&gt;_ OpenAI Codex</b> <span class="dim">${esc(s.model.toLowerCase())} ${esc(s.effort.toLowerCase())} · ${esc(s.dir)}</span></div>`;
  }

  // An image pasted into a terminal reaches the program as a file path, which the TUI turns into [Image #n].
  // Over SSH Skein uploads the file first and pastes the remote path once it is there (G14).
  function upload(pane) {
    const u = pane.paste; if (!u) return '';
    if (u.state === 'up') return `<div class="t-over" role="status">${ic('upload')}<span>Uploading <b>${esc(u.name)}</b> to ${esc(u.host)}</span><span class="bar"><i style="width:${u.pct}%"></i></span><span class="dim">${u.pct}%</span></div>`;
    if (u.state === 'fail') return `<div class="t-over bad kbrow" role="alert">${ic('alert')}<span>Couldn't upload <b>${esc(u.name)}</b>: ${esc(u.host)} disconnected</span><span class="sp"></span><button class="btn sm" data-act="pasteDrop" data-esc>Discard</button><button class="btn sm primary" data-act="pasteRetry">Retry</button></div>`;
    return '';
  }
  function prompt(pane, s) {
    const chips = pane.atts.map((a, i) => `<span class="t-chip" title="${esc(a.name)}">[Image #${i + 1}]</span>`).join('')
      + (pane.paste && pane.paste.state === 'path' ? `<span class="t-path">${esc(pane.paste.path)}</span>` : '');
    const thumbs = pane.atts.length ? `<div class="t-atts">${pane.atts.map(a => `<img src="${a.url}" data-zoom alt="">`).join('')}</div>` : '';
    const usage = `<button class="term-context" data-act="contextUsage" data-sid="${s.id}" title="Context usage: ${s.ctx}% used, ${100 - s.ctx}% available">${100 - s.ctx}% context left</button>`;
    const foot = s.harness === 'claude'
      ? `<span>⏵⏵ ${esc(s.perm.toLowerCase())} <span class="dim">(shift+tab to cycle)</span></span>${usage}`
      : `<span class="dim">${esc(s.model.toLowerCase())} ${esc(s.effort.toLowerCase())} · ${usage} · ${esc(s.dir)}</span>`;
    return `${thumbs}${upload(pane)}<div class="t-prompt ${s.harness}"><span class="pr">${skin[s.harness].user}</span>${chips}
      <input data-input="draft" spellcheck="false" autocomplete="off" value="${esc(pane.draft)}" placeholder="${s.events.length ? '' : (s.harness === 'claude' ? 'Try "fix the failing test"' : 'Ask Codex to do anything')}"></div>
      <div class="tui-menu" data-menu-host></div>
      <div class="t-foot">${foot}</div>`;
  }

  window.Term = {
    // errors as each TUI prints them; a crash ends the process, so the prompt gives way to an exit line
    err(e, s, k) {
      const claude = s.harness === 'claude';
      const txt = { rate: claude ? 'API Error: 429 · Rate limit reached. Resets at 3:40 PM.' : 'stream error: rate limit exceeded (429). Try again at 3:40 PM.',
        context: claude ? 'Context low · auto-compacting the conversation' : 'Context window is full. Run /compact to continue.',
        auth: claude ? 'Invalid API key · Please run /login' : 'Not signed in. Run codex login.',
        crash: claude ? 'Claude Code exited unexpectedly' : 'codex exited unexpectedly',
        missing: '' }[e.kind];
      return txt ? `<div class="t-sub"><span class="el">${k.elbow}</span><span class="${e.kind === 'context' ? 'dim' : 'c-del'}">${esc(txt)}</span></div>` : '';
    },
    session(pane, s) {
      const k = skin[s.harness];
      if (s.harness === 'claude' && s.drive !== 'term') return Term.handoff(pane, s);
      const pending = s.events.find(e => e.t === 'approval');
      const back = pane.scrollback ? Term.lines(pane.scrollback) : '';
      const crash = s.events.find(e => e.t === 'err' && e.kind === 'crash');
      return `<div class="term ${s.starting ? 'starting' : ''}" data-scroll data-read data-src="term:${pane.id}">${back}${pane.scrollback ? '' : launch(s)}${banner(s)}
        ${s.events.filter(e => e.t !== 'approval').map(e => event(e, k, s)).join('')}
        ${crash ? `<div class="t-exit kbrow"><span class="dim">[process exited with code 1]</span><button class="btn sm primary" data-act="errFix" data-k="crash">Restart</button></div>` : pending ? approval(pending, s) : prompt(pane, s)}
        ${Term.link(s)}</div>`;
    },
    // Claude Code: chat is driving, so the terminal waits for the turn to end (or for you to interrupt it)
    handoff(pane, s) {
      const busy = s.status === 'running' || s.events.some(e => e.t === 'approval' || e.t === 'plan');
      const why = s.events.some(e => e.t === 'approval' || e.t === 'plan') ? 'Answer the request in chat first' : 'Opens when this turn finishes';
      return `<div class="term handoff-wrap"><div class="handoff kbrow" role="status">
          <div class="hf-ic">${ic('claude', 'xl')}</div>
          <b>${s.pend === 'term' && busy ? '<span class="spin"></span>' + why : 'Opening in Claude Code'}</b>
          <span class="dim">${s.pend === 'term' && busy ? 'Chat keeps driving this thread until then.' : `claude --resume ${esc(s.uuid || sid(s))}`}</span>
          ${s.pend === 'term' && busy ? `<div class="hf-b"><button class="btn sm" data-act="setView" data-v="chat" data-esc>Back to chat</button>${s.status === 'running' ? '<button class="btn sm primary" data-act="handNow">Interrupt and open</button>' : ''}</div>` : '<span class="spin"></span>'}
        </div></div>`;
    },
    // the SSH link, drawn over the bottom of the terminal while it is not up (G5)
    link(s) {
      const m = App.mach(s.machine); if (!m || !m.ssh || !m.link || m.link === 'up') return '';
      return `<div class="t-over link" role="status"><span class="dot amber pulse"></span><span>${m.link === 'reconnecting' ? `Reconnecting to <b>${esc(m.name)}</b>. The turn keeps running there.` : `Connecting to <b>${esc(m.name)}</b>`}</span></div>`;
    },
    ps1(m, dir) {
      return m.ssh ? `<span class="c-add">${esc(m.addr.split('@')[0])}@${esc(m.name)}</span>:<span class="c-blue">${esc(dir)}</span>$`
        : window.OS === 'mac' ? `<span class="c-add">joshua@mac</span> <span class="c-blue">${esc(dir.replace(/^.*\//, ''))}</span> %`
        : `<span class="dim">PS</span> ${esc(dir.replace(/\//g, '\\'))}&gt;`;
    },
    lines(ls) {
      return ls.map(l => `<div class="sh-l">${l.ps ? l.ps + ' ' : ''}${l.html || esc(l.text)}</div>`).join('');
    },
    shell(pane, m) {
      return `<div class="term" data-scroll data-read data-src="term:${pane.id}">${Term.lines(pane.lines)}
        <div class="sh-l sh-in"><span>${Term.ps1(m, pane.dir)}</span><input data-input="shell" spellcheck="false" autocomplete="off" value="${esc(pane.draft)}"></div></div>`;
    },
  };
})();
