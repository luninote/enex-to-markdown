import { editorLabels } from "./labels.ts";

export type FileKind =
  | "image"
  | "pdf"
  | "audio"
  | "video"
  | "document"
  | "spreadsheet"
  | "presentation"
  | "archive"
  | "other";

export function fileKind(mime: string | null | undefined): FileKind {
  const m = (mime ?? "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m === "application/pdf") return "pdf";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("video/")) return "video";
  if (/spreadsheet|excel|csv/.test(m)) return "spreadsheet";
  if (/presentation|powerpoint/.test(m)) return "presentation";
  if (/wordprocessing|msword|opendocument\.text|rtf|text\/plain/.test(m)) return "document";
  if (/zip|x-tar|gzip|x-7z|x-rar/.test(m)) return "archive";
  return "other";
}

export function fileKindLabel(kind: FileKind): string {
  return editorLabels().fileKind[kind];
}

/** Images every current browser decodes; others (HEIC, TIFF) are shown as a file card. */
export function isDisplayableImage(mime: string | null | undefined): boolean {
  return /^image\/(?:png|jpe?g|gif|webp|avif|bmp|svg\+xml|x-icon|vnd\.microsoft\.icon)$/i.test((mime ?? "").trim());
}
