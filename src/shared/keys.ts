// One normal form for a key press, used by every binding.
//   modifiers in a fixed order: ctrl-alt-shift-cmd-<key>
//   printable keys keep their character (J, |, %, ?) and drop 'shift-' unless another modifier is held
//   alt + a letter reads the physical key (e.code), because option-h types ˙ on a Mac
//   named keys: esc enter tab space backspace delete up down left right home end pageup pagedown f1..f12
const NAMED: Record<string, string> = {
  Escape: 'esc', Enter: 'enter', Tab: 'tab', ' ': 'space', Backspace: 'backspace', Delete: 'delete',
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown',
};
const MODIFIER = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'OS', 'Fn', 'AltGraph']);

export interface KeyLike { key: string; code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean; isComposing?: boolean; repeat?: boolean }

/** null for a lone modifier or an IME composition. */
export function keyOf(e: KeyLike): string | null {
  if (e.isComposing || MODIFIER.has(e.key)) return null;
  let k = NAMED[e.key] ?? (/^F\d{1,2}$/.test(e.key) ? e.key.toLowerCase() : e.key);
  const letter = /^Key([A-Z])$/.exec(e.code)?.[1];
  const digit = /^Digit(\d)$/.exec(e.code)?.[1];
  const named = k.length > 1;
  // with ctrl / alt / cmd, read letters and digits by physical key so layouts and option-glyphs don't matter
  if ((e.ctrlKey || e.altKey || e.metaKey) && (letter || digit)) k = letter ? (e.shiftKey ? letter : letter.toLowerCase()) : digit!;
  if (e.ctrlKey && e.code === 'Space') k = 'space';
  if (e.ctrlKey && e.code === 'Backslash') k = '\\';
  const mods = [e.ctrlKey && 'ctrl', e.altKey && 'alt', (e.shiftKey && (named || e.ctrlKey || e.altKey || e.metaKey)) && 'shift', e.metaKey && 'cmd'].filter(Boolean);
  // ctrl-shift-a: the letter is written lower case once shift is spelled out
  if (mods.includes('shift') && k.length === 1) k = k.toLowerCase();
  return [...mods, k].join('-');
}

export const isPrintable = (k: string) => k.length === 1;
