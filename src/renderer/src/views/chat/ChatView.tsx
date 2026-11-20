// The chat view of a thread. Placeholder until the chat workstream lands (see HANDOFF "Workstreams"):
// it says what it is and points at the terminal view, which works today.
import type { Tab } from '../../state/layout';
import { thread } from '../../state/store';
import * as A from '../../state/actions';
import { Button, Icon } from '../../ui/primitives';
import { harnessName } from '../../shell/meta';

export function ChatView({ t }: { t: Tab; focused: boolean }) {
  const th = thread(t.thread);
  if (!th) return <div className="empty">This thread is gone.</div>;
  return (
    <div className="empty chat-pending">
      <Icon name={th.harness} size="xl" />
      <b>{th.title}</b>
      <span className="dim">The chat view for {harnessName(th.harness)} is coming. The terminal view runs this thread now.</span>
      <Button small variant="primary" icon="terminal" onClick={() => A.setView(t, 'term')}>Show terminal</Button>
    </div>
  );
}
