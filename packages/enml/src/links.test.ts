import { describe, expect, it } from "vitest";
import { NoteLinkResolver, parseEvernoteLink } from "./links.ts";

const G = "dd128476-5cb5-a041-ce3a-1d8108a04793";

describe("parseEvernoteLink", () => {
  it.each([
    [`evernote:///view/150249420/s714/${G}/${G}/`, [G]],
    [`https://www.evernote.com/shard/s714/nl/150249420/${G}`, [G]],
    [`https://www.evernote.com/shard/s714/nl/150249420/${G.toUpperCase()}/`, [G]],
    [`https://www.evernote.com/shard/s714/sh/${G}/someShareKey`, [G]],
    [`https://share.evernote.com/note/${G}`, [G]],
    [`https://share.evernote.com/note/${G.toUpperCase()}?x=1#top`, [G]],
  ])("finds the note GUID in %s", (href, guids) => {
    expect(parseEvernoteLink(href)).toEqual({ kind: "note", guids });
  });

  it("keeps links without a note GUID as opaque Evernote links, and ignores other sites", () => {
    expect(parseEvernoteLink("https://share.evernote.com/note/not-a-guid")).toEqual({ kind: "opaque" });
    expect(parseEvernoteLink("https://www.evernote.com/l/AAxNlxMzi2VF1oV7JDyFDKv1JXcc21NekYM")).toEqual({
      kind: "opaque",
    });
    expect(parseEvernoteLink(`https://example.com/note/${G}`)).toBeNull();
    expect(parseEvernoteLink(`https://share.evernote.com.example.org/note/${G}`)).toBeNull();
  });

  it("resolves a shared-note link by the GUID an export carries", () => {
    const r = new NoteLinkResolver([{ noteId: "n1", title: "Anything", guid: G.toUpperCase() }]);
    expect(r.resolve(`https://share.evernote.com/note/${G}`, "other text")).toMatchObject({
      kind: "resolved",
      noteId: "n1",
      by: "guid",
    });
    expect(r.resolve(`https://www.evernote.com/shard/s1/nl/1/${G.toUpperCase()}/`, "x")).toMatchObject({
      kind: "resolved",
      noteId: "n1",
    });
  });
});
