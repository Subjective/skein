/// <reference types="node" />
// Key clashes (Josh, 2026-11-20): one key must mean one thing in each place it can be pressed. These tests fail when
// a binding is added that collides with another scope: two commands on one key, a global that steals a key a popup
// uses to move its list, a terminal binding that takes a key the shell needs, or a surface that handles a chord the
// global layer would always take first (so its code can never run).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Dispatcher, type Surface } from './dispatcher';
import { keyOf, type KeyLike } from './keys';
import { DEFAULTS, Keymap } from './keymap';
import { canon, type OS } from './platform';

const OSES: OS[] = ['mac', 'win', 'linux'];
const LEADERS = ['ctrl-space', 'ctrl-\\'];
/** What a popup list (ui/Menu.tsx, the composer's / and @ lists) moves with, in INSERT as in NORMAL. */
const POPUP_NAV = ['ctrl-n', 'ctrl-p', 'ctrl-j', 'ctrl-k', 'ctrl-h', 'ctrl-l', 'up', 'down', 'tab', 'shift-tab', 'enter', 'esc'];
/** Keys a shell or a TUI in a terminal needs. A global marked `term` must not take one (VIM-MODEL rule 11). */
const SHELL = ['ctrl-a', 'ctrl-b', 'ctrl-c', 'ctrl-d', 'ctrl-e', 'ctrl-f', 'ctrl-g', 'ctrl-k', 'ctrl-l', 'ctrl-n', 'ctrl-o', 'ctrl-p', 'ctrl-r',
  'ctrl-s', 'ctrl-t', 'ctrl-u', 'ctrl-v', 'ctrl-w', 'ctrl-x', 'ctrl-y', 'ctrl-z', 'ctrl-[', 'alt-b', 'alt-f', 'alt-d', 'alt-.', 'alt-backspace', 'esc', 'tab', 'enter'];
/** Deliberate overlaps, each with the reason. Anything else is a clash. */
const TERM_ALLOWED: Record<string, string> = {
  'alt-h': 'pane focus works from a terminal (rule 11); readline has no alt-h',
  'alt-j': 'pane focus', 'alt-k': 'pane focus', 'alt-l': 'pane focus from a terminal outranks readline downcase-word (rule 11)',
};

const bindings = (os: OS) => DEFAULTS.filter(b => !b.os || b.os.includes(os)).map(b => ({ ...b, keys: canon(b.keys, os) }));

function ev(k: string): KeyLike {
  const parts = k.split('-'), base = k.endsWith('--') ? '-' : parts[parts.length - 1], mods = new Set(parts.slice(0, -1));
  const named: Record<string, [string, string]> = { tab: ['Tab', 'Tab'], space: [' ', 'Space'], esc: ['Escape', 'Escape'], enter: ['Enter', 'Enter'], '\\': ['\\', 'Backslash'], ',': [',', 'Comma'] };
  const [key, code] = named[base] ?? [base, /^[a-z]$/i.test(base) ? 'Key' + base.toUpperCase() : base];
  return { key, code, ctrlKey: mods.has('ctrl'), altKey: mods.has('alt'), shiftKey: mods.has('shift'), metaKey: mods.has('cmd') };
}

