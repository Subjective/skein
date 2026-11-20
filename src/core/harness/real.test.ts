// Against the real Claude Code CLI and account: opt in with SKEIN_REAL_CLAUDE=1 (spends a few cents of Haiku).
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ThreadEvent } from '../../shared/types';
import { createHarnesses } from '.';
import { fakeHost, until } from './test/fakes';

const text = (e: ThreadEvent) => ('text' in e ? e.text : '');

describe.skipIf(!process.env.SKEIN_REAL_CLAUDE)('real Claude Code', () => {
  it('approves, denies, forks a side chat and rewinds, with history matching live ids', async () => {
    const h = fakeHost([
      { id: 't1', harness: 'claude', sessionId: randomUUID(), dir: process.cwd(), model: 'haiku', perm: 'default' },
      { id: 's1', harness: 'claude', sessionId: randomUUID(), dir: process.cwd(), model: 'haiku', side: true },
    ]);
    const hs = createHarnesses();
    const idle = (id: string) => until(() => h.thread(id).status === 'idle' || h.thread(id).status === 'error', 90_000);
    const d = hs.driver(h.thread('t1'), h.host);
    await d.send({ text: 'Use the Write tool to create skein-probe.txt in the current folder containing "hi". Then reply with the single word written.' });
    await until(() => h.view().some(e => e.t === 'approval'), 90_000);
    const ap = h.view().find(e => e.t === 'approval')!;
    expect(ap).toMatchObject({ request: { kind: 'edit' } });
    await d.answer((ap as Extract<ThreadEvent, { t: 'approval' }>).request.requestId, 'deny');
    await idle('t1');
    expect(h.view().some(e => e.t === 'error')).toBe(false);
    await d.send({ text: 'Remember the number 41. Reply with just ok.' });
    await idle('t1');
    const reply = h.view().filter(e => e.t === 'text').pop()!;
    h.host.update('s1', { parent: { id: 't1', at: reply.id } });
    const s = hs.driver(h.thread('s1'), h.host);
    await s.send({ text: 'What number did I ask you to remember? Reply with just the number.' });
    await idle('s1');
    expect(h.events.filter(x => x.thread === 's1').map(x => text(x.e)).join(' ')).toContain('41');
    const second = h.view().filter(e => e.t === 'user')[1];
    await d.send({ text: 'Remember the number 77. Reply with just ok.', rewind: second.id } as never);
    await idle('t1');
    await d.release(); await s.release();
    const hist = await hs.history(h.thread('t1'), h.host.machine('local'));
    expect(hist.filter(e => e.t === 'user').map(text).join(' ')).toContain('77');
    expect(hist.filter(e => e.t === 'user').map(text).join(' ')).not.toContain('41');
  }, 300_000);
});
