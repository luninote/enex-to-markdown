import { TaskItem as BaseTaskItem } from "@tiptap/extension-list";

/** A strict ISO 8601 instant, or null for anything `Date` can't read. */
export function normalizeDue(value: string | null | undefined): string | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * A checkbox item. With a `taskId` it is an Evernote Task (searched by `contains:task`), otherwise a plain checkbox
 * (`contains:enTodo`). None of the task attributes survive Enter: a split must not produce two items with one id.
 */
export const TaskItem = BaseTaskItem.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      taskId: {
        default: null,
        validate: "string|null",
        keepOnSplit: false,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-task-id") || null,
        renderHTML: (attrs: Record<string, unknown>) => (attrs.taskId ? { "data-task-id": String(attrs.taskId) } : {}),
      },
      due: {
        default: null,
        validate: "string|null",
        keepOnSplit: false,
        parseHTML: (el: HTMLElement) => normalizeDue(el.getAttribute("data-due")),
        renderHTML: (attrs: Record<string, unknown>) => (attrs.due ? { "data-due": String(attrs.due) } : {}),
      },
      flagged: {
        default: false,
        validate: "boolean",
        keepOnSplit: false,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-flagged") === "true",
        renderHTML: (attrs: Record<string, unknown>) => (attrs.flagged ? { "data-flagged": "true" } : {}),
      },
    };
  },
});
