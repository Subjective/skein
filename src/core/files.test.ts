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
  it('walks a plain folder, skipping node_modules', async () => {
    const d = mkdtempSync(join(tmpdir(), 'skein-find-'));
    mkdirSync(join(d, 'a', 'node_modules'), { recursive: true });
    writeFileSync(join(d, 'a', 'x.txt'), ''); writeFileSync(join(d, 'a', 'node_modules', 'y.js'), '');
    expect(await find(local, d)).toEqual(['a/x.txt']);
  });
});
