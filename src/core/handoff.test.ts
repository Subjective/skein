import { describe, expect, it } from 'vitest';
import { Handoff, TermBusy } from './handoff';
import type { TurnState } from './follow';

function setup() {
  const s = { term: true, state: 'idle' as TurnState, closed: 0 };
  const h = new Handoff({
    hasTerm: () => s.term,
    closeTerm: async () => { s.closed++; s.term = false; },
    turnState: async () => s.state,
  }, { poll: 5 });
  return { s, h };
}
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

describe('handoff between the chat view and the terminal (Claude Code)', () => {
  it('hands an idle terminal to chat at once, and leaves the TUI open', async () => {
    const { s, h } = setup();
    expect(await h.toChat('t')).toBe(true);
    expect(s.closed).toBe(0);
  });

  it('waits for the terminal turn to finish before chat drives', async () => {
    const { s, h } = setup();
    s.state = 'running';
    let done: boolean | undefined;
    void h.toChat('t').then(v => { done = v; });
    await tick();
    expect(done).toBeUndefined();
    s.state = 'idle';
    await tick();
    expect(done).toBe(true);
  });

  it('stops waiting when the terminal takes the thread back', async () => {
    const { s, h } = setup();
    s.state = 'running';
    const p = h.toChat('t');
    await tick();
    h.cancel('t');
    expect(await p).toBe(false);
  });

  it('does not wait on a terminal that has exited', async () => {
    const { s, h } = setup();
    s.state = 'running'; s.term = false;
    expect(await h.toChat('t')).toBe(true);
  });

  it('closes a parked, idle TUI before chat writes, once', async () => {
    const { s, h } = setup();
    await h.beforeSend('t');
    expect(s.closed).toBe(1);
    await h.beforeSend('t');
    expect(s.closed).toBe(1);
  });

  it('refuses to send while the parked TUI runs a turn, and keeps it open', async () => {
    const { s, h } = setup();
    s.state = 'running';
    await expect(h.beforeSend('t')).rejects.toBeInstanceOf(TermBusy);
    expect(s.closed).toBe(0);
  });
});
