// Changes, Files, an open file, Browser. Placeholder until the tools workstream lands.
import type { Tab } from '../../state/layout';
import { Icon } from '../../ui/primitives';
import { tabMeta } from '../../shell/meta';

export function ToolView({ t }: { t: Tab; focused: boolean }) {
  const m = tabMeta(t);
  return <div className="empty"><Icon name={m.icon} size="xl" /><b>{m.title}</b><span className="dim">Not built yet.</span></div>;
}
