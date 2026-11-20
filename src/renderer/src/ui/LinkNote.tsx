// The SSH link note (G5), one component for the chat view and the terminal view so both say the same thing.
// Shows nothing while the link is up. Chat: a quiet line above the composer. Terminal: a card over the
// bottom of the terminal.
import type { Machine } from '@shared/types';
import { api } from '../api';
import { Button, cx, Dot } from './primitives';

/** What to say for a machine's link, or null when there is nothing to say. Pure, for tests. */
export function linkText(m: Machine | undefined): { dot: 'amber' | 'red'; pulse: boolean; text: string; name: string; connect: boolean } | null {
  if (!m?.ssh || m.link === 'up') return null;
  const keeps = m.persist ? ' The turn keeps running there.' : '';
  switch (m.link) {
    case 'connecting': return { dot: 'amber', pulse: true, name: m.name, text: 'Connecting to {}', connect: false };
    case 'reconnecting': return { dot: 'amber', pulse: true, name: m.name, text: `Reconnecting to {}.${keeps}`, connect: false };
    case 'auth': return { dot: 'amber', pulse: false, name: m.name, text: 'Sign in to {} to continue', connect: false };
    default: return { dot: 'red', pulse: false, name: m.name, text: `{} is not connected${m.note ? ': ' + m.note : ''}`, connect: true };
  }
}

export function LinkNote({ machine, variant }: { machine: Machine | undefined; variant: 'chat' | 'term' }) {
  const t = linkText(machine);
  if (!t || !machine) return null;
  const [a, b] = t.text.split('{}');
  return (
    <div className={cx(variant === 'chat' ? 'link-note' : 't-over link')} role="status">
      <Dot color={t.dot} pulse={t.pulse} />
      <span>{a}{variant === 'term' ? <b>{t.name}</b> : t.name}{b}</span>
      {t.connect && <Button small variant="ghost" onClick={() => void api.machines.connect(machine.id)}>Connect</Button>}
    </div>
  );
}
