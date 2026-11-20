// SSH sign-in (G5): passphrase, password, verification code and new host key all arrive as AuthPrompts from the
// askpass helper and show in this one small dialog, oldest first. Keys (VIM-MODEL): the field is INSERT;
// enter connects; esc goes to the buttons (NORMAL), where h / l move, enter presses, i edits, esc or q cancels.
import { useEffect, useRef, useState } from 'react';
import type { AuthPrompt, Machine } from '@shared/types';
import { api } from '../api';
import { Dialog, useDialogSurface } from '../ui/Dialog';
import { Button, Icon } from '../ui/primitives';
import { machine, openLayer, S, update } from '../state/store';

const tidyPath = (p: string, home?: string) => (home && p.startsWith(home) ? '~' + p.slice(home.length) : p).replace(/\\/g, '/');

/** Title, field label and button for a prompt. Pure, for tests. */
export function authCopy(p: AuthPrompt, m?: Pick<Machine, 'name' | 'home'>, localHome?: string) {
  const name = m?.name || p.machine;
  const raw = p.text.trim().replace(/:\s*$/, '');
  switch (p.kind) {
    case 'hostkey':
      return { icon: 'shield', title: `First connection to ${name}`, label: '', ok: 'Trust and connect',
        body: `${p.host || name} isn’t in known_hosts yet. Check the fingerprint with whoever runs it.` };
    case 'passphrase': {
      const key = /for key ['"]?([^'"]+?)['"]?$/i.exec(raw)?.[1];
      return { icon: 'lock', title: `Unlock your key for ${name}`, label: key ? `Passphrase for ${tidyPath(key, localHome)}` : 'Key passphrase', ok: 'Connect', body: '' };
    }
    case 'password': {
      const who = /^(.+?)'s password$/i.exec(raw)?.[1];
      return { icon: 'lock', title: `Sign in to ${name}`, label: who ? `Password for ${who}` : 'Password', ok: 'Connect', body: '' };
    }
    case 'code':
      return { icon: 'lock', title: `Verify it’s you on ${name}`, label: raw || 'Verification code', ok: 'Connect', body: '' };
    default:
      return { icon: 'lock', title: `${name} is asking`, label: raw, ok: 'Continue', body: '' };
  }
}

let current: { id: string; close: () => void } | null = null;

/** Show the oldest waiting prompt, if none is showing. */
function pump() {
  if (current || !S.auth.length) return;
  const p = S.auth[0];
  const close = openLayer(c => <AuthDialog prompt={p} close={c} />, () => { if (current?.id === p.id) current = null; queueMicrotask(pump); });
  current = { id: p.id, close };
}

/** The sign-in dot: show this machine's waiting prompt now (first in line). false when none is waiting. */
export function showAuth(machineId: string): boolean {
  const p = S.auth.find(x => x.machine === machineId); if (!p) return false;
  if (current?.id !== p.id) { update(s => { s.auth = [p, ...s.auth.filter(x => x !== p)]; }); pump(); }
  return true;
}

/** Follow the main process's auth events. Called once at boot. */
export function watchAuth() {
  api.on(e => {
    if (e.type === 'auth') { update(s => { if (!s.auth.some(x => x.id === e.prompt.id)) s.auth = [...s.auth, e.prompt]; }); pump(); }
    if (e.type === 'auth.done') {
      update(s => { s.auth = s.auth.filter(x => x.id !== e.id); });
      if (current?.id === e.id) current.close(); else pump();
    }
  });
}

export function AuthDialog({ prompt: p, close }: { prompt: AuthPrompt; close: () => void }) {
  const m = machine(p.machine);
  const c = authCopy(p, m, S.info.home);
  const field = p.kind !== 'hostkey';
  const [value, setValue] = useState('');
  const [mode, setMode] = useState<'INSERT' | 'NORMAL'>(field ? 'INSERT' : 'NORMAL');
  const [btn, setBtn] = useState(1);
  const input = useRef<HTMLInputElement>(null);
  const btns = [useRef<HTMLButtonElement>(null), useRef<HTMLButtonElement>(null)];
  const done = useRef(false);

  const answer = (v: string | null) => { if (done.current) return; done.current = true; void api.machines.answer(p.id, v); close(); };
  const ok = () => { if (field && !value) { input.current?.focus(); return; } answer(field ? value : 'yes'); };
  const cancel = () => answer(null);
  const toButtons = () => { setMode('NORMAL'); btns[btn].current?.focus(); };
  const toField = () => { if (!field) return; setMode('INSERT'); input.current?.focus(); };

  useEffect(() => { if (field) input.current?.focus(); else btns[1].current?.focus(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (mode === 'NORMAL') btns[btn].current?.focus(); }, [btn, mode]); // eslint-disable-line react-hooks/exhaustive-deps
  // a dialog closed by anything other than an answer (scrim click) cancels the prompt
  useEffect(() => () => { if (!done.current) { done.current = true; void api.machines.answer(p.id, null); } }, [p.id]);

  useDialogSurface({
    mode: () => mode,
    onEsc: () => { if (mode === 'INSERT' && S.settings.vim) toButtons(); else cancel(); },
    key: k => {
      if (mode === 'INSERT') { if (k === 'enter') { ok(); return true; } return false; }
      if (k === 'h' || k === 'left' || k === 'shift-tab') { setBtn(0); return true; }
      if (k === 'l' || k === 'right' || k === 'tab') { setBtn(1); return true; }
      if (k === 'i' || k === 'a' || k === 'k' || k === 'up') { toField(); return true; }
      if (k === 'enter' || k === 'space') { if (btn === 0) cancel(); else ok(); return true; }
      if (k === 'q') { cancel(); return true; }
      return k.length === 1;
    },
  }, [mode, btn, value]);

  return (
    <Dialog onClose={cancel} className="auth" label={c.title}>
      <header><Icon name={c.icon} /><h3>{c.title}</h3></header>
      {field ? <>
        <label className="dim" htmlFor={`auth-${p.id}`}>{c.label}</label>
        <input id={`auth-${p.id}`} ref={input} className="auth-i" type={p.secret ? 'password' : 'text'} inputMode={p.kind === 'code' ? 'numeric' : undefined}
          autoComplete={p.kind === 'code' ? 'one-time-code' : 'off'} spellCheck={false} value={value}
          onChange={e => setValue(e.target.value)} onFocus={() => setMode('INSERT')} />
      </> : <>
        <p className="dim">{c.body}</p>
        {p.fingerprint && <code className="fp">{p.fingerprint}</code>}
      </>}
      <div className="af kbrow">
        <Button ref={btns[0]} onClick={cancel} onFocus={() => { setMode('NORMAL'); setBtn(0); }}>Cancel</Button>
        <Button ref={btns[1]} variant="primary" onClick={ok} onFocus={() => { setMode('NORMAL'); setBtn(1); }}>{c.ok}</Button>
      </div>
    </Dialog>
  );
}
