import { describe, expect, it } from 'vitest';
import { gutterMarks } from '@shared/gutter';
import { diffLines, toHunks } from './linediff';

const apply = (a: string[], d: ReturnType<typeof diffLines>) => d.filter(l => l.k !== '-').map(l => l.text);
describe('line diff', () => {
  it('turns one text into the other with the fewest edits', () => {
    const a = 'a b c d e f g'.split(' '), b = 'a x c d f g h'.split(' ');
    const d = diffLines(a, b);
    expect(apply(a, d)).toEqual(b);
    expect(d.filter(l => l.k !== ' ').map(l => l.k + l.text)).toEqual(['-b', '+x', '-e', '+h']);
  });
  it('numbers both sides and groups hunks like git -U3', () => {
    const a = Array.from({ length: 20 }, (_, i) => 'l' + i), b = [...a]; b[2] = 'X'; b.splice(15, 0, 'NEW');
    const h = toHunks(diffLines(a, b));
    expect(h.map(x => [x.a, x.an, x.b, x.bn])).toEqual([[1, 6, 1, 6], [13, 6, 13, 7]]);
    expect(gutterMarks(h)).toEqual({ add: [16], chg: [3], del: [] });
  });
  it('handles empty sides', () => {
    expect(toHunks(diffLines([], ['a', 'b']))[0]).toMatchObject({ a: 0, an: 0, b: 1, bn: 2 });
    expect(toHunks(diffLines(['a'], [])).length).toBe(1);
    expect(toHunks(diffLines(['a'], ['a']))).toEqual([]);
  });
});
