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
  // the diff view (the file's ⋯ menu): added lines marked, the last commit's removed lines drawn above where they were
  '&.diffv .cm-line.add': { boxShadow: 'inset 3px 0 0 var(--green)', backgroundColor: 'var(--add-bg)' },
  '.cm-gone .del': { padding: '0 14px 0 4px', boxShadow: 'inset 3px 0 0 var(--red)', backgroundColor: 'var(--del-bg)', color: 'var(--fg-3)', whiteSpace: 'pre', userSelect: 'none' },
  '.cm-lineWrapping .cm-gone .del': { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
  // no line numbers: the text keeps a margin from the edge
  '&.nonum .cm-line, &.nonum .cm-gone .del': { paddingLeft: '14px' },
  // the live Preview (editor/markdown.ts): the preview's type (.doc / .prose) on the file's own text
  '&.md-live': { font: '14px/1.650 var(--sans)' },
  '&.md-live .cm-content': { maxWidth: '760px', padding: '14px 0 32px' },
  '&.md-live .cm-line': { padding: '0 22px' },
  '&.md-live .cm-activeLine:not(.md-fence):not(.md-table)': { backgroundColor: 'transparent' },
  '.md-h': { fontWeight: '600' },
  // spacing as the reader had it: a heading's gap above it, a blank line a paragraph's gap (.6em), not a line's
  '.md-h1': { fontSize: '21px', lineHeight: '1.5', paddingTop: '.15em !important' },
  '.md-h2': { fontSize: '16px', paddingTop: '.55em !important' },
  '.md-h3, .md-h4, .md-h5, .md-h6': { fontSize: '14px', paddingTop: '.3em !important' },
  '.md-blank': { lineHeight: '9px', fontSize: '9px' },
  '.md-strong': { fontWeight: '600' },
  '.md-em': { fontStyle: 'italic' },
  '.md-s': { textDecoration: 'line-through' },
  '.md-code': { font: 'var(--mono-w) 12.5px var(--mono)', background: 'var(--code)', borderRadius: '5px', padding: '1.5px 3px' },
  '.md-link': { color: 'var(--blue)' },
  '.md-dim': { color: 'var(--fg-4)' },
  '.md-bullet': { display: 'inline-block', width: '.9em', color: 'var(--fg-3)' },
  '.md-check': { display: 'inline-block', width: '13px', height: '13px', margin: '0 2px -2px 0', border: '1.5px solid var(--fg-4)', borderRadius: '4px', boxSizing: 'border-box', cursor: 'pointer', verticalAlign: 'baseline' },
  '.md-check.on': { background: 'var(--blue)', borderColor: 'var(--blue)', boxShadow: 'inset 0 0 0 2px var(--bg)' },
  '.md-quote': { marginLeft: '22px', borderLeft: '2px solid var(--line-2)', paddingLeft: '10px !important', color: 'var(--fg-2)' },
  '.md-rule': { display: 'inline-block', width: '100%', borderTop: '1px solid var(--line)', verticalAlign: 'middle' },
  // raw where rendering cannot be edited sanely: tables and fenced code, in a code block
  '.md-fence, .md-table': { font: 'var(--mono-w) 12px/1.6 var(--mono)', backgroundColor: 'var(--code) !important', margin: '0 8px', padding: '0 14px !important' },
  '.md-fence.md-first, .md-table.md-first': { borderTopLeftRadius: '10px', borderTopRightRadius: '10px', paddingTop: '8px !important' },
  '.md-fence.md-last, .md-table.md-last': { borderBottomLeftRadius: '10px', borderBottomRightRadius: '10px', paddingBottom: '8px !important' },
  // a table, drawn: hairlines and a header row, as in a chat reply
  '.md-tbl': { margin: '2px 8px 6px', border: '1px solid var(--line)', borderRadius: '8px', overflowX: 'auto', cursor: 'text' },
  '.md-tbl table': { borderCollapse: 'collapse', font: '13px/1.5 var(--sans)', minWidth: '100%' },
  '.md-tbl th, .md-tbl td': { padding: '6px 13px', borderBottom: '1px solid var(--line)', textAlign: 'left', verticalAlign: 'top' },
  '.md-tbl th': { fontWeight: '600', background: 'var(--bg-2)', whiteSpace: 'nowrap' },
  '.md-tbl tbody tr:last-child td': { borderBottom: '0' },
  '.md-tbl td + td, .md-tbl th + th': { borderLeft: '1px solid var(--line)' },
  // V-LINE in the preview: the text column only, the same left edge as the text, quotes and code
  '&.md-live .cm-line.vsel, &.md-live.has-sel .cm-line.vsel': { backgroundColor: 'transparent', backgroundImage: 'linear-gradient(var(--sel), var(--sel))', backgroundClip: 'content-box' },
  '&.md-live .cm-line.vsel.md-fence, &.md-live .cm-line.vsel.md-table': { backgroundImage: 'linear-gradient(var(--sel), var(--sel)), linear-gradient(var(--code), var(--code))', backgroundClip: 'content-box, border-box' },
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
