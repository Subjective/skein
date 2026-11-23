// The unnamed register (VIM-MODEL rule 18): one for the whole app, as in Vim, not one per field. Every yank,
// delete and change in a field fills it; a yank in a reader (the thread, a file, a diff, the scrollback) fills it
// too. A yank also goes to the system clipboard. `p` / `P` put the register; while it is empty they put the
// system clipboard instead, so text copied in another app pastes with p.

export interface Reg { text: string; line: boolean }

let reg: Reg = { text: '', line: false };
const watchers = new Set<(r: Reg) => void>();
export const getReg = (): Reg => reg;
export const setReg = (r: Reg) => { reg = { text: r.text, line: r.line }; for (const w of watchers) w(reg); };
/** Follow the register (the code editor's Vim keeps its own unnamed register in step, ui/editor/vim.ts). */
export const watchReg = (w: (r: Reg) => void) => { watchers.add(w); return () => { watchers.delete(w); }; };

/** Clipboard text as a register: text that ends in a newline is whole lines, as Vim reads "+. */
export function fromClipboard(text: string): Reg {
  const t = text.replace(/\r\n?/g, '\n');
  return /\n$/.test(t) ? { text: t.replace(/\n$/, ''), line: true } : { text: t, line: false };
}

/** What p / P put: the register, or the system clipboard while the register is empty. */
export async function forPut(read: () => Promise<string> = () => navigator.clipboard.readText()): Promise<Reg> {
  if (reg.text) return reg;
  try { const t = await read(); return t ? fromClipboard(t) : reg; } catch { return reg; }
}

/** A yank from anywhere: fill the register and the system clipboard. */
export function yank(text: string, line = false) {
  setReg({ text, line });
  void navigator.clipboard?.writeText(text + (line ? '\n' : '')).catch(() => {});
}
