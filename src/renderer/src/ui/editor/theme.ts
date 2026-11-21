// The code editor's look, from Skein's tokens only (skein.css :root), so light and dark follow the theme with no
// second palette: syntax colours are the --sx-* tokens the diff reader uses, the selection is --sel everywhere, the
// NORMAL cursor is the reader's block (fg on bg), search hits are --hit.
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

export const skeinTheme = EditorView.theme({
  '&': { height: '100%', color: 'var(--fg)', backgroundColor: 'transparent', font: 'var(--mono-w) 12px/1.650 var(--mono)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: 'inherit', overflow: 'auto' },
  '.cm-content': { padding: '0 0 10px', caretColor: 'var(--fg)', tabSize: '4' },
  '.cm-line': { padding: '0 14px 0 4px' },
  // INSERT's thin caret, and Vim's block cursor in NORMAL and VISUAL: the reader's (.vc)
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--fg)' },
  '.cm-fat-cursor': { background: 'var(--fg) !important', color: 'var(--bg) !important', borderRadius: '1px', outline: 'none !important' },
  '&:not(.cm-focused) .cm-fat-cursor': { background: 'none !important', outline: '1px solid var(--fg-4) !important', color: 'inherit !important' },
  // one selection colour in v, V and with the mouse
  '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': { background: 'var(--sel) !important' },
  '.cm-content ::selection': { background: 'transparent !important' },
  // the cursor's line, as in a reader; not while there is a selection (it would read as a second one)
  '.cm-activeLine': { backgroundColor: 'var(--hover)' },
  '&.has-sel .cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--fg-4)', border: 'none', userSelect: 'none' },
  '.cm-lineNumbers .cm-gutterElement': { minWidth: '48px', padding: '0 10px 0 0', boxSizing: 'border-box' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--hover)', color: 'var(--fg-2)' },
  '&.has-sel .cm-activeLineGutter': { backgroundColor: 'transparent' },
  // V-LINE: whole lines, the text area only
  '.cm-line.vsel, &.has-sel .cm-line.vsel': { backgroundColor: 'var(--sel)' },
  '&.vline .cm-selectionLayer': { display: 'none' },
  // lines changed since the last commit: a bar at the gutter's edge (green added, amber changed, a red notch where lines went)
  '.cm-lineNumbers .cm-gutterElement.g-add': { boxShadow: 'inset 3px 0 0 var(--green)', color: 'var(--fg-2)' },
  '.cm-lineNumbers .cm-gutterElement.g-chg': { boxShadow: 'inset 3px 0 0 var(--amber)', color: 'var(--fg-2)' },
  '.cm-lineNumbers .cm-gutterElement.g-del': { boxShadow: 'inset 3px -2px 0 -1px var(--red)' },
  '.hit': { background: 'var(--hit)', borderRadius: '2px' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--active)', outline: 'none' },
  // Vim's own prompt, if a key reaches it (a count before :): Skein's popup surface, not a browser-default bar
  '.cm-panels': { backgroundColor: 'var(--pop)', color: 'var(--fg)', borderTop: '1px solid var(--line)' },
  '.cm-panels input': { background: 'none', border: 0, outline: 0, color: 'var(--fg)', font: 'inherit' },
});

const style = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.definitionKeyword, t.operatorKeyword, t.modifier, t.self, t.null, t.bool], color: 'var(--sx-k)' },
  { tag: [t.string, t.special(t.string), t.character, t.regexp, t.url, t.inserted], color: 'var(--sx-s)' },
  { tag: [t.number, t.integer, t.float, t.atom, t.escape], color: 'var(--sx-n)' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--sx-c)', fontStyle: 'italic' },
  { tag: [t.typeName, t.className, t.namespace, t.tagName, t.standard(t.typeName), t.heading], color: 'var(--sx-t)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName, t.attributeName, t.labelName], color: 'var(--sx-f)' },
  { tag: [t.meta, t.processingInstruction, t.punctuation, t.separator, t.angleBracket], color: 'var(--fg-3)' },
  { tag: t.heading, fontWeight: '600' },
  { tag: t.strong, fontWeight: '600' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.link, color: 'var(--blue)' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: [t.deleted, t.invalid], color: 'var(--red)' },
  { tag: t.monospace, color: 'var(--sx-s)' },
]);
export const skeinHighlight = syntaxHighlighting(style);
