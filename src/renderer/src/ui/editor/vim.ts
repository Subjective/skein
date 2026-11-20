// One Vim for the whole app (VIM-MODEL rule 18). Every code editor runs CodeMirror's Vim mode
// (@replit/codemirror-vim), whose registers, marks and last search are already global to the page. This file ties
// that state to Skein's: the unnamed register is input/register.ts (so a yank in a file pastes in a composer or a
// reader, and back), a yank also goes to the system clipboard, and the mode an editor is in is the mode the status
// bar shows.
import { Vim, getCM, type CodeMirror } from '@replit/codemirror-vim';
import type { EditorView } from '@codemirror/view';
import type { Mode } from '../../input/dispatcher';
import type { KeyLike } from '../../input/keys';
import { getReg, setReg, watchReg, yank } from '../../input/register';

type CM = CodeMirror;
type Ctl = ReturnType<typeof Vim.getRegisterController>;
type InputState = { prefixRepeat: string[]; motionRepeat: string[]; operator: unknown; motion: unknown; keyBuffer: string[]; registerName?: string | null };
type VimState = { insertMode: boolean; visualMode: boolean; visualLine: boolean; visualBlock: boolean; inputState: InputState; expectLiteralNext?: boolean };

export const cmOf = (v: EditorView): CM | null => getCM(v);
const stateOf = (cm: CM | null): VimState | undefined => (cm?.state as { vim?: VimState } | undefined)?.vim;

/** Skein's name for the mode an editor is in. Replace mode is typing, so INSERT; a block selection is VISUAL. */
export function modeOf(cm: CM | null): Mode {
  const v = stateOf(cm);
  if (!v) return 'NORMAL';
  if (v.insertMode) return 'INSERT';
  if (v.visualMode) return v.visualLine ? 'V-LINE' : 'VISUAL';
  return 'NORMAL';
}

/** A VISUAL selection's anchor and cursor lines (0-based), as Vim tracks them. */
export function vimSel(cm: CM | null): [number, number] | null {
  const v = stateOf(cm) as (VimState & { sel?: { anchor: { line: number }; head: { line: number } } }) | undefined;
  return v?.visualMode && v.sel ? [v.sel.anchor.line, v.sel.head.line] : null;
}

/** Nothing typed yet towards a command: no count, operator, register or half of a two-key command. Only then do
 *  Skein's own NORMAL keys (H L : / ? g t ...) win over Vim's. */
export function idle(cm: CM | null): boolean {
  const v = stateOf(cm); if (!v) return true;
  const s = v.inputState;
  return !v.expectLiteralNext && !s.operator && !s.motion && !s.prefixRepeat.length && !s.motionRepeat.length && !s.keyBuffer.length && !s.registerName;
}

/** Vim's name for a key event ('<C-r>', '<Esc>', 'j'). */
export const vimKey = (e: KeyLike): string | undefined => Vim.vimKeyFromEvent(e as KeyboardEvent);

/** Run keys through an editor's Vim without a DOM event (a key that arrived while the editor did not have the focus,
 *  or one Skein held back to see if it began one of its own sequences). */
export function feed(cm: CM, ...keys: string[]): boolean {
  let any = false;
  for (const k of keys) any = !!Vim.handleKey(cm, k, 'user') || any;
  return any;
}

// ---------- the register ----------
// Vim's pushText is where every yank, delete and change lands. A push to the unnamed register (no "x given) also
// becomes Skein's register, and a yank goes to the clipboard; Skein's register changing elsewhere (a reader's y)
// is copied back into Vim's, so p puts it.
let bridged: Ctl | null = null;
let pushing = false;
function bridge() {
  const ctl = Vim.getRegisterController();
  if (bridged === ctl) return;
  bridged = ctl;
  const push = ctl.pushText.bind(ctl);
  ctl.pushText = (name, op, text, linewise, blockwise) => {
    push(name, op, text, linewise, blockwise);
    if (name && name !== '"') return;   // a named register stays Vim's own
    const t = linewise ? text.replace(/\n$/, '') : text;
    pushing = true;
    try { if (op === 'yank') yank(t, !!linewise); else setReg({ text: t, line: !!linewise }); } finally { pushing = false; }
  };
  const r = getReg();
  if (r.text) ctl.unnamedRegister.setText(r.text + (r.line ? '\n' : ''), r.line);
}
watchReg(r => {
  if (pushing || !bridged) return;
  bridged.unnamedRegister.setText(r.text + (r.line ? '\n' : ''), r.line);
});

/** Set up the shared Vim once, before the first editor: the register bridge, and Vim's own : commands that Skein
 *  already has (its : line runs :w, :q and the rest, ui/editor/CodeEditor routes : there). */
export function setupVim() {
  bridge();
}
/** Called before a key reaches an editor: a test or a hot reload can replace Vim's register controller. */
export const keepBridge = bridge;
