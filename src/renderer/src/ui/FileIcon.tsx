// File-type icons (Catppuccin's set, vendored by scripts/gen-file-icons.mjs). Colours are var(--ci-*) tokens that
// follow the theme; the size is the shared icon size (svg.fi in styles/skein.css, 14px like other row icons).
import { cx } from './primitives';
import { BY_EXT, BY_NAME, BY_PATTERN, DIRS, ICONS } from './fileIcons.gen';

const baseName = (p: string) => p.replace(/[\\/]+$/, '').replace(/^.*[\\/]/, '');

/** The icon name for a path: exact file name, then name pattern, then extension, then a plain file. */
export function fileIconName(path: string, dir?: boolean, open?: boolean): string {
  const n = baseName(path).toLowerCase();
  if (dir) { const d = DIRS[n] || 'folder'; return open ? d + '-open' : d; }
  if (BY_NAME[n]) return BY_NAME[n];
  for (const [re, ic] of BY_PATTERN) if (re.test(n)) return ic;
  const ext = n.lastIndexOf('.') > 0 ? n.slice(n.lastIndexOf('.') + 1) : '';
  return BY_EXT[ext] || 'file';
}

/** The svg as markup, for places that build DOM by hand (the lifted tab during a drag). */
export function fileIconHtml(path: string, dir?: boolean, open?: boolean, className?: string): string {
  const name = fileIconName(path, dir, open);
  return `<svg class="${cx('fi', className)}" data-icon="${name}" viewBox="0 0 16 16" aria-hidden="true">${ICONS[name]}</svg>`;
}

export function FileIcon({ path, dir, open, className }: { path: string; dir?: boolean; open?: boolean; className?: string }) {
  const name = fileIconName(path, dir, open);
  return <svg className={cx('fi', className)} data-icon={name} viewBox="0 0 16 16" aria-hidden="true" dangerouslySetInnerHTML={{ __html: ICONS[name] }} />;
}
