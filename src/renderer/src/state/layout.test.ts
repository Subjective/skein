import { describe, expect, it } from 'vitest';
import { leaves, mkPane, mkTab, neighbour, placeFor, removePane, resize, splitAt, type Rect, type Split } from './layout';

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

// Where a file opens (Josh, 2026-11-21: opening files kept splitting panes). VS Code's rule.
describe('where a file opens', () => {
  it('from a thread with nothing beside it: a new split', () => {
    const th = mkPane(mkTab('thread'));
    expect(placeFor(th, th, null)).toBe('split');
  });
  it('from a thread with a side pane: a tab there, not another split', () => {
    const th = mkPane(mkTab('thread')), side = mkPane(mkTab('changes'));
    expect(placeFor(splitAt(th, th.id, 'row', side), th, side)).toBe(side);
  });
  it('from a thread whose right neighbour is another thread, with a file pane elsewhere: the file pane', () => {
    const a = mkPane(mkTab('thread')), b = mkPane(mkTab('thread')), files = mkPane(mkTab('file'));
    let root = splitAt(a, a.id, 'row', b); root = splitAt(root, b.id, 'col', files);
    expect(placeFor(root, a, b)).toBe(files);
  });
  it('from a thread beside another thread and no file pane: a tab in the pane to the right', () => {
    const a = mkPane(mkTab('thread')), b = mkPane(mkTab('shell'));
    expect(placeFor(splitAt(a, a.id, 'row', b), a, b)).toBe(b);
  });
  it('from a pane that shows files or tools: a tab in that same pane', () => {
    for (const k of ['file', 'files', 'changes', 'browser'] as const) {
      const th = mkPane(mkTab('thread')), side = mkPane(mkTab(k));
      expect(placeFor(splitAt(th, th.id, 'row', side), side, null), k).toBe(side);
    }
  });
  it('a pane counts by the tab it shows: a thread in front of a file tab is a thread pane', () => {
    const f = mkTab('file'), th = mkTab('thread'), mixed = mkPane(f, th); mixed.active = th.id;
    const right = mkPane(mkTab('changes'));
    expect(placeFor(splitAt(mixed, mixed.id, 'row', right), mixed, right)).toBe(right);
  });
});
