// A side chat is a real fork: the harness's record of it starts with the parent's conversation up to the fork
// point, which the model keeps as context. The side chat shows only what came after (the mockup's side chat: the
// fork marker, then its own messages), so its history drops the turns it carried over.
import type { ThreadEvent } from '../shared/types';

/** How many of your messages a fork at `at` carries over: those up to that event (all of them when it is not found). */
export function carriedPrompts(parent: ThreadEvent[], at?: string): number {
  const i = at ? parent.findIndex(e => e.id === at) : -1;
  return (i >= 0 ? parent.slice(0, i + 1) : parent).filter(e => e.t === 'user').length;
}

/** A side chat's own events: everything from its first message of its own on. */
export function ownEvents(events: ThreadEvent[], carried: number): ThreadEvent[] {
  if (carried <= 0) return events;
  let n = 0;
  const i = events.findIndex(e => e.t === 'user' && ++n > carried);
  return i < 0 ? [] : events.slice(i);
}
