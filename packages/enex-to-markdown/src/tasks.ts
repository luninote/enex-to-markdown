import { parseEnexDate } from "@luninote/enml";
import type { EnexTask } from "@luninote/enml/reader";

// What an Evernote Task carries besides its text, written after it: a plain note in brackets by default, or the
// Obsidian Tasks plugin's fields (priority, recurrence, scheduled, due, done; in the order the plugin writes them).

export type TaskStyle = "plain" | "obsidian";

export interface TaskLine {
  /** Text after the task's own text, leading space included ("" for none). */
  suffix: string;
  /** What the line couldn't hold, for the warnings file. */
  dropped: string[];
}

interface When {
  date: string;
  time: string | null;
}

/** A date as the task's own time zone shows it (UTC when the export names none or one this Node doesn't know). */
function inZone(d: Date, zone: string | null, dateOnly: boolean): When {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(d);
  } catch {
    return inZone(d, null, dateOnly);
  }
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: dateOnly ? null : `${get("hour")}:${get("minute")}`,
  };
}

const field = (t: EnexTask, name: string) => t.fields[name]?.trim() || null;
const isDateOnly = (option: string | null | undefined) => option?.trim() === "date_only";

/** The task's reminders with a readable date, ones still set first, earliest first. */
function remindersOf(t: EnexTask): When[] {
  return t.reminders
    .map((r) => ({ r, at: parseEnexDate(r.reminderDate?.trim()) }))
    .filter((x): x is { r: Record<string, string>; at: Date } => x.at !== null)
    .sort(
      (a, b) =>
        Number((a.r.reminderStatus?.trim() || "active") !== "active") -
          Number((b.r.reminderStatus?.trim() || "active") !== "active") || a.at.getTime() - b.at.getTime(),
    )
    .map((x) => inZone(x.at, x.r.timeZone?.trim() || field(t, "timeZone"), isDateOnly(x.r.reminderDateUIOption)));
}

const at = (w: When) => `${w.date}${w.time ? ` ${w.time}` : ""}`;

export function taskLine(t: EnexTask, style: TaskStyle): TaskLine {
  const dropped: string[] = [];
  const zone = field(t, "timeZone");
  const due = t.dueDate ? inZone(t.dueDate, zone, isDateOnly(field(t, "dueDateUIOption"))) : null;
  const reminders = remindersOf(t);
  const rem = reminders[0] ?? null;
  const doneAt = t.status === "completed" ? parseEnexDate(field(t, "statusUpdated")) : null;
  const done = doneAt ? inZone(doneAt, zone, true) : null;
  const rule = field(t, "recurrence")?.replace(/\\n|\s+/g, " ") ?? null;
  const recurrence = rule ? recurrenceText(rule) : null;
  const whenDone = /^true$/i.test(field(t, "repeatAfterCompletion") ?? "");
  const repeats = recurrence?.text
    ? `${recurrence.text}${whenDone ? " when done" : ""}${recurrence.dropped.length ? `, ${recurrence.dropped.join(", ")}` : ""}`
    : null;

  if (style === "plain") {
    const meta: string[] = [];
    if (due) meta.push(`due ${at(due)}`);
    for (const r of reminders) meta.push(`reminder ${at(r)}`);
    if (rule) meta.push(repeats ? `repeats ${repeats}` : `repeats: ${rule}`);
    if (t.flag) meta.push("flagged");
    if (done) meta.push(`done ${done.date}`);
    return { suffix: meta.length ? ` *(${meta.join(", ")})*` : "", dropped };
  }

  // The Tasks plugin holds one scheduled date, dates without times, and repeat rules without an end.
  if (reminders.length > 1) dropped.push(`"${t.title}": other reminders (${reminders.slice(1).map(at).join(", ")})`);
  if (rule && !recurrence?.text)
    dropped.push(`"${t.title}": repeat rule the Tasks plugin can't read, kept in the text: ${rule}`);
  if (recurrence?.text && recurrence.dropped.length)
    dropped.push(`"${t.title}": repeat rule written without "${recurrence.dropped.join(", ")}"`);
  const parts: string[] = [];
  if (t.flag) parts.push("⏫");
  if (rule) {
    if (recurrence?.text) parts.push(`🔁 ${recurrence.text}${whenDone ? " when done" : ""}`);
    else parts.unshift(`(repeats: ${rule})`);
  }
  if (rem) parts.push(`⏳ ${rem.date}`);
  if (due) parts.push(`📅 ${due.date}`);
  if (done) parts.push(`✅ ${done.date}`);
  const times = [due?.time ? `due ${due.time}` : null, rem?.time ? `reminder ${rem.time}` : null].filter(Boolean);
  if (times.length) dropped.push(`"${t.title}": time of day (${times.join(", ")})`);
  return { suffix: parts.length ? ` ${parts.join(" ")}` : "", dropped };
}

