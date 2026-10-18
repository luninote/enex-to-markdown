// The part of the editor package that doesn't load Tiptap or ProseMirror: what the app needs outside the open note
// (saving content, key handling), so the editor itself can stay in its own chunk.
export type { JSONContent } from "@tiptap/core";
export { canEdit, type NoteContent, toNoteContent } from "./content.ts";
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
export { docTaskItems, findTaskItem, setTaskItemChecked, type TaskItemInfo, type TaskRef } from "./tasks.ts";
export { SCHEMA_VERSION } from "./version.ts";
