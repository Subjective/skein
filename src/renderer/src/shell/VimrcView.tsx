// The vimrc as a tab: one Vim field that applies as you type (the keymap rebuilds from it); :w, ctrl-s or cmd-s
// save at once and say what was ignored.
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { Tab } from '../state/layout';
import { S, toast, update, useApp } from '../state/store';
import { parseVimrc } from '../input/keymap';
import { VimField } from '../ui/VimField';

const apply = async (text: string) => { const s = await api.app.setSettings({ vimrc: text }); update(x => { x.settings = s; }); };

export function VimrcView({ t, focused }: { t: Tab; focused: boolean }) {
  useApp();
  const [text, setText] = useState(S.settings.vimrc);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(text); latest.current = text;
  // the keyboard sheet writes bindings into the vimrc while this tab is open: show them
  const seen = useRef(S.settings.vimrc);
  if (S.settings.vimrc !== seen.current) { seen.current = S.settings.vimrc; if (S.settings.vimrc !== text && !timer.current) setText(S.settings.vimrc); }
  const change = (v: string) => {
    setText(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = undefined; if (latest.current !== S.settings.vimrc) void apply(latest.current); }, 400);
  };
  // a pending change still applies when the tab closes
  useEffect(() => () => { if (timer.current) { clearTimeout(timer.current); if (latest.current !== S.settings.vimrc) void apply(latest.current); } }, []);
  const save = async () => {
    clearTimeout(timer.current); timer.current = undefined;
    const errs = parseVimrc(text).errors;
    await apply(text);
    toast(errs.length ? `Saved. Ignored ${errs[0]}${errs.length > 1 ? ` and ${errs.length - 1} more` : ''}` : 'vimrc saved');
  };
  return (
    <div className="vimrc-view">
      <header className="tool-h"><span className="path">~/.config/skein/vimrc</span><span className="sp" /><span className="dim">applies as you type</span></header>
      <VimField tabId={t.id} value={text} onChange={change} mono className="rc-ed" maxHeight={100000} autoFocus={focused} startMode="NORMAL"
        onKey={k => { if (k === 'ctrl-s' || k === 'cmd-s') { void save(); return true; } return false; }} />
    </div>
  );
}
