import { describe, expect, it } from 'vitest';
import { leaves, mkPane, mkTab, neighbour, removePane, resize, splitAt, type Rect, type Split } from './layout';

describe('pane tree', () => {
  it('splits, resizes and removes panes', () => {
    const a = mkPane(mkTab('new')), b = mkPane(mkTab('shell')), c = mkPane(mkTab('changes'));
    let root = splitAt(a, a.id, 'row', b);
    root = splitAt(root, b.id, 'col', c);
    expect(leaves(root).map(p => p.id)).toEqual([a.id, b.id, c.id]);
    resize(root, a.id, 'row', 0.1);
    expect((root as Split).ratio).toBeCloseTo(0.6);
    const r = removePane(root, b.id)!;
    expect(leaves(r.root).map(p => p.id)).toEqual([a.id, c.id]);
    expect(r.focus).toBe(c.id);
    expect(removePane(a, a.id)).toBeNull();
  });
  it('finds neighbours by rectangle', () => {
    const R = (l: number, t: number, r: number, b: number): Rect => ({ left: l, top: t, right: r, bottom: b });
    const m = new Map([['L', R(0, 0, 100, 200)], ['TR', R(100, 0, 200, 100)], ['BR', R(100, 100, 200, 200)]]);
    expect(neighbour(m, 'L', 'l')).toBe('TR');
    expect(neighbour(m, 'BR', 'h')).toBe('L');
    expect(neighbour(m, 'TR', 'j')).toBe('BR');
    expect(neighbour(m, 'L', 'h')).toBeNull();
  });
});
