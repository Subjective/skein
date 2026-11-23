// A file's language for the code editor: Lezer grammars by file name, from @codemirror/language-data, each loaded
// the first time a file needs it (one small chunk per language).
import { LanguageDescription, type LanguageSupport } from '@codemirror/language';
import { languages } from '@codemirror/language-data';

const loaded = new Map<string, Promise<LanguageSupport | null>>();
/** Extra names language-data does not know, as Skein's badges do (views/tools/highlight.ts). */
const ALIAS: Record<string, string> = { '.bashrc': 'x.sh', '.zshrc': 'x.sh', '.profile': 'x.sh', vimrc: 'x.vim', '.vimrc': 'x.vim', '.gitignore': 'x.properties', '.npmrc': 'x.properties', '.editorconfig': 'x.properties', 'pnpm-lock.yaml': 'x.yaml' };

export function languageFor(path: string): Promise<LanguageSupport | null> {
  const name = path.replace(/^.*[\\/]/, '');
  const d = LanguageDescription.matchFilename(languages, ALIAS[name.toLowerCase()] || (name.toLowerCase().startsWith('.env') ? 'x.properties' : name));
  if (!d) return Promise.resolve(null);
  let p = loaded.get(d.name);
  if (!p) { p = d.load().catch(() => null); loaded.set(d.name, p); }
  return p;
}
