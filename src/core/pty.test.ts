import { describe, expect, it } from 'vitest';
import type { SkeinEvent } from '../shared/api';
import type { Machine } from '../shared/types';
import { setSink } from './events';
import { Ptys, ptyAvailable } from './pty';

const local = { id: 'local', name: 'This computer', link: 'up' } as unknown as Machine;

describe.skipIf(!ptyAvailable())('Ptys', () => {
  it('a handoff close waits for the program to exit and says why, so the view resumes instead of showing an exit', async () => {
    const got: SkeinEvent[] = [];
    setSink(e => got.push(e));
    const ptys = new Ptys(() => local);
    const a = ptys.spawn({ machine: 'local', cwd: process.cwd(), thread: 't1', run: { kind: 'shell' }, cols: 80, rows: 24 });
    const b = ptys.spawn({ machine: 'local', cwd: process.cwd(), thread: 't2', run: { kind: 'shell' }, cols: 80, rows: 24 });
    expect(ptys.hasThread('t1')).toBe(true);
    await ptys.killThread('t1', { handoff: true });
    expect(ptys.hasThread('t1')).toBe(false);
    expect(got.find(e => e.type === 'pty.exit' && e.id === a)).toMatchObject({ handoff: true });
    await ptys.kill(b);
    const exitB = got.find(e => e.type === 'pty.exit' && e.id === b);
    expect(exitB && 'handoff' in exitB).toBe(false);
  });
});
