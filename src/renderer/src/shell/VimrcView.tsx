// The vimrc as a tab: one Vim field, :w (or ctrl-s / cmd-s) saves; the keymap rebuilds from it.
import { useState } from 'react';
import { api } from '../api';
import type { Tab } from '../state/layout';
import { S, toast, update } from '../state/store';
import { parseVimrc } from '../input/keymap';
import { VimField } from '../ui/VimField';
import { Button } from '../ui/primitives';

export function VimrcView({ t, focused }: { t: Tab; focused: boolean }) {
  const [text, setText] = useState(S.settings.vimrc);
  const dirty = text !== S.settings.vimrc;
  const save = async () => {
    const errs = parseVimrc(text).errors;
    const s = await api.app.setSettings({ vimrc: text });
    update(x => { x.settings = s; });
    toast(errs.length ? `Saved. Ignored ${errs[0]}${errs.length > 1 ? ` and ${errs.length - 1} more` : ''}` : 'vimrc saved');
  };
  return (
    <div className="vimrc-view">
      <header className="tool-h"><span className="path">vimrc</span><span className="sp" /><Button small variant={dirty ? 'primary' : 'default'} disabled={!dirty} onClick={save}>Save</Button></header>
      <VimField tabId={t.id} value={text} onChange={setText} mono className="rc-ed" maxHeight={100000} autoFocus={focused} startMode="NORMAL"
        onKey={k => { if (k === 'ctrl-s' || k === 'cmd-s') { void save(); return true; } return false; }} />
    </div>
  );
}
