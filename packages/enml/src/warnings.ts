/**
 * Per-note findings collected while reading and converting. `warning` means the user may want to look
 * (something could not be represented, or input was damaged); `info` records a faithful but notable
 * conversion (a web clip kept as HTML, encrypted text kept locked). The original ENML is always kept,
 * so neither kind loses data.
 */
export type Severity = "warning" | "info";

export interface NoteWarning {
  code: string;
  severity: Severity;
  count: number;
  /** Up to MAX_DETAILS distinct examples (tag names, hashes, hrefs). */
  details?: string[];
}

const MAX_DETAILS = 5;
const MAX_DETAIL_LENGTH = 200;

export const WARNING_SEVERITY: Record<string, Severity> = {
  invalid_date: "warning",
  missing_date: "warning",
  xml_error: "warning",
  file_cut_off: "warning",
  bad_base64: "warning",
  empty_resource: "warning",
  resource_without_data: "warning",
  control_chars_removed: "info",
  oversized_content: "info",
  oversized_resource: "info",
  recognition_unreadable: "warning",
  missing_resource: "warning",
  unsupported_element: "warning",
  // Kept as an image node pointing at the original URL: shown as long as that server keeps it.
  remote_image: "info",
  image_without_src: "info",
  dropped_element: "info",
  formatting_dropped: "info",
  encrypted: "info",
  web_clip: "info",
  tasks: "info",
  tasks_unplaced: "info",
  task_group_without_tasks: "warning",
  code_block_split: "info",
  unreferenced_resource: "info",
  data_image: "info",
  evernote_link_unresolved: "warning",
  evernote_link_resolved: "info",
  conversion_failed: "warning",
  title_truncated: "warning",
  // Stored in the blob store instead of inline; nothing is lost.
  large_document: "info",
  // Only when even the distinct words of a note exceed what one search vector holds (about 1 MB).
  index_truncated: "warning",
  tag_renamed: "info",
};

export class Warnings {
  private readonly map = new Map<string, { severity: Severity; count: number; details: Set<string> }>();

  add(code: string, detail?: string | null, count = 1): void {
    let w = this.map.get(code);
    if (!w) {
      w = { severity: WARNING_SEVERITY[code] ?? "warning", count: 0, details: new Set() };
      this.map.set(code, w);
    }
    w.count += count;
    if (detail && w.details.size < MAX_DETAILS) w.details.add(detail.slice(0, MAX_DETAIL_LENGTH));
  }

  merge(list: readonly NoteWarning[]): void {
    for (const w of list) {
      this.add(w.code, null, w.count);
      for (const d of w.details ?? []) this.add(w.code, d, 0);
    }
  }

  get size(): number {
    return this.map.size;
  }

  has(code: string): boolean {
    return this.map.has(code);
  }

  list(): NoteWarning[] {
    return [...this.map.entries()].map(([code, w]) => ({
      code,
      severity: w.severity,
      count: w.count,
      ...(w.details.size ? { details: [...w.details] } : {}),
    }));
  }
}
