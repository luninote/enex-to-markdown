import { describe, expect, it } from "vitest";
import { docTaskItems, findTaskItem, setTaskItemChecked } from "./tasks.ts";

const p = (text: string) => ({ type: "paragraph", content: text ? [{ type: "text", text }] : [] });
const item = (text: string, checked = false, sub?: unknown[], attrs: Record<string, unknown> = {}) => ({
  type: "taskItem",
  attrs: { checked, ...attrs },
  content: [p(text), ...(sub ? [{ type: "taskList", content: sub }] : [])],
});
const list = (...items: unknown[]) => ({ type: "taskList", content: items });
const doc = (...content: unknown[]) => ({ type: "doc", content });

describe("docTaskItems", () => {
  it("lists items in document order with their own words, sub-items after their parent", () => {
    const d = doc(
      p("Groceries"),
      list(item("Milk"), item("Bread", true, [item("Rye"), item("  Sour   dough ")])),
      {
        type: "table",
        content: [{ type: "tableRow", content: [{ type: "tableCell", content: [list(item("In a cell"))] }] }],
      },
      list(item("Call", false, undefined, { taskId: "t-1", due: "2026-10-20T09:00:00.000Z", flagged: true })),
    );
    expect(docTaskItems(d)).toEqual([
      { index: 0, text: "Milk", checked: false, due: null, flagged: false, evernoteTask: false },
      { index: 1, text: "Bread", checked: true, due: null, flagged: false, evernoteTask: false },
      { index: 2, text: "Rye", checked: false, due: null, flagged: false, evernoteTask: false },
      { index: 3, text: "Sour dough", checked: false, due: null, flagged: false, evernoteTask: false },
      { index: 4, text: "In a cell", checked: false, due: null, flagged: false, evernoteTask: false },
      { index: 5, text: "Call", checked: false, due: "2026-10-20T09:00:00.000Z", flagged: true, evernoteTask: true },
    ]);
  });

  it("joins an item's text across marks and hard breaks", () => {
    const rich = {
      type: "taskItem",
      attrs: { checked: false },
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Pay " },
            { type: "text", text: "rent", marks: [{ type: "bold" }] },
            { type: "hardBreak" },
            { type: "text", text: "today" },
          ],
        },
      ],
    };
    expect(docTaskItems(doc(list(rich)))[0]?.text).toBe("Pay rent today");
  });
});

describe("setTaskItemChecked", () => {
  it("checks the item by its words even after items were added above it", () => {
    const shown = doc(list(item("Milk"), item("Eggs")));
    const ref = { index: 1, text: "Eggs" };
    const now = doc(list(item("Coffee"), item("Milk"), item("Eggs")));
    const r = setTaskItemChecked(now, ref, true);
    expect(r?.changed).toBe(true);
    expect(docTaskItems(r?.doc).map((t) => [t.text, t.checked])).toEqual([
      ["Coffee", false],
      ["Milk", false],
      ["Eggs", true],
    ]);
    expect(findTaskItem(shown, ref)).toBe(1);
  });

  it("with two items of the same words, picks the one nearest where it was", () => {
    const d = doc(list(item("Water plants"), item("Mail"), item("Water plants")));
    const r = setTaskItemChecked(d, { index: 2, text: "Water plants" }, true);
    expect(docTaskItems(r?.doc).map((t) => t.checked)).toEqual([false, false, true]);
    const shifted = doc(list(item("New"), item("Water plants"), item("Mail"), item("Water plants")));
    expect(findTaskItem(shifted, { index: 2, text: "Water plants" })).toBe(1);
  });

  it("returns null when the words are gone, and unchanged when it already has that state", () => {
    const d = doc(list(item("Milk", true)));
    expect(setTaskItemChecked(d, { index: 0, text: "Oat milk" }, true)).toBeNull();
    const same = setTaskItemChecked(d, { index: 0, text: "Milk" }, true);
    expect(same).toEqual({ doc: d, changed: false });
    expect(same?.doc).toBe(d);
  });

  it("copies only the path to the item and never touches the input", () => {
    const other = p("untouched");
    const d = doc(other, list(item("A"), item("B", false, [item("B1")])));
    const frozen = JSON.stringify(d);
    const r = setTaskItemChecked(d, { index: 2, text: "B1" }, true);
    expect(JSON.stringify(d)).toBe(frozen);
    expect(((r ?? { doc: null }).doc as typeof d).content[0]).toBe(other);
    expect(docTaskItems(r?.doc).map((t) => [t.text, t.checked])).toEqual([
      ["A", false],
      ["B", false],
      ["B1", true],
    ]);
  });

  it("unchecks too, and keeps the item's other attributes", () => {
    const d = doc(list(item("Call", true, undefined, { taskId: "t-9", flagged: true })));
    const r = setTaskItemChecked(d, { index: 0, text: "Call" }, false);
    const n = ((r ?? { doc: null }).doc as { content: { content: { attrs: Record<string, unknown> }[] }[] }).content[0]
      ?.content[0];
    expect(n?.attrs).toEqual({ checked: false, taskId: "t-9", flagged: true });
  });
});