describe('keymap clashes', () => {
  for (const os of OSES) {
    it(`${os}: no key is bound twice in one layer`, () => {
      for (const layer of ['global', 'leader', 'normal'] as const) {
        const seen = new Map<string, string>();
        for (const b of bindings(os).filter(b => b.layer === layer)) {
          expect(seen.get(b.keys) ?? b.command, `${layer} ${b.keys}: ${seen.get(b.keys)} and ${b.command}`).toBe(b.command);
          seen.set(b.keys, b.command);
        }
      }
    });

    it(`${os}: a global binding never takes a key the shell needs, unless allowed with a reason`, () => {
      const hits = bindings(os).filter(b => b.layer === 'global' && b.term && SHELL.includes(b.keys) && !TERM_ALLOWED[b.keys]);
      expect(hits.map(b => `${b.keys} ${b.command}`)).toEqual([]);
    });

    it(`${os}: the leader is not also a global or normal key`, () => {
      for (const l of LEADERS) expect(bindings(os).filter(b => b.layer !== 'leader' && b.keys === l).map(b => b.command), l).toEqual([]);
    });

    it(`${os}: inside any popup, every global key goes to the popup (ctrl-k / ctrl-p move its list, never open a second search)`, () => {
      const km = Keymap.build('', os);
      let tried = 0;
      for (const [k] of km.global) {
        const e = ev(k);
        if (keyOf(e) !== k) continue;   // a chord this test can't synthesise
        tried++;
        const ran: string[] = [], seen: string[] = [];
        const popup: Surface = { kind: 'list', mode: () => 'INSERT', key: x => { seen.push(x); return POPUP_NAV.includes(x); }, local: () => true };
        const d = new Dispatcher(km, { surface: () => popup, run: c => { ran.push(c); }, vim: () => true, leaderKey: () => 'ctrl-space', pending: () => {} });
        const handled = d.handle(e);
        const ws = k === canon('ctrl-tab', os) || k === canon('ctrl-shift-tab', os);
        expect(ran, `${os} ${k} ran a global inside a popup`).toEqual(ws ? [km.global.get(k)!.command] : []);
        if (!ws) { expect(seen, `${os} ${k} never reached the popup`).toEqual([k]); expect(handled, `${os} ${k} fell through to the browser`).toBe(true); }
      }
      expect(tried, 'synthesised too few global keys to mean anything').toBeGreaterThanOrEqual(km.global.size - 2);
    });
  }

  it('popup list keys are never global on the OS where they move the list, except inside the popup', () => {
    // ctrl-k / ctrl-p are global on Windows and Linux (mod is ctrl). That is fine only because popups are modal:
    // the test above proves the popup gets them. Here: no popup key is bound in the leader or normal layer.
    for (const os of OSES) {
      const hits = bindings(os).filter(b => b.layer !== 'global' && POPUP_NAV.includes(b.keys) && b.keys !== 'esc');
      expect(hits.map(b => `${os} ${b.layer} ${b.keys}`)).toEqual([]);
    }
  });

  it('no surface handles a chord that a global binding always takes first (dead code), unless the surface is a popup', () => {
    // Surfaces that only see keys while modal (popups), or that handle the same command as the global (so it does not
    // matter which runs). Any other file that matches `case 'ctrl-x'` / `k === 'ctrl-x'` for a global key is a clash.
    const MODAL_OR_SAME: Record<string, string> = {
      'ui/Menu.tsx': 'every menu is a modal popup (rule 20)',
      'views/chat/Composer.tsx': 'ctrl-n/p/j/k go to the / and @ list, and the field is local while that list is open',
      'views/tools/BrowserView.tsx': 'ctrl-l edits the address; the global mod-l (quote) does the same in a browser tab',
    };
    const root = join(__dirname, '..');
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.tsx?$/.test(f) && !/\.test\./.test(f)) files.push(p); } };
    walk(root);
    const globals = new Map<string, string[]>();
    for (const os of OSES) for (const b of bindings(os)) if (b.layer === 'global' && !/^ctrl-(shift-)?tab$/.test(b.keys)) globals.set(b.keys, [...(globals.get(b.keys) || []), `${os}:${b.command}`]);
    const clashes: string[] = [];
    for (const f of files) {
      const rel = f.slice(root.length + 1).replace(/\\/g, '/');
      if (rel.startsWith('input/') || MODAL_OR_SAME[rel]) continue;
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/(?:case\s+|k0?\s*===\s*)'((?:ctrl|alt|cmd)-[^']+)'/g)) if (globals.has(m[1])) clashes.push(`${rel}: ${m[1]} is global (${globals.get(m[1])!.join(', ')})`);
    }
    expect(clashes).toEqual([]);
  });
});
