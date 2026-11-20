import { describe, expect, it } from 'vitest';
import { fuzzyScore, fuzzyTop } from './fuzzy';

describe('fuzzy', () => {
  it('rejects non-subsequences', () => { expect(fuzzyScore('xyz', 'src/app.ts')).toBe(-1); });
  it('ranks file-name matches over directory matches', () => {
    expect(fuzzyTop('pty', ['src/pty/index.ts', 'src/core/pty.ts'])[0]).toBe('src/core/pty.ts');
  });
  it('ranks word starts and runs first', () => {
    expect(fuzzyTop('ov', ['src/shell/Workspace.tsx', 'src/shell/overlays.tsx'])[0]).toBe('src/shell/overlays.tsx');
  });
  it('keeps order for an empty query', () => { expect(fuzzyTop('', ['b', 'a'])).toEqual(['b', 'a']); });
});
