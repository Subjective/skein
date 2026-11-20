// The single keydown handler (VIM-MODEL section 6: "one dispatcher and one interface per surface kind").
//
// Order for each key:
//   1. a pending leader takes the next key from the leader layer
//   2. the leader key itself arms the leader
//   3. global bindings (modifier keys); in a terminal only those marked `term` (rule 11)
//   4. the surface that owns the keyboard (field, reader, list, terminal); an editor can pass a key on untouched
//      ('native'), so CodeMirror's Vim mode reads it from the DOM event
//   5. in NORMAL, the app's normal layer, with sequences (g t, ctrl-w v) and the vimrc's maps
// Anything not handled falls through to the browser (typing, native shortcuts).
import { keyOf, type KeyLike } from './keys';
import type { Keymap } from './keymap';
import { canon } from './platform';

export type Mode = 'NORMAL' | 'INSERT' | 'VISUAL' | 'V-LINE' | 'TERMINAL';
export type SurfaceKind = 'field' | 'reader' | 'terminal' | 'list' | 'layout';

export interface Surface {
  kind: SurfaceKind;
  mode(): Mode;
  /** Handle a key. true = consumed (the event's default is prevented). 'native': the key belongs to an editor that
   *  reads it from the DOM event itself (ui/editor: CodeMirror's Vim mode), so it goes on to the focused element
   *  untouched and nothing after the surface (the normal layer, the drop of untyped keys) sees it. */
  key(k: string, e: KeyLike): boolean | 'native';
  /** A temporary popup (a menu, a dialog, the composer's / or @ list) has the keys: it is modal, so the global
   *  bindings and the leader don't run while it is open (ctrl-p moves up a / list instead of opening file search). */
  local?(): boolean;
  /** A popup that can step aside (a menu, not a dialog holding your input): a global chord or the leader it does not
   *  use itself closes it, then runs as if it had not been open (VIM-MODEL rule 20). */
  dismiss?(): void;
  /** An insert map like `inoremap jk <Esc>` fired: remove the first key's character and leave INSERT. */
  imap?(first: string): void;
}

export interface DispatchHost {
  surface(): Surface | null;
  /** false: the command had nothing to do, so the key goes on to the surface. */
  run(command: string): boolean | void;
  vim(): boolean;
  leaderKey(): string;
  /** Leader armed or a sequence pending, for the status bar. */
  pending(p: { leader: boolean; seq: string }): void;
}

export class Dispatcher {
  private leader = false;
  private seq = '';
  private seqTimer: ReturnType<typeof setTimeout> | null = null;
  private lastInsert: { k: string; at: number } | null = null;
  constructor(public keymap: Keymap, private host: DispatchHost) {}

  /** Returns true when the key was handled and the event's default should be prevented. */
  handle(e: KeyLike, stepped = false): boolean {
    const k = keyOf(e);
    if (!k) return false;
    const s = this.host.surface();
    const mode = s?.mode() ?? 'NORMAL';
    const inTerm = mode === 'TERMINAL';

    // A focused popup is modal (as in the mockup): a menu, dialog or the composer's / and @ lists get every key,
    // and the global bindings and the leader wait until it closes. Only the workspace switcher's ctrl-tab passes.
    if (s?.local?.()) {
      if (this.leader) this.setLeader(false);
      const g0 = this.keymap.global.get(k), isLeader = k === canon(this.host.leaderKey());
      if (g0 && (g0.command === 'wsnext' || g0.command === 'wsprev')) { this.host.run(g0.command); return true; }
      const r0 = s.key(k, e);
      if (r0 === 'native') { this.clearSeq(); return false; }
      if (r0) { this.clearSeq(); return true; }
      if (!g0 && !isLeader) return false;   // plain keys type
      // a chord the popup does not use: a menu steps aside and the chord runs below; a dialog keeps it (your input)
      if (!s.dismiss || stepped) return true;
      s.dismiss();
      return this.handle(e, true);
    }

    if (this.leader) {
      this.setLeader(false);
      const b = this.keymap.leader.get(k);
      if (b) { this.host.run(b.command); return true; }
      return k !== 'esc' ? true : true; // an unbound key after the leader does nothing
    }
    if (k === canon(this.host.leaderKey())) { this.setLeader(true); return true; }

    const g = this.keymap.global.get(k);
    if (g && (!inTerm || g.term || g.keys.includes('cmd-')) && this.host.run(g.command) !== false) return true;

    // vimrc insert maps (jk -> esc) in fields only; a terminal's line belongs to its program
    if (mode === 'INSERT' && s?.kind === 'field' && this.host.vim() && k.length === 1) {
      const now = Date.now();
      const hit = this.keymap.imap.find(m => this.lastInsert && m[0] === this.lastInsert.k && m[1] === k && now - this.lastInsert.at < 500);
      if (hit && s.imap) { this.lastInsert = null; s.imap(hit[0]); return true; }
      this.lastInsert = { k, at: now };
    }

    const r = s ? s.key(k, e) : false;
    if (r === 'native') { this.clearSeq(); return false; }
    if (r) { this.clearSeq(); return true; }

    if (mode === 'NORMAL' && this.host.vim()) {
      const full = this.seq ? `${this.seq} ${k}` : k;
      const b = this.keymap.normal.get(full);
      if (b) { this.clearSeq(); this.host.run(b.command); return true; }
      if (this.keymap.prefixes.has(full)) {
        this.seq = full; this.host.pending({ leader: false, seq: full });
        if (this.seqTimer) clearTimeout(this.seqTimer);
        this.seqTimer = setTimeout(() => this.clearSeq(), 1200);
        return true;
      }
      if (this.seq) { this.clearSeq(); return true; }
    }
    // NORMAL and VISUAL never type: a plain key nobody wanted is dropped, not inserted into a field
    if (this.host.vim() && (mode === 'NORMAL' || mode.startsWith('V')) && k.length === 1) return true;
    // a field in NORMAL takes no edits from the browser either: backspace, delete, ctrl-a then backspace
    if (this.host.vim() && s?.kind === 'field' && (mode === 'NORMAL' || mode.startsWith('V')) && !/^(ctrl|cmd)-[cvx]$/.test(k) && !/^f\d+$/.test(k)) return true;
    return false;
  }

  cancel() { this.setLeader(false); this.clearSeq(); }
  get leaderArmed() { return this.leader; }
  private setLeader(on: boolean) { this.leader = on; this.host.pending({ leader: on, seq: this.seq }); }
  private clearSeq() { if (this.seqTimer) clearTimeout(this.seqTimer); this.seqTimer = null; if (this.seq) { this.seq = ''; this.host.pending({ leader: this.leader, seq: '' }); } }
}
