// Checkbox items as the Tasks view sees them. Pure JSON, no editor: the server applies a
// check made in the list to the note's current document with the same functions the browser uses.

type Node = { type?: string; text?: string; attrs?: Record<string, unknown>; content?: Node[] };

const LISTS = new Set(["taskList", "bulletList", "orderedList"]);

/** One checkbox item: its position among the document's items, and its own words (not its sub-items'). */
export type TaskItemInfo = {
  index: number;
  text: string;
  checked: boolean;
  due: string | null;
  flagged: boolean;
  /** An Evernote Task (it has a task id), not a plain checkbox. */
  evernoteTask: boolean;
};

/** What a check names: the item's position and words when the list was shown. */
export type TaskRef = { index: number; text: string };

function ownText(item: Node): string {
  let out = "";
  const walk = (n: Node) => {
    if (n.type === "text") out += n.text ?? "";
    else if (n.type === "hardBreak") out += " ";
    else if (!LISTS.has(n.type ?? "")) for (const c of n.content ?? []) walk(c);
  };
  for (const c of item.content ?? []) {
    if (LISTS.has(c.type ?? "")) continue;
    if (out) out += " ";
    walk(c);
  }
  return out.replace(/\s+/g, " ").trim();
}

function forEachItem(doc: unknown, fn: (item: Node, index: number) => void): void {
  let index = 0;
  const stack: Node[] = [doc as Node];
  while (stack.length) {
    const n = stack.pop() as Node;
    if (!n || typeof n !== "object") continue;
    if (n.type === "taskItem") fn(n, index++);
    const kids = n.content;
    if (Array.isArray(kids)) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i] as Node);
  }
}

/** Every checkbox item in document order (sub-items after their parent). */
export function docTaskItems(doc: unknown): TaskItemInfo[] {
  const out: TaskItemInfo[] = [];
  forEachItem(doc, (n, index) => {
    const a = n.attrs ?? {};
    out.push({
      index,
      text: ownText(n),
      checked: a.checked === true,
      due: typeof a.due === "string" ? a.due : null,
      flagged: a.flagged === true,
      evernoteTask: typeof a.taskId === "string" && a.taskId !== "",
    });
  });
  return out;
}

/**
 * The item a check means in this document: one with the same words, the nearest to where it was. Words decide, not
 * the position: items added above it move it, and checking whatever now sits at its old place would check the wrong
 * thing. Null when no item has those words any more.
 */
export function findTaskItem(doc: unknown, ref: TaskRef): number | null {
  let best: number | null = null;
  forEachItem(doc, (n, index) => {
    if (ownText(n) !== ref.text) return;
    if (best === null || Math.abs(index - ref.index) < Math.abs(best - ref.index)) best = index;
  });
  return best;
}

/**
 * The document with that item checked or unchecked. `changed` is false when it already was. Only the nodes on the
 * way to the item are copied; the rest is shared with `doc`. Null when the item isn't there any more.
 */
export function setTaskItemChecked<T>(doc: T, ref: TaskRef, checked: boolean): { doc: T; changed: boolean } | null {
  const target = findTaskItem(doc, ref);
  if (target === null) return null;
  let index = 0;
  let changed = false;
  const visit = (n: Node): Node => {
    if (!n || typeof n !== "object") return n;
    let self = n;
    if (n.type === "taskItem") {
      if (index++ === target) {
        if ((n.attrs?.checked === true) !== checked) {
          changed = true;
          self = { ...n, attrs: { ...n.attrs, checked } };
        }
      }
    }
    const kids = self.content;
    if (!Array.isArray(kids)) return self;
    let copy: Node[] | null = null;
    for (let i = 0; i < kids.length; i++) {
      const before = kids[i] as Node;
      const after = visit(before);
      if (after !== before) {
        copy ??= kids.slice();
        copy[i] = after;
      }
    }
    return copy ? { ...self, content: copy } : self;
  };
  const next = visit(doc as Node) as T;
  return { doc: changed ? next : doc, changed };
}
