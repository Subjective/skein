// Against the real Antigravity CLI and account: opt in with SKEIN_REAL_AGY=1 (agy installed and signed in; runs a few
// short Gemini 3.8 Flash turns in a temporary git repo).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ThreadEvent } from '../../../shared/types';
import { createHarnesses } from '..';
import { fakeHost, until } from '../test/fakes';

const text = (e: ThreadEvent) => ('text' in e ? e.text : '');

describe.skipIf(!process.env.SKEIN_REAL_AGY)('real Antigravity', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'skein-agy-real-')));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const hs = createHarnesses();
  afterAll(() => { hs.dispose?.(); rmSync(dir, { recursive: true, force: true }); });

  it('runs turns, asks before an edit, stops, lists its models, and reads its history back', async () => {
    const h = fakeHost([{ id: 't1', harness: 'agy', dir, model: 'gemini-3.8-flash', effort: 'low', perm: 'default' }], { has: ['agy'] });
    const m = h.host.machine('local');
    const idle = () => until(() => h.thread('t1').status === 'idle' || h.thread('t1').status === 'error', 180_000);
    const started = await hs.start!(h.thread('t1'), h.host);
    expect(started.sessionId).toBeTruthy();
    const d = hs.driver(h.thread('t1'), h.host);

    await d.send({ text: 'Remember the number 41. Reply with just ok. Do not use any tools.' });
    await idle();
    expect(h.thread('t1').status).toBe('idle');
    expect(h.view().filter(e => e.t === 'text').map(text).join(' ').toLowerCase()).toContain('ok');

    await d.send({ text: 'Create a file hello.txt in the current directory containing exactly the text: hi' });
    await until(() => h.view().some(e => e.t === 'approval') || h.thread('t1').status === 'idle', 180_000);
    const ap = h.view().find(e => e.t === 'approval') as Extract<ThreadEvent, { t: 'approval' }> | undefined;
    expect(ap?.request.kind).toBe('edit');
    await d.answer(ap!.request.requestId, ap!.request.options.find(o => o.primary)!.id);
    await idle();
    expect(readFileSync(join(dir, 'hello.txt'), 'utf8')).toBe('hi');
    expect(h.view().find(e => e.t === 'edit')).toMatchObject({ path: 'hello.txt', status: 'done' });

    await d.send({ text: 'Write a 2000 word essay about the history of the loom. Do not use tools.' });
    await until(() => h.view().some(e => e.t === 'text' && 'streaming' in e && !!e.streaming), 180_000);
    await d.interrupt();
    await idle();
    expect(h.view().some(e => e.t === 'interrupted')).toBe(true);

    const o = await hs.options!(m, 'agy');
    expect(o.source).toBe('harness');
    expect(o.models.some(x => x.id === 'gemini-3.8-flash')).toBe(true);

    const hist = await hs.history(h.thread('t1'), m);
    expect(hist.filter(e => e.t === 'user').map(text).join(' ')).toContain('Remember the number 41');
    expect(hist.some(e => e.t === 'edit')).toBe(true);
    const found = await hs.sessions!(m, 50);
    expect(found.some(f => f.harness === 'agy' && f.sessionId === h.thread('t1').sessionId)).toBe(true);
  }, 600_000);
});
