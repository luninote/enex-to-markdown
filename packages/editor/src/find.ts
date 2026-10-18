import type { Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { TextSelection } from "@tiptap/pm/state";

export interface TextRange {
  from: number;
  to: number;
}

/**
 * Replaces the text of each range in one transaction, so it is one undo step of its own. Each replacement takes the
 * marks of the first character it replaces (bold stays bold, a link stays a link). Ranges that aren't inside one
 * textblock are skipped. Returns how many were replaced; nothing happens in a read-only editor.
 */
export function replaceTextRanges(editor: Editor, ranges: readonly TextRange[], text: string): number {
  if (!editor.isEditable || !ranges.length) return 0;
  const { state } = editor;
  const tr = state.tr;
  let done = 0;
  // From the end, so earlier positions stay valid.
  for (const { from, to } of [...ranges].sort((a, b) => b.from - a.from)) {
    if (from >= to || from < 0 || to > tr.doc.content.size) continue;
    const $from = tr.doc.resolve(from);
    if (!$from.parent.inlineContent || !$from.sameParent(tr.doc.resolve(to))) continue;
    if (text) tr.replaceWith(from, to, state.schema.text(text, $from.nodeAfter?.marks ?? []));
    else tr.delete(from, to);
    done++;
  }
  if (!done) return 0;
  editor.view.dispatch(closeHistory(tr));
  return done;
}

/** Selects text in the editor and focuses it without scrolling (the caller has already brought it into view). */
export function selectText(editor: Editor, { from, to }: TextRange): void {
  const { doc } = editor.state;
  const max = doc.content.size;
  const sel = TextSelection.between(doc.resolve(Math.min(from, max)), doc.resolve(Math.min(to, max)));
  editor.view.dispatch(editor.state.tr.setSelection(sel));
  editor.view.focus();
}

/** Puts the caret just after the node rendered as `dom` (a web clip) and focuses the editor without scrolling. */
export function caretAfterNode(editor: Editor, dom: Node): boolean {
  let after = -1;
  editor.state.doc.descendants((node, pos) => {
    if (after >= 0) return false;
    if (node.isAtom && editor.view.nodeDOM(pos) === dom) after = pos + node.nodeSize;
    return !node.isAtom;
  });
  if (after < 0) return false;
  const { doc } = editor.state;
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(doc.resolve(after))));
  editor.view.focus();
  return true;
}
