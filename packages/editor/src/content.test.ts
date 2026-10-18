import type { JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { canEdit, compactDoc, migrateContent, NewerSchemaError, toNoteContent } from "./content.ts";
import { checkDoc, SCHEMA_VERSION } from "./extensions.ts";
import { v1Doc } from "./fixtures.ts";

describe("migrateContent", () => {
  it("brings a v1 note to the current version without changing the document", () => {
    const out = migrateContent({ schema_version: 1, doc: v1Doc });
    expect(SCHEMA_VERSION).toBe(3);
    expect(out.schema_version).toBe(3);
    expect(out.doc).toEqual(v1Doc);
    expect(checkDoc(out.doc)).toBeNull();
  });

  it("leaves current notes alone and refuses notes from a newer schema or with a bad version", () => {
    expect(migrateContent({ schema_version: SCHEMA_VERSION, doc: v1Doc }).doc).toBe(v1Doc);
    expect(() => migrateContent({ schema_version: SCHEMA_VERSION + 1, doc: v1Doc })).toThrow(NewerSchemaError);
    expect(() => migrateContent({ schema_version: 0, doc: v1Doc })).toThrow(/invalid/);
    expect(() => migrateContent({ schema_version: 1.5, doc: v1Doc })).toThrow(/invalid/);
  });
});

describe("canEdit", () => {
  it("allows older and current notes, and keeps newer ones read-only", () => {
    expect(canEdit(1)).toBe(true);
    expect(canEdit(SCHEMA_VERSION)).toBe(true);
    expect(canEdit(SCHEMA_VERSION + 1)).toBe(false);
  });
});

describe("compactDoc", () => {
  it("drops v2 attributes at their defaults and keeps set ones", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "taskList",
          content: [
            {
              type: "taskItem",
              attrs: { checked: false, taskId: null, due: null, flagged: false },
              content: [{ type: "paragraph" }],
            },
            {
              type: "taskItem",
              attrs: { checked: true, taskId: "t1", due: null, flagged: true },
              content: [{ type: "paragraph" }],
            },
          ],
        },
        { type: "webClip", attrs: { html: "<p>x</p>", sanitizerVersion: null } },
        { type: "webClip", attrs: { html: "<p>y</p>", sanitizerVersion: 1 } },
        { type: "codeBlock", attrs: { language: null } },
      ],
    };
    expect(compactDoc(doc)).toEqual({
      type: "doc",
      content: [
        {
          type: "taskList",
          content: [
            { type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph" }] },
            {
              type: "taskItem",
              attrs: { checked: true, taskId: "t1", flagged: true },
              content: [{ type: "paragraph" }],
            },
          ],
        },
        { type: "webClip", attrs: { html: "<p>x</p>" } },
        { type: "webClip", attrs: { html: "<p>y</p>", sanitizerVersion: 1 } },
        { type: "codeBlock", attrs: { language: null } },
      ],
    });
  });

  it("is what toNoteContent stores", () => {
    const content = toNoteContent({
      type: "doc",
      content: [{ type: "webClip", attrs: { html: "", sanitizerVersion: null } }],
    });
    expect(content).toEqual({
      schema_version: SCHEMA_VERSION,
      doc: { type: "doc", content: [{ type: "webClip", attrs: { html: "" } }] },
    });
  });
});
