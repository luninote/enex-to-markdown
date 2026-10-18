import { createHash } from "node:crypto";
import { createReadStream, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { checkDoc, sanitizeClipHtml } from "@luninote/editor";
import { type ConvertResource, type ConvertTask, convertEnml, NoteLinkResolver } from "@luninote/enml";
import { type EnexNote, readEnex } from "@luninote/enml/reader";
import { YARLE as FIXTURES, HAS_YARLE } from "@luninote/enml/testing";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import type { DocNode } from "./doc.ts";
import { docToEnml } from "./enml.ts";

// docToEnml is the inverse of the importer's converter: for every Yarle fixture note, converting the ENML we write
// gives back the document the original ENML gave.

const win = new JSDOM("").window;
const sanitizeHtml = (html: string) => sanitizeClipHtml(html, win as never);

function fixtureFiles(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".enex")) out.push(p);
    }
  };
  walk(FIXTURES);
  return out.sort();
}

const noteId = (file: number, i: number) =>
  `00000000-0000-7000-8000-${String(file).padStart(4, "0")}${String(i).padStart(8, "0")}`;

interface Case {
  title: string;
  doc: DocNode;
  resources: ConvertResource[];
}

async function convertFixture(
  path: string,
  fileIndex: number,
): Promise<{ cases: Case[]; resolverTitles: NoteLinkResolver; ids: string[] }> {
  const notes: EnexNote[] = [];
  for await (const n of readEnex(createReadStream(path)).notes) notes.push(n);
  const ids = notes.map((_, i) => noteId(fileIndex, i));
  const original = new NoteLinkResolver(
    notes.map((n, i) => ({ noteId: ids[i] as string, title: n.title, guid: n.guid })),
  );
  const cases = notes.map((note, i) => {
    const resources: ConvertResource[] = note.resources.map((r, k) => ({
      md5: r.digest.md5,
      resourceId: `${ids[i]}-r${k}`,
      mime: r.mime ?? "application/octet-stream",
      filename: r.attributes["file-name"] ?? `attachment-${k + 1}.bin`,
    }));
    let images = 0;
    const result = convertEnml(note.content, {
      resources,
      tasks: note.tasks,
      resolveLink: (href, text) => original.resolve(href, text),
      sanitizeHtml,
      storeDataImage: (mime, bytes) => {
        const r = {
          md5: createHash("md5").update(bytes).digest("hex"),
          resourceId: `${ids[i]}-img${images++}`,
          mime,
          filename: null,
        };
        resources.push(r);
        return r;
      },
    });
    expect(checkDoc(result.doc)).toBeNull();
    return { title: note.title, doc: result.doc as DocNode, resources };
  });
  // Links we write carry our ids as GUIDs; titles still resolve the Evernote links that were left unresolved.
  const ours = new NoteLinkResolver(
    notes.map((n, i) => ({ noteId: ids[i] as string, title: n.title, guid: ids[i] as string })),
  );
  return { cases, resolverTitles: ours, ids };
}

function roundTrip(c: Case, resolver: NoteLinkResolver) {
  const byId = new Map(c.resources.map((r) => [r.resourceId, r]));
  const out = docToEnml(c.doc, {
    resource: (id) => {
      const r = byId.get(id);
      return r ? { md5: r.md5, mime: r.mime } : null;
    },
    noteLink: (id) => `evernote:///view/0/s0/${id}/${id}/`,
  });
  const tasks: ConvertTask[] = out.tasks.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    flag: t.flag,
    sortWeight: t.sortWeight,
    groupId: t.groupId,
    dueDate: t.dueDate ? new Date(t.dueDate) : null,
  }));
  const again = convertEnml(out.enml, {
    resources: c.resources,
    tasks,
    resolveLink: (href, text) => resolver.resolve(href, text),
    sanitizeHtml,
  });
  return { out, again: again.doc as DocNode };
}

describe.skipIf(!HAS_YARLE)("docToEnml ∘ convertEnml over the Yarle fixtures", () => {
  const files = HAS_YARLE ? fixtureFiles() : [];
  it.each(files.map((f, i) => [relative(FIXTURES, f), i] as const))("%s", async (name, i) => {
    const { cases, resolverTitles } = await convertFixture(join(FIXTURES, name), i);
    for (const c of cases) {
      const { out, again } = roundTrip(c, resolverTitles);
      expect(again, `${name}: ${c.title}\n${out.enml.slice(0, 3000)}`).toEqual(c.doc);
    }
  });
});
