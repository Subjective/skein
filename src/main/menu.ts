// Our own application menu (G3). It carries only keys that are safe to take from the renderer:
// on a Mac the standard app / edit roles (cmd-q, cmd-c, cmd-v, ...) so text fields work; on Windows nothing
// with ctrl, because ctrl-w, ctrl-tab, ctrl-k, ctrl-shift-a and friends belong to the renderer's keymap.
import { Menu, type MenuItemConstructorOptions } from 'electron';

export function buildMenu(command: (c: string) => void): Menu {
  const mac = process.platform === 'darwin';
  const t: MenuItemConstructorOptions[] = [];
  if (mac) t.push({ role: 'appMenu' });
  t.push({
    label: 'Edit',
    submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }],
  });
  t.push({
    label: 'View',
    submenu: [
      { label: 'Settings', accelerator: mac ? 'Cmd+,' : undefined, click: () => command('settings') },
      { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
      { role: 'toggleDevTools', accelerator: mac ? 'Alt+Cmd+I' : 'F12' },
      { role: 'reload', accelerator: mac ? 'Cmd+Shift+R' : 'F5' },
    ],
  });
  // Not the stock window menu: its cmd-w would close the window instead of the tab.
  if (mac) t.push({ label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }] });
  return Menu.buildFromTemplate(t);
}
