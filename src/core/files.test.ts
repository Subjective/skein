import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { find } from './files';

const local = { id: 'local', name: 'This PC', link: 'up', has: [] } as never;

describe('find', () => {
  it('lists a git repo with git', async () => {
    const out = await find(local, process.cwd());
    expect(out).toContain('package.json');
    expect(out.some(p => p.startsWith('node_modules/'))).toBe(false);
  });
  it('walks a plain folder, skipping node_modules and hidden folders but not hidden files', async () => {
    const d = mkdtempSync(join(tmpdir(), 'skein-find-'));
    mkdirSync(join(d, 'a', 'node_modules'), { recursive: true }); mkdirSync(join(d, '.cache'));
    writeFileSync(join(d, 'a', 'x.txt'), ''); writeFileSync(join(d, 'a', 'node_modules', 'y.js'), '');
    writeFileSync(join(d, '.cache', 'z.log'), ''); writeFileSync(join(d, '.bashrc'), '');
    expect((await find(local, d)).sort()).toEqual(['.bashrc', 'a/x.txt']);
  });
});

describe('read and write keep a text file\'s encoding', () => {
  const local = { id: 'local', name: 'This PC', ssh: null } as unknown as import('../shared/types').Machine;
  const xml = '<?xml version="1.0"?>\n<root a="ü">x</root>\n';
  const cases: [string, Buffer][] = [
    ['utf8', Buffer.from(xml, 'utf8')],
    ['utf8 BOM (.csproj, .resx)', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(xml, 'utf8')])],
    ['utf16le BOM (Windows XML)', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')])],
    ['utf16be BOM', Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(xml, 'utf16le').swap16()])],
    ['utf16le without BOM', Buffer.from(xml, 'utf16le')],
  ];
  for (const [name, bytes] of cases) it(name, async () => {
    const { read, write } = await import('./files');
    const { readFileSync } = await import('node:fs');
    const p = join(mkdtempSync(join(tmpdir(), 'skein-enc-')), 'a.xml');
    writeFileSync(p, bytes);
    const text = await read(local, p);
    expect(text).toBe(xml);
    expect(text.includes('\u0000')).toBe(false);   // the file view's binary check
    await write(local, p, text.replace('x<', 'y<'));
    const back = readFileSync(p);
    expect(back.subarray(0, 2)).toEqual(bytes.subarray(0, 2));
    expect(back.length).toBe(bytes.length);
  });
  it('a real binary still has NUL after decoding', async () => {
    const { decodeText } = await import('./files');
    expect(decodeText(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 1, 0])).text.includes('\u0000')).toBe(true);
  });
});
