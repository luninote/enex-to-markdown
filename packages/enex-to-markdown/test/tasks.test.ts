import type { EnexTask } from "@luninote/enml/reader";
import { describe, expect, it } from "vitest";
import { recurrenceText, taskLine } from "../src/tasks.ts";

describe("repeat rules in the Tasks plugin's words", () => {
  it.each([
    // The shape a real export holds: DTSTART, the two characters "\n", RRULE.
    ["DTSTART;TZID=America/Chicago:20250101T235959\\nRRULE:FREQ=YEARLY;INTERVAL=1", "every year"],
    ["DTSTART:20250101T000000Z\nRRULE:FREQ=DAILY", "every day"],
    ["RRULE:FREQ=DAILY;INTERVAL=3", "every 3 days"],
    ["FREQ=WEEKLY;BYDAY=TU,FR", "every week on Tuesday, Friday"],
    ["FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", "every weekday"],
    ["FREQ=WEEKLY;INTERVAL=3;BYDAY=FR", "every 3 weeks on Friday"],
    ["FREQ=MONTHLY;BYMONTHDAY=1", "every month on the 1st"],
    ["FREQ=MONTHLY;BYMONTHDAY=-1", "every month on the last"],
    ["FREQ=MONTHLY;BYDAY=-1FR", "every month on the last Friday"],
    ["FREQ=MONTHLY;BYDAY=-2FR", "every month on the 2nd last Friday"],
    ["FREQ=MONTHLY;INTERVAL=6;BYDAY=2WE", "every 6 months on the 2nd Wednesday"],
    ["FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=15", "every January on the 15th"],
    ["FREQ=MONTHLY;BYMONTHDAY=11,22", "every month on the 11th and 22nd"],
  ])("%s", (rule, text) => {
    expect(recurrenceText(rule)).toEqual({ text, dropped: [] });
  });

  it("keeps an end it can't express as something dropped, and gives up on rules it can't say", () => {
    expect(recurrenceText("RRULE:FREQ=WEEKLY;COUNT=5")).toEqual({ text: "every week", dropped: ["5 times"] });
    expect(recurrenceText("RRULE:FREQ=DAILY;UNTIL=20250301T000000Z")).toEqual({
      text: "every day",
      dropped: ["until 2025-03-01"],
    });
    expect(recurrenceText("RRULE:FREQ=HOURLY").text).toBeNull();
    expect(recurrenceText("RRULE:FREQ=MONTHLY;BYDAY=MO,TU").text).toBeNull();
    expect(recurrenceText("RRULE:FREQ=WEEKLY;BYSETPOS=1").text).toBeNull();
    expect(recurrenceText("nonsense").text).toBeNull();
  });
});

function task(fields: Record<string, string>, extra: Partial<EnexTask> = {}): EnexTask {
  return {
    id: "t",
    title: fields.title ?? "Pay",
    status: fields.taskStatus ?? "open",
    flag: fields.taskFlag === "true",
    sortWeight: null,
    groupId: null,
    dueDate: null,
    fields,
    reminders: [],
    ...extra,
  };
}

describe("task details in plain Markdown", () => {
  it("writes dates in the task's own time zone, every reminder, the repeat rule and the end of it", () => {
    const t = task(
      {
        timeZone: "Asia/Tokyo",
        dueDateUIOption: "date_time",
        recurrence: "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4",
        repeatAfterCompletion: "false",
        taskFlag: "true",
      },
      {
        flag: true,
        // 2024-01-10 23:30 UTC is already the 11th in Tokyo.
        dueDate: new Date("2024-01-10T23:30:00Z"),
        reminders: [
          { reminderDate: "20240110T000000Z", reminderStatus: "dismissed" },
          { reminderDate: "20240109T000000Z", reminderDateUIOption: "date_only" },
        ],
      },
    );
    expect(taskLine(t, "plain")).toEqual({
      suffix:
        " *(due 2024-01-11 08:30, reminder 2024-01-09, reminder 2024-01-10 09:00, repeats every week on Monday, 4 times, flagged)*",
      dropped: [],
    });
  });

  it("keeps a repeat rule it can't put in words as written", () => {
    const t = task({ recurrence: "RRULE:FREQ=MINUTELY" });
    expect(taskLine(t, "plain").suffix).toBe(" *(repeats: RRULE:FREQ=MINUTELY)*");
    const obsidian = taskLine(t, "obsidian");
    expect(obsidian.suffix).toBe(" (repeats: RRULE:FREQ=MINUTELY)");
    expect(obsidian.dropped[0]).toContain("can't read");
  });

  it("falls back to UTC for a time zone this machine doesn't know", () => {
    const t = task(
      { timeZone: "Mars/Olympus", dueDateUIOption: "date_only" },
      { dueDate: new Date("2024-05-05T12:00:00Z") },
    );
    expect(taskLine(t, "obsidian").suffix).toBe(" 📅 2024-05-05");
  });
});
