const ENEX_DATE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * ENEX dates are `yyyymmddThhmmssZ`, but exports in the wild also carry ISO 8601 (e.g. reminder times).
 * Returns null for anything unparseable or out of range: callers fall back, never throw.
 */
export function parseEnexDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  const m = ENEX_DATE.exec(s);
  if (m) {
    const [y, mo, d, h, mi, se] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 60) return null;
    const t = Date.UTC(y, mo - 1, d, h, mi, se);
    const date = new Date(t);
    // Rejects 20230231-style dates that Date.UTC would silently roll over.
    if (date.getUTCDate() !== d) return null;
    return date;
  }
  if (ISO_DATE.test(s)) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? new Date(t) : null;
  }
  return null;
}
