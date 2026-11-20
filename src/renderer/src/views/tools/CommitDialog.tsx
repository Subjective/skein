// The commit button's dialog: a branch name when the action makes one, a message when it commits.
// Fields are Vim fields; tab moves between them, enter in the last one confirms, esc steps back
// (INSERT -> NORMAL -> closed), as in every other dialog.
import { useEffect, useRef, useState } from 'react';
import type { Surface } from '../../input/dispatcher';
import { tabSurface } from '../../input/surfaces';
import { api } from '../../api';
import { openLayer, S, toast, update } from '../../state/store';
import { Dialog } from '../../ui/Dialog';
import { Button, Icon, Spinner } from '../../ui/primitives';
import { VimField, type VimFieldHandle } from '../../ui/VimField';

export type CommitAction = 'commit' | 'push' | 'pr' | 'branch';
export interface CommitPlan {
  machine: string;
  root: string;
  /** make a branch first (on the default branch, or "Create branch") */
  newBranch: boolean;
  action: CommitAction;
  /** what goes in: "3 staged files" / "All 5 changed files" */
  what: string;
  message: string;
  branch: string;
  title: string;
  done: () => void;
}

let n = 0;
export function openCommit(p: CommitPlan) {
  const id = `commit-${++n}`;
  openLayer(close => <CommitDialog p={p} id={id} close={close} />);
}

function CommitDialog({ p, id, close }: { p: CommitPlan; id: string; close: () => void }) {
  const fields = [...(p.newBranch ? ['branch'] : []), ...(p.action !== 'branch' ? ['msg'] : [])];
  const [branch, setBranch] = useState(p.branch);
  const [msg, setMsg] = useState(p.message);
  const [cur, setCur] = useState(fields[fields.length - 1] === 'msg' && p.message && p.newBranch ? 'branch' : fields[0]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const refs = { branch: useRef<VimFieldHandle>(null), msg: useRef<VimFieldHandle>(null) } as Record<string, React.RefObject<VimFieldHandle | null>>;
  const st = useRef({ cur, busy, branch, msg }); st.current = { cur, busy, branch, msg };  // the key surface is made once: read live values

  const submit = async () => {
    if (st.current.busy) return;
    const b = st.current.branch.trim(), m = st.current.msg.trim();
    if (p.newBranch && !b) { setErr('Name the branch'); return focus('branch'); }
    if (p.newBranch && !/^(?!\/|.*\/\/|.*\.\.|.*@\{)[^\s~^:?*[\\]+(?<![./]|\.lock)$/.test(b)) { setErr('That is not a valid branch name'); return focus('branch'); }
    if (p.action !== 'branch' && !m) { setErr('Write a commit message'); return focus('msg'); }
    setBusy(true); setErr('');
    try {
      if (p.action === 'branch') await api.git.switch(p.machine, p.root, b, true);
      else {
        await api.git.commit(p.machine, p.root, m, { branch: p.newBranch ? b : undefined, all: true });
        if (p.action === 'push' || p.action === 'pr') {
          const r = await api.git.push(p.machine, p.root);
          if (p.action === 'pr') { if (r.pr) void api.app.openExternal(r.pr); else toast('Pushed. This remote has no pull request page Skein knows'); }
        }
      }
      close(); p.done();
      toast(p.action === 'branch' ? `On ${b}` : p.action === 'commit' ? 'Committed' : p.action === 'push' ? 'Committed and pushed' : 'Committed, pushed, opening the pull request', { icon: 'check' });
    } catch (e) {
      setErr((e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
      p.done();
    } finally { setBusy(false); }
  };
  const focus = (f: string) => { setCur(f); requestAnimationFrame(() => refs[f]?.current?.focus()); };

  // the dialog's keys go to the field that has the cursor
  useEffect(() => {
    const fid = () => `${id}:${st.current.cur}`;
    const surface: Surface = {
      kind: 'field',
      mode: () => tabSurface(fid())?.mode() ?? 'INSERT',
      key: (k, e) => {
        if (k === 'tab' || k === 'shift-tab') { const i = fields.indexOf(st.current.cur); focus(fields[(i + (k === 'tab' ? 1 : fields.length - 1)) % fields.length]); return true; }
        if (k === 'mod-enter' || k === 'ctrl-enter' || k === 'cmd-enter') { void submit(); return true; }
        return tabSurface(fid())?.key(k, e) ?? false;
      },
      imap: f => tabSurface(fid())?.imap?.(f),
    };
    update(s => { const top = s.layers[s.layers.length - 1]; if (top) top.surface = surface; s.tick++; });
    requestAnimationFrame(() => refs[st.current.cur]?.current?.focus(true));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const verb = p.title;
  return (
    <Dialog onClose={close} className="auth commit" label={verb}>
      <header><Icon name={p.action === 'branch' || p.newBranch ? 'branch' : 'check'} /><h3>{verb}</h3></header>
      {p.action !== 'branch' && <p className="dim">{p.what}</p>}
      {p.newBranch && <label>Branch</label>}
      {p.newBranch && (<div className="fw" onFocus={() => setCur('branch')}>
        <VimField ref={refs.branch} tabId={`${id}:branch`} value={branch} onChange={v => { setBranch(v.replace(/\n/g, '')); setErr(''); }} className="auth-i" mono
          onEnter={() => (fields.includes('msg') ? focus('msg') : void submit())} onLeave={close} placeholder="feature/my-change" />
      </div>)}
      {p.action !== 'branch' && <label>Message</label>}
      {p.action !== 'branch' && (<div className="fw" onFocus={() => setCur('msg')}>
        <VimField ref={refs.msg} tabId={`${id}:msg`} value={msg} onChange={v => { setMsg(v); setErr(''); }} className="auth-i msg" maxHeight={180}
          onEnter={() => void submit()} onLeave={close} placeholder="What changed, in one line" />
      </div>)}
      {err && <p className="c-del err" role="alert">{err}</p>}
      <div className="af">
        <span className="hint dim">{S.settings.vim ? 'tab next field · enter confirm' : 'enter confirm'}</span>
        <Button small onClick={close}>Cancel</Button>
        <Button small variant="primary" disabled={busy} onClick={() => void submit()}>{busy && <Spinner label="Working" />}{verb}</Button>
      </div>
    </Dialog>
  );
}
