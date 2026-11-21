import { createRoot } from 'react-dom/client';
import './styles/skein.css';
import './styles/app.css';
import { spriteHtml } from './ui/icons';
import { App, boot } from './shell/App';
import { owner, startKeyboard } from './shell/keyboard';
import { api } from './api';
import { S } from './state/store';
import { termOf } from './views/terminal/TerminalView';
import { EditorView } from '@codemirror/view';
import { getReg } from './input/register';

document.body.insertAdjacentHTML('afterbegin', spriteHtml());
startKeyboard();
// for UI tests and debugging from devtools
(window as unknown as { __skein: unknown }).__skein = { S, owner, api, text: (tabId: string) => { const t = termOf(tabId); if (!t) return ''; const b = t.term.buffer.active; let o = ''; for (let i = 0; i < b.length; i++) o += (b.getLine(i)?.translateToString(true) ?? '') + '\n'; return o.trimEnd(); },
  /** A terminal's selection (the scrollback reader's cursor or match): its text and the buffer line it starts on. */
  sel: (tabId: string) => { const t = termOf(tabId); return t ? { text: t.term.getSelection(), line: t.term.getSelectionPosition()?.start.y ?? null } : null; },
  /** The app's one register (input/register). */
  reg: () => getReg(),
  /** A code editor's state (ui/editor), from a selector inside it: the cursor, the selection and the text. */
  cm: (sel: string) => { const el = document.querySelector<HTMLElement>(sel); const v = el && EditorView.findFromDOM(el); if (!v) return null; const m = v.state.selection.main; return { head: m.head, anchor: m.anchor, line: v.state.doc.lineAt(m.head).number, col: m.head - v.state.doc.lineAt(m.head).from, lines: v.state.doc.lines, text: v.state.doc.toString(), sel: v.state.sliceDoc(m.from, m.to) }; } };
void boot();
createRoot(document.getElementById('root')!).render(<App />);
