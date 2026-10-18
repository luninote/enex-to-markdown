// Browser-safe entry: ENML conversion, links, recognition data. The streaming ENEX reader (Node) is in ./reader.
export {
  type ClipMetrics,
  type ClipThresholds,
  DEFAULT_CLIP_THRESHOLDS,
  measureClip,
  shouldPreserveAsClip,
} from "./convert/clip.ts";
export {
  CODE_BLOCK_MAX_CHARS,
  CODE_BLOCK_MAX_LINES,
  type ConvertOptions,
  type ConvertResource,
  type ConvertResult,
  type ConvertStats,
  type ConvertTask,
  convertEnml,
} from "./convert/convert.ts";
export { parseEnexDate } from "./dates.ts";
export {
  type EvernoteLink,
  type LinkResolution,
  type LinkTarget,
  NOTE_LINK_PREFIX,
  NoteLinkResolver,
  normalizeTitle,
  noteHref,
  parseEvernoteLink,
} from "./links.ts";
export { parseRecoIndex, type RecoIndex } from "./recoindex.ts";
export { type NoteWarning, type Severity, WARNING_SEVERITY, Warnings } from "./warnings.ts";
