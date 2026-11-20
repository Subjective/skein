// The tool tabs: Changes, Files, an open file. (Browser is not built yet.)
import type { Tab } from '../../state/layout';
import { Icon } from '../../ui/primitives';
import { tabMeta } from '../../shell/meta';
import { ChangesView } from './ChangesView';
import { FilesView } from './FilesView';
import { FileView } from './FileView';
import { watchTurns } from './repo';
import './tools.css';

// snapshots for "Last agent turn" are taken whether or not a Changes tab is open
watchTurns();

export function ToolView({ t, focused }: { t: Tab; focused: boolean }) {
  switch (t.kind) {
    case 'changes': return <ChangesView t={t} focused={focused} />;
    case 'files': return <FilesView t={t} focused={focused} />;
    case 'file': return <FileView key={t.id} t={t} focused={focused} />;
    default: {
      const m = tabMeta(t);
      return <div className="empty"><Icon name={m.icon} size="xl" /><b>{m.title}</b><span className="dim">Not built yet.</span></div>;
    }
  }
}
