/* Chat view: the same thread events, rendered as a rich thread with a composer.
   In the real app this is driven by the Claude Agent SDK / Codex app-server. */
(function () {
  const verb = { Read: 'Read', Edit: 'Edited', Bash: 'Ran', Grep: 'Searched' };
  const toolIcon = { Read: 'file', Edit: 'diff', Bash: 'terminal', Grep: 'search' };
  const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);

  const diff = d => `<div class="diff">${d.map(([k, n, s]) =>
    `<div class="dl ${k === '+' ? 'add' : k === '-' ? 'del' : ''}"><span class="n">${n}</span><span class="c">${esc(s)}</span></div>`).join('')}</div>`;

  // c: { tab, s, key } — key(i) names an event so selections in it can be quoted; main threads also anchor side chats.
  function event(e, i, c) {
    const src = `data-src="${c.key(i)}"`;
    switch (e.t) {
      case 'user': {
        // editing: the message turns into the normal composer, in place (so the model can be changed too)
        if (c.tab.edit && c.tab.edit.i === i) {
          // resending rewinds the thread to here; side chats that branch from later replies stay, unlinked (G8)
          const later = c.main ? (c.s.sides || []).filter(x => x.at > i).length : 0;
          return `<div class="m-edit" data-user>${Chat.composer(c.tab.edit, c.s, { placeholder: 'Edit message' })}${later ? `<div class="edit-note">${ic('branch')}<span>Resending keeps ${later === 1 ? 'the side chat' : 'the ' + later + ' side chats'} from later replies, unlinked</span></div>` : ''}</div>`;
        }
        const imgs = (e.images || []).map(u => `<img class="m-img" src="${u}" data-zoom alt="">`).join('');
        return `<div class="m-user can-edit" data-user ${src} data-act="edit" data-ev="${i}" title="Click to edit and resend">${imgs}${e.text ? `<div>${Tok.html(md(e.text, true))}</div>` : ''}</div>`;
      }
      case 'text': {
        const sides = c.main ? (c.s.sides || []).filter(x => x.at === i) : [];
        return `<div class="m-asst prose" ${src}>${md(e.text)}</div>`
          + (sides.length ? `<div class="sc-links">${sides.map(x => `<button class="sc-link" data-act="sideOpen" data-sid="${c.s.id}" data-sc="${x.id}">${ic('chat')}<span>${esc(x.title)}</span></button>`).join('')}</div>` : '');
      }
      case 'tool': {
        const meta = e.name === 'Edit' ? `<span class="c-add">+${e.add}</span> <span class="c-del">−${e.del}</span>` : esc(e.meta || '');
        const body = e.diff ? diff(e.diff) : e.out ? `<pre class="out">${esc(e.out)}</pre>` : '';
        const head = `${ic(toolIcon[e.name])}<span class="v">${verb[e.name]}</span>${e.name === 'Read' || e.name === 'Edit' ? `<code class="flink" data-act="openFile" data-p="${esc(e.arg)}" title="Open ${esc(e.arg)} · g f">${esc(e.arg)}</code>` : `<code>${esc(e.arg)}</code>`}<span class="meta">${meta}</span>`;
        return body ? `<details class="tool" ${src}${e.diff ? ' open' : ''}><summary>${head}${ic('chev', 'ch')}</summary>${body}</details>`
          : `<div class="tool" ${src}><div class="sum">${head}</div></div>`;
      }
      case 'todo':
        return `<div class="todo" ${src}>${e.items.map(([st, tx]) => `<div class="ti is-${st}"><span class="box">${st === 'done' ? ic('check') : ''}</span>${esc(tx)}</div>`).join('')}</div>`;
      case 'image': return `<figure class="m-fig"><img src="${e.img}" data-zoom alt=""><figcaption>${esc(e.cap)}</figcaption></figure>`;
      case 'worked': return `<div class="worked">Worked for ${e.dur} ${ic('chev')}</div>`;
      case 'interrupted': return `<div class="note-row" ${src}>${ic('stop')}<span>Interrupted</span></div>`;
      case 'live': return `<div class="live"><span class="spin"></span><span>${esc(e.text)}</span><span class="dim">${e.dur}</span></div>`;
      case 'agents': {   // subagents this turn started: one row each, click to open its transcript in a popup
        const gs = e.ids.map(id => (c.s.subs || []).find(g => g.id === id)).filter(Boolean), run = gs.filter(g => g.status === 'running').length;
        return `<details class="tool agents" open><summary>${ic('agent')}<span class="v">Subagents</span><span class="meta">${run ? run + ' running · ' : ''}${gs.length - run} done</span>${ic('chev', 'ch')}</summary>
          <div class="ag-list">${gs.map(g => `<button class="ag" data-act="subOpen" data-sid="${c.s.id}" data-g="${g.id}">${g.status === 'running' ? '<span class="spin"></span>' : ic('check')}<b>${esc(g.name)}</b><span class="at">${esc(g.task)}</span><span class="dim">${g.dur}</span></button>`).join('')}</div></details>`;
      }
      case 'plan':   // plan mode writes a file; open it beside the thread, comment on it, then approve
        return `<div class="appr plan"><div class="ah">${ic('file')}<span>${esc(e.file)}</span><span class="dim">Plan</span><span class="sp"></span>
          <button class="btn" data-act="openFile" data-p="${esc(e.file)}">Open</button><button class="btn primary" data-act="planOk">Approve</button></div></div>`;
      case 'approval': {   // several can wait at once (parallel subagents): y / n answer the oldest, and the card counts them (G7)
        const all = c.s.events.filter(x => x.t === 'approval'); if (all[0] !== e) return '';
        return `<div class="appr">
          <div class="ah">${ic('shield')}<span>Run this command?</span>${e.from ? `<span class="dim">${esc(e.from)}</span>` : ''}${all.length > 1 ? `<span class="sp"></span><span class="count" title="Requests waiting; y and n answer the oldest first">1 of ${all.length}</span>` : ''}</div>
          <pre class="out">${esc(e.cmd)}</pre>
          <div class="dim why">${esc(e.why)}</div>
          <div class="af">
            <button class="btn ghost" data-act="deny">Deny</button>
            <button class="btn" data-act="approve">Always allow</button>
            <button class="btn primary" data-act="approve">Allow</button></div></div>`;
      }
      case 'err': return Chat.err(e, c.s, src);
      default: return '';
    }
  }

  // What a thread can run into (G9). Each says what happened and offers the one action that helps.
  const ERR = {
    crash: [s => `${s.harness === 'claude' ? 'Claude Code' : 'Codex'} stopped unexpectedly`, 'Restart'],
    rate: [() => 'Rate limit reached. Resets at 3:40 PM', 'Retry now'],
    context: [() => 'Context full. Compacted the conversation to continue', ''],
    auth: [s => `Signed out of ${s.harness === 'claude' ? 'Claude Code' : 'Codex'} on ${App.mach(s.machine).name}`, 'Sign in'],
    missing: [s => `${s.harness === 'claude' ? 'Claude Code' : 'Codex'} isn't installed on ${App.mach(s.machine).name}`, 'Copy install command'],
  };
  window.Chat = {
    diff,
    err(e, s, src = '') {
      const [msg, btn] = ERR[e.kind];
      return `<div class="err-row ${e.kind === 'context' ? 'info' : ''} ${btn ? 'kbrow' : ''}" ${src} role="${e.kind === 'context' ? 'status' : 'alert'}">${ic(e.kind === 'context' ? 'layers' : 'alert')}<span>${esc(msg(s))}</span>${btn ? `<span class="sp"></span><button class="btn sm" data-act="errFix" data-k="${e.kind}">${btn}</button>` : ''}</div>`;
    },
    // Claude Code driven from its terminal: the chat view follows along read-only and can ask for the thread back (G4)
    mirror(s) {
      const back = s.pend === 'chat';
      return `<div class="mirror kbrow" role="status">${ic('terminal')}<span>${back ? 'Chat takes over when this turn finishes' : 'Claude Code is driving this thread in its terminal'}</span><span class="sp"></span>
        ${back ? '<button class="btn sm" data-act="takeCancel" data-esc>Cancel</button>' : `<button class="btn sm" data-act="setView" data-v="term">Show terminal</button><button class="btn sm primary" data-act="takeBack" title="Ends the terminal session and continues here">Take back</button>`}</div>`;
    },
    // a remote thread while its link is down: the harness runs on under a persistent process there (G5)
    link(s) {
      const m = App.mach(s.machine); if (!m || !m.ssh || !m.link || m.link === 'up') return '';
      return `<div class="link-note" role="status"><span class="dot amber pulse"></span><span>${m.link === 'reconnecting' ? `Reconnecting to ${esc(m.name)}. The turn keeps running there.` : `Connecting to ${esc(m.name)}`}</span></div>`;
    },
    // One composer for threads, side chats and the launcher. `m` holds model / effort / ultra / perm.
    composer(tab, m, o = {}) {
      const hn = D.harnessOf(m.model);
      const atts = tab.atts.length ? `<div class="atts">${tab.atts.map((a, i) =>
        `<span class="att"><img src="${a.url}" data-zoom alt=""><button data-act="rmAtt" data-i="${i}" title="Remove">${ic('x')}</button></span>`).join('')}</div>` : '';
      // .bk sits behind the textarea and draws quoted selections in the text as chips
      return `<div class="comp">${atts}
        <div class="taw"><div class="bk" aria-hidden="true"></div><textarea data-input="draft" rows="1" spellcheck="false" placeholder="${o.placeholder || 'Send follow-up'}">${esc(tab.draft)}</textarea></div>
        <div class="cf">
          <button class="ib" data-act="attach" title="Attach image · or paste one">${ic('plus')}</button>
          <button class="chip${D.permInfo[m.perm]?.[2] ? ' warn' : ''}" data-act="pickPerm" title="Permissions">${ic(D.permInfo[m.perm]?.[0] || 'shield')}<span class="lbl">${esc(m.perm)}</span></button>
          <span class="sp"></span>
          <button class="chip" data-act="pickModel" title="Model and effort">${ic(hn)}<span>${esc(m.model)}</span><span class="lbl dim">${esc(m.effort)}${m.ultra ? ' · Ultracode' : ''}</span>${ic('down', 'sm')}</button>
          ${o.showContext ? `<button class="ib" data-act="contextUsage" data-sid="${m.id}" aria-label="Context usage: ${m.ctx}% used" title="Context usage: ${m.ctx}% used, ${100 - m.ctx}% available"><span class="ring" style="--p:${m.ctx}"></span></button>` : ''}
          <button class="send ${o.running ? 'stop' : ''}" data-act="${o.running ? 'stop' : 'send'}" title="${o.running ? 'Stop' : 'Send'}">${o.running ? '<span class="sq"></span>' : ic('up')}</button>
        </div></div>`;
    },

    thread(tab, s) {
      const last = s.events[s.events.length - 1], c = { tab, s, main: true, key: i => `ev:${s.id}:${i}` };
      // Copy, fork, and side chat act on the last reply of each completed turn.
      const acts = i => {
        const nx = s.events[i + 1], done = nx ? nx.t === 'user' : !['running', 'wait'].includes(s.status); if (!done || s.events[i].t === 'user') return '';
        let at = i; while (at >= 0 && s.events[at].t !== 'text' && s.events[at].t !== 'user') at--; if (at < 0 || s.events[at].t !== 'text') return '';
        const age = nx ? s.events[i].age : s.age;
        const time = age == null ? '' : `<span class="dim">${App.age(age) || 'now'}</span>`;
        return `<div class="m-acts ${nx ? 'old' : ''}"><button class="ib sm" title="Copy">${ic('copy')}</button><button class="ib sm" title="Fork into a new thread">${ic('branch')}</button><button class="ib sm" data-act="sideNew" data-ev="${at}" title="Side chat about this reply · /side">${ic('chat')}</button>${time}</div>`;
      };
      const transcript = s.events.map((e, i) => {
        const content = event(e, i, c);
        if (e.t === 'user') return content;
        const startsReply = i === 0 || s.events[i - 1].t === 'user';
        const endsReply = !s.events[i + 1] || s.events[i + 1].t === 'user';
        return (startsReply ? '<div class="reply">' : '') + content + acts(i) + (endsReply ? '</div>' : '');
      }).join('');
      return `<div class="chat">
        <div class="thread" data-scroll><div class="col" data-read>${s.events.length ? '' : `<div class="empty">${ic(s.harness, 'xl')}</div>`}${transcript}</div></div>
        <div class="compw"><div class="col">${Chat.link(s)}${s.harness === 'claude' && s.drive === 'term' ? Chat.mirror(s) : Chat.composer(tab, s, { running: s.status === 'running', showContext: true })}</div></div></div>`;
    },

    // A subagent's transcript, with a composer to prompt it. How the message reaches the subagent
    // depends on the harness: directly where it supports that, otherwise relayed through the thread.
    sub(tab, s, g) {
      const c = { tab, s, main: false, key: i => `sub:${g.id}:${i}` };
      return `<div class="chat side">
        <div class="thread" data-scroll><div class="col" data-read>
          <div class="sub-h">${ic('agent')}<span>${esc(g.task)}</span></div>
          ${g.events.map((e, i) => event(e, i, c)).join('')}</div></div>
        <div class="compw"><div class="col">${Chat.composer(tab, s, { placeholder: 'Message ' + g.name, running: g.status === 'running' })}
          <div class="under"><span class="u" title="Subagent of this thread">${ic(s.harness)}${esc(s.title)}</span><span class="sp"></span>
          <span class="u">${g.status === 'running' ? 'running ' + g.dur : ic('check') + 'finished in ' + g.dur}</span></div></div></div></div>`;
    },

    // A side chat: a fork of the thread at one message. Same composer, same editing and quoting.
    side(tab, s, sc) {
      const from = s.events[sc.at], c = { tab, s, main: false, key: i => `sc:${sc.id}:${i}` };
      const quote = from && from.text ? from.text.replace(/[`*]/g, '') : s.title;
      return `<div class="chat side">
        <div class="thread" data-scroll><div class="col" data-read>
          <button class="sc-anchor" data-act="gotoThread" data-sid="${s.id}" title="Open the thread at this message">${ic('branch')}<span>${esc(quote)}</span></button>
          ${sc.events.map((e, i) => event(e, i, c)).join('')}</div></div>
        <div class="compw"><div class="col">${Chat.composer(tab, s, { placeholder: 'Ask in this side chat', running: sc.running })}
          <div class="under"><span class="u">${ic(s.harness)}${esc(s.title)}</span><span class="sp"></span><button class="u link" data-act="sideToMain" title="Quote the last answer into the thread's composer">${ic('up')}Send to thread</button></div></div></div></div>`;
    },
  };
})();