const DAYS: Record<string, string> = {
  MO: "Monday",
  TU: "Tuesday",
  WE: "Wednesday",
  TH: "Thursday",
  FR: "Friday",
  SA: "Saturday",
  SU: "Sunday",
};
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const UNIT: Record<string, string> = { DAILY: "day", WEEKLY: "week", MONTHLY: "month", YEARLY: "year" };

function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10];
  return `${n}${s ?? "th"}`;
}

/** "1st", "last", "2nd last". */
function nth(n: number): string | null {
  if (!Number.isInteger(n) || n === 0 || Math.abs(n) > 31) return null;
  if (n === -1) return "last";
  return n > 0 ? ordinal(n) : `${ordinal(-n)} last`;
}

/**
 * An RFC 5545 repeat rule (as Evernote stores it: an optional DTSTART line, then RRULE) in the words the Tasks plugin
 * reads ("every 2 weeks on Monday, Friday"). `text` is null when the rule says something those words can't.
 */
export function recurrenceText(raw: string): { text: string | null; dropped: string[] } {
  // Exports hold the line break between DTSTART and RRULE as a real newline or as the two characters "\n".
  const lines = raw
    .split(/\\n|\s+/)
    .map((l) => l.trim())
    .filter(Boolean);
  const line = lines.find((l) => /^RRULE:/i.test(l)) ?? lines.find((l) => /^FREQ=/i.test(l));
  if (!line) return { text: null, dropped: [] };
  const rule = new Map<string, string>();
  for (const part of line.replace(/^RRULE:/i, "").split(";")) {
    const [k, v] = part.split("=");
    if (k && v !== undefined) rule.set(k.trim().toUpperCase(), v.trim().toUpperCase());
  }
  const unit = UNIT[rule.get("FREQ") ?? ""];
  if (!unit) return { text: null, dropped: [] };
  const interval = Number(rule.get("INTERVAL") ?? "1");
  if (!Number.isInteger(interval) || interval < 1) return { text: null, dropped: [] };
  const dropped: string[] = [];
  if (rule.has("COUNT")) dropped.push(`${rule.get("COUNT")} times`);
  const until = /^(\d{4})(\d{2})(\d{2})/.exec(rule.get("UNTIL") ?? "");
  if (until) dropped.push(`until ${until[1]}-${until[2]}-${until[3]}`);
  if (lines.some((l) => /^(EXDATE|RDATE)[;:]/i.test(l))) dropped.push("with exceptions");
  const known = new Set(["FREQ", "INTERVAL", "BYDAY", "BYMONTHDAY", "BYMONTH", "COUNT", "UNTIL", "WKST"]);
  if ([...rule.keys()].some((k) => !known.has(k))) return { text: null, dropped: [] };

  const every = interval === 1 ? `every ${unit}` : `every ${interval} ${unit}s`;
  const byDay = rule.get("BYDAY")?.split(",").filter(Boolean) ?? [];
  const byMonthDay = (rule.get("BYMONTHDAY")?.split(",") ?? []).map(Number);
  const byMonth = (rule.get("BYMONTH")?.split(",") ?? []).map(Number);
  if (byMonthDay.some((d) => nth(d) === null)) return { text: null, dropped: [] };
  if (byMonth.some((m) => !MONTHS[m - 1])) return { text: null, dropped: [] };
  const days = byDay.map((d) => /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(d));
  if (days.some((d) => !d)) return { text: null, dropped: [] };

  if (unit === "day") {
    if (byDay.length || byMonthDay.length || byMonth.length) return { text: null, dropped: [] };
    return { text: every, dropped };
  }
  if (unit === "week") {
    if (byMonthDay.length || byMonth.length || days.some((d) => d?.[1])) return { text: null, dropped: [] };
    const names = days.map((d) => DAYS[d?.[2] as string] as string);
    if (interval === 1 && names.length === 5 && !byDay.some((d) => d === "SA" || d === "SU"))
      return { text: "every weekday", dropped };
    return { text: names.length ? `${every} on ${names.join(", ")}` : every, dropped };
  }
  const onDays = (): string | null => {
    if (byMonthDay.length && days.length) return null;
    if (byMonthDay.length) return `on the ${byMonthDay.map((d) => nth(d)).join(" and ")}`;
    if (!days.length) return "";
    if (days.length > 1) return null;
    const [, n, day] = days[0] as RegExpExecArray;
    const pos = n ? nth(Number(n)) : null;
    return pos ? `on the ${pos} ${DAYS[day as string]}` : null;
  };
  const on = onDays();
  if (on === null) return { text: null, dropped: [] };
  if (unit === "month") {
    if (byMonth.length) return { text: null, dropped: [] };
    return { text: on ? `${every} ${on}` : every, dropped };
  }
  if (!byMonth.length) return { text: on ? `${every} ${on}` : every, dropped };
  if (interval !== 1 || !on) return { text: null, dropped: [] };
  return { text: `every ${byMonth.map((m) => MONTHS[m - 1]).join(" and ")} ${on}`, dropped };
}
