import { type Editor, Extension } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";
import type { Alignment } from "./blockFormat.ts";
import { DEFAULT_HIGHLIGHT } from "./colors.ts";
import { IS_MAC, type ShortcutName, shortcutBindings } from "./shortcutKeys.ts";

export {
  appOnlyKeys,
  IS_APP,
  IS_MAC,
  SHORTCUT_NAMES,
  type ShortcutName,
  shortcutBindings,
  shortcutKeys,
  shortcutLabel,
} from "./shortcutKeys.ts";

/** The date or time as the reader's own locale writes it: "October 14, 2026", "3:42 PM". */
export function dateStamp(kind: "date" | "time", now = new Date(), locale?: string): string {
  return new Intl.DateTimeFormat(locale, kind === "date" ? { dateStyle: "long" } : { timeStyle: "short" }).format(now);
}

/** The innermost list item around the selection: lists nest, and the item type decides what indent does. */
function listItemName(state: EditorState): "listItem" | "taskItem" | null {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const name = $from.node(d).type.name;
    if (name === "listItem" || name === "taskItem") return name;
  }
  return null;
}

export interface FamiliarShortcutsStorage {
  /** Set by the toolbar: Mod-K opens its link dialog. Without it the key does nothing in the editor. */
  openLink: (() => void) | null;
}

declare module "@tiptap/core" {
  interface Storage {
    familiarShortcuts: FamiliarShortcutsStorage;
  }
  interface Commands<ReturnType> {
    familiarShortcuts: {
      /** Removes text formatting (marks) from the selection, keeping links. */
      clearFormatting: () => ReturnType;
      /** Removes fonts, sizes, colors and highlights from the selection, keeping bold, italic, links and the rest. */
      simplifyFormatting: () => ReturnType;
      indentListItem: () => ReturnType;
      outdentListItem: () => ReturnType;
      /** A list item one level in, or else the paragraphs and headings one indent step (schema v3). */
      indent: () => ReturnType;
      outdent: () => ReturnType;
      toggleDefaultHighlight: () => ReturnType;
    };
  }
}

export const FamiliarShortcuts = Extension.create<Record<string, never>, FamiliarShortcutsStorage>({
  name: "familiarShortcuts",
  // Ahead of the built-in bindings, so the familiar meaning of a key wins where both bind it.
  priority: 200,

  addStorage: () => ({ openLink: null }),

  addCommands() {
    return {
      clearFormatting:
        () =>
        ({ state, tr, dispatch }) => {
          if (dispatch) {
            const marks = Object.values(state.schema.marks).filter((m) => m.name !== "link");
            for (const range of state.selection.ranges) {
              for (const mark of marks) tr.removeMark(range.$from.pos, range.$to.pos, mark);
            }
            tr.setStoredMarks(
              (state.storedMarks ?? state.selection.$from.marks()).filter((m) => m.type.name === "link"),
            );
          }
          return true;
        },
      simplifyFormatting:
        () =>
        ({ state, tr, dispatch }) => {
          if (dispatch) {
            const marks = ["textStyle", "highlight"].flatMap((name) => state.schema.marks[name] ?? []);
            for (const range of state.selection.ranges) {
              for (const mark of marks) tr.removeMark(range.$from.pos, range.$to.pos, mark);
            }
            tr.setStoredMarks(
              (state.storedMarks ?? state.selection.$from.marks()).filter((m) => !marks.includes(m.type)),
            );
          }
          return true;
        },
      indentListItem:
        () =>
        ({ state, commands }) => {
          const item = listItemName(state);
          return item ? commands.sinkListItem(item) : false;
        },
      outdentListItem:
        () =>
        ({ state, commands }) => {
          const item = listItemName(state);
          return item ? commands.liftListItem(item) : false;
        },
      indent:
        () =>
        ({ commands }) =>
          commands.indentListItem() || commands.indentBlock(),
      outdent:
        () =>
        ({ commands }) =>
          commands.outdentListItem() || commands.outdentBlock(),
      toggleDefaultHighlight:
        () =>
        ({ editor, commands }) =>
          editor.isActive("highlight")
            ? commands.unsetHighlight()
            : commands.setHighlight({ color: DEFAULT_HIGHLIGHT }),
    };
  },

  addKeyboardShortcuts() {
    const editor: Editor = this.editor;
    const storage = this.storage;
    // Always handled, even where the block can't be aligned (a code block): on Windows Ctrl+E would otherwise fall
    // through to Tiptap's own inline-code key.
    const align = (to: Alignment) => () => {
      editor.commands.setTextAlign(to);
      return true;
    };
    const stamp = (kind: "date" | "time") => () => editor.isEditable && editor.commands.insertContent(dateStamp(kind));
    const run: Partial<Record<ShortcutName, () => boolean>> = {
      alignLeft: align("left"),
      alignCenter: align("center"),
      alignRight: align("right"),
      justify: align("justify"),
      code: () => editor.commands.toggleCode(),
      removeLink: () => editor.isActive("link") && editor.chain().extendMarkRange("link").unsetLink().run(),
      insertDate: stamp("date"),
      insertTime: stamp("time"),
      simplifyFormatting: () => editor.commands.simplifyFormatting(),
      strike: () => editor.commands.toggleStrike(),
      highlight: () => editor.commands.toggleDefaultHighlight(),
      bulletList: () => editor.commands.toggleBulletList(),
      orderedList: () => editor.commands.toggleOrderedList(),
      taskList: () => editor.commands.toggleTaskList(),
      indent: () => editor.commands.indent(),
      outdent: () => editor.commands.outdent(),
      superscript: () => editor.commands.toggleSuperscript(),
      subscript: () => editor.commands.toggleSubscript(),
      codeBlock: () => editor.commands.toggleCodeBlock(),
      horizontalRule: () => editor.commands.setHorizontalRule(),
      clearFormatting: () => editor.commands.clearFormatting(),
      link: () => {
        if (!storage.openLink || !editor.isEditable) return false;
        storage.openLink();
        return true;
      },
    };
    const keys: Record<string, () => boolean> = {};
    for (const [name, fn] of Object.entries(run) as [ShortcutName, () => boolean][]) {
      for (const key of shortcutBindings(name)) if (key !== "Tab" && key !== "Shift-Tab") keys[key] = fn;
    }
    // On a Mac, Tab indents a paragraph. In a list or a table it's left to them (indent the item,
    // next cell), and an empty bit of the note keeps Tab for leaving the editor.
    if (IS_MAC) {
      const plain = () => !editor.isActive("table") && listItemName(editor.state) === null;
      keys.Tab = () => plain() && editor.commands.indentBlock();
      keys["Shift-Tab"] = () => plain() && editor.commands.outdentBlock();
    }
    return keys;
  },
});
