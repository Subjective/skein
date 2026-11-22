import { describe, expect, it } from 'vitest';
import { linkTarget, normalize, slug, slugger } from './mdlinks';

describe('markdown links', () => {
  it('opens web and mail links outside', () => {
    expect(linkTarget('https://example.com/a?b#c', 'AGENTS.md')).toEqual({ kind: 'external', url: 'https://example.com/a?b#c' });
    expect(linkTarget('HTTP://x.dev', 'a.md')).toEqual({ kind: 'external', url: 'HTTP://x.dev' });
    expect(linkTarget('mailto:me@example.com', 'a.md').kind).toBe('external');
  });
  it('refuses other schemes', () => {
    for (const h of ['javascript:alert(1)', 'file:///etc/passwd', 'vscode://x', '//cdn.example.com/x', '', '  ']) expect(linkTarget(h, 'a.md')).toEqual({ kind: 'none' });
  });
  it('resolves paths from the file\'s folder', () => {
    expect(linkTarget('HANDOFF.md', 'AGENTS.md')).toEqual({ kind: 'file', path: 'HANDOFF.md' });
    expect(linkTarget('docs/VIM-MODEL.md', 'AGENTS.md')).toEqual({ kind: 'file', path: 'docs/VIM-MODEL.md' });
    expect(linkTarget('../README.md', 'docs/VIM-MODEL.md')).toEqual({ kind: 'file', path: 'README.md' });
    expect(linkTarget('./x.ts', 'src/a/b.md')).toEqual({ kind: 'file', path: 'src/a/x.ts' });
    expect(linkTarget('/package.json', 'docs/a.md')).toEqual({ kind: 'file', path: 'package.json' });
    expect(linkTarget('My%20Notes.md?plain=1', 'a.md')).toEqual({ kind: 'file', path: 'My Notes.md' });
    expect(linkTarget('docs/', 'a.md')).toEqual({ kind: 'file', path: 'docs' });
  });
  it('keeps a heading or a line', () => {
    expect(linkTarget('#Keyboard-and-focus', 'a.md')).toEqual({ kind: 'anchor', slug: 'keyboard-and-focus' });
    expect(linkTarget('docs/VIM-MODEL.md#the-rules', 'AGENTS.md')).toEqual({ kind: 'file', path: 'docs/VIM-MODEL.md', slug: 'the-rules' });
    expect(linkTarget('src/a.ts#L12', 'a.md')).toEqual({ kind: 'file', path: 'src/a.ts', line: 12 });
    expect(linkTarget('src/a.ts#L12-L20', 'a.md')).toEqual({ kind: 'file', path: 'src/a.ts', line: 12 });
    expect(linkTarget('#', 'a.md')).toEqual({ kind: 'none' });
  });
  it('normalizes', () => {
    expect(normalize('a/./b/../c')).toBe('a/c');
    expect(normalize('../x')).toBe('../x');
    expect(normalize('a/../../x')).toBe('../x');
  });
  it('slugs headings as GitHub does', () => {
    expect(slug('Keyboard and focus')).toBe('keyboard-and-focus');
    expect(slug('What’s `new`? (v2.0)')).toBe('whats-new-v20');
    const s = slugger();
    expect([s('Setup'), s('Setup'), s('Setup')]).toEqual(['setup', 'setup-1', 'setup-2']);
  });
});
