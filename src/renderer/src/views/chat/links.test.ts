import { describe, expect, it } from 'vitest';
import { chatLink } from './links';

const D = '/Users/me/proj';
describe('chatLink', () => {
  it('sends web and mail links out', () => {
    expect(chatLink('https://example.com/a?b#c', D)).toEqual({ kind: 'external', url: 'https://example.com/a?b#c' });
    expect(chatLink('mailto:a@b.c', D)).toEqual({ kind: 'external', url: 'mailto:a@b.c' });
  });
  it('resolves relative paths against the thread folder', () => {
    expect(chatLink('mockups/index.html', D)).toEqual({ kind: 'file', dir: D, path: 'mockups/index.html' });
    expect(chatLink('./a/../b.md', D)).toEqual({ kind: 'file', dir: D, path: 'b.md' });
    expect(chatLink('my%20notes.md', D)).toEqual({ kind: 'file', dir: D, path: 'my notes.md' });
  });
  it('makes absolute paths inside the folder relative, and opens others from their own folder', () => {
    expect(chatLink('/Users/me/proj/mockups/index.html', D)).toEqual({ kind: 'file', dir: D, path: 'mockups/index.html' });
    expect(chatLink('/Users/me/proj/', D + '/')).toEqual({ kind: 'file', dir: '/Users/me', path: 'proj' });
    expect(chatLink('/etc/hosts', D)).toEqual({ kind: 'file', dir: '/etc', path: 'hosts' });
    expect(chatLink('file:///Users/me/proj/a%20b.ts', D)).toEqual({ kind: 'file', dir: D, path: 'a b.ts' });
  });
  it('reads a line (and column) from #L or :line', () => {
    expect(chatLink('src/a.ts#L12', D)).toEqual({ kind: 'file', dir: D, path: 'src/a.ts', line: 12 });
    expect(chatLink('src/a.ts#L12C4', D)).toEqual({ kind: 'file', dir: D, path: 'src/a.ts', line: 12, col: 4 });
    expect(chatLink('/Users/me/proj/src/a.ts:40', D)).toEqual({ kind: 'file', dir: D, path: 'src/a.ts', line: 40 });
    expect(chatLink('src/a.ts:40:2', D)).toEqual({ kind: 'file', dir: D, path: 'src/a.ts', line: 40, col: 2 });
  });
  it('handles Windows paths', () => {
    expect(chatLink('C:\\Users\\me\\proj\\src\\a.ts', 'C:\\Users\\me\\proj')).toEqual({ kind: 'file', dir: 'C:\\Users\\me\\proj', path: 'src/a.ts' });
    expect(chatLink('file:///C:/Users/me/proj/a.ts#L3', 'c:\\users\\me\\proj')).toEqual({ kind: 'file', dir: 'c:\\users\\me\\proj', path: 'a.ts', line: 3 });
    expect(chatLink('D:/other/x.md:7', 'C:\\proj')).toEqual({ kind: 'file', dir: 'D:/other', path: 'x.md', line: 7 });
  });
  it('goes nowhere for other schemes and empty links', () => {
    expect(chatLink('javascript:alert(1)', D)).toEqual({ kind: 'none' });
    expect(chatLink('vscode://file/x', D)).toEqual({ kind: 'none' });
    expect(chatLink('', D)).toEqual({ kind: 'none' });
  });
});
