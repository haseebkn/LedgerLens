/** Calendar date-times are instants; all-day dates are not. Never infer a zone. */
export function describeCalendarTime(payload: Record<string, unknown>, timeZone: string) {
  if (payload.all_day === true) {
    const start = payload.source_start;
    const end = payload.source_end;
    if (typeof start === "string" && typeof end === "string" && /^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end)) {
      return { kind: "all_day" as const, start_date: start, end_date_exclusive: end };
    }
  } else {
    const start = explicitInstant(payload.start_time_utc);
    const end = explicitInstant(payload.end_time_utc);
    if (start && end) {
      return {
        kind: "timed" as const,
        time_zone: timeZone,
        start_utc: start.toISOString(),
        end_utc: end.toISOString(),
        start_local: formatLocal(start, timeZone),
        end_local: formatLocal(end, timeZone),
      };
    }
  }
  return { kind: "unknown" as const, note: "Timezone-aware source times are unavailable. Do not infer a local time; rebuild the calendar mart if this is legacy data." };
}

function explicitInstant(value: unknown): Date | null {
  if (typeof value !== "string" || !/T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const instant = new Date(value);
  return Number.isFinite(instant.getTime()) ? instant : null;
}

function formatLocal(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "longOffset",
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)?.value ?? "";
  // ICU versions disagree on a zero offset ("GMT" vs "GMT+00:00", e.g.
  // Node 22 vs Node 26); normalize so the agent sees one stable form.
  const offset = part("timeZoneName").replace("GMT", "UTC").replace(/^UTC[+-]00:00$/, "UTC");
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")} (${offset}, ${timeZone})`;
}

export function calendarContext(payload: Record<string, unknown>, timeZone: string) {
  const calendarTime = describeCalendarTime(payload, timeZone);
  const title = typeof payload.summary === "string" ? payload.summary : "(No Title)";
  const location = typeof payload.location === "string" ? payload.location : "No Location";
  const description = typeof payload.description === "string" ? payload.description : "(None)";
  const when = calendarTime.kind === "timed"
    ? `from ${calendarTime.start_local} to ${calendarTime.end_local}`
    : calendarTime.kind === "all_day"
      ? `all-day from ${calendarTime.start_date} to ${calendarTime.end_date_exclusive} (end date exclusive; do not apply timezone conversion)`
      : calendarTime.note;
  return { text: `Calendar Event: ${title} at ${location} ${when}. Description: ${description}`, calendar_time: calendarTime };
}
