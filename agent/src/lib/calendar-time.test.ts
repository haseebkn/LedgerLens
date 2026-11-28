import { describe, expect, it } from "vitest";
import { calendarContext, describeCalendarTime } from "./calendar-time.js";

const zone = "America/St_Johns";
describe("calendar time rendering", () => {
  it("fixes the recorded dentist case with Newfoundland's winter half-hour offset", () => {
    const result = calendarContext({ summary: "Dentist Appointment", start_time_utc: "2026-01-05T19:00:00Z", end_time_utc: "2026-01-05T20:00:00Z", all_day: false }, zone);
    expect(result.calendar_time).toMatchObject({ kind: "timed", start_local: "2026-01-05 15:30 (UTC-03:30, America/St_Johns)", end_local: "2026-01-05 16:30 (UTC-03:30, America/St_Johns)" });
    expect(result.text).not.toContain("from 2026-01-05 19:00");
  });
  it("uses daylight saving time for the event date, not today's offset", () => {
    expect(describeCalendarTime({ start_time_utc: "2026-07-05T18:00:00Z", end_time_utc: "2026-07-05T19:00:00Z" }, zone)).toMatchObject({ start_local: "2026-07-05 15:30 (UTC-02:30, America/St_Johns)" });
  });
  it("moves a timed event to the previous local calendar day when appropriate", () => {
    expect(describeCalendarTime({ start_time_utc: "2026-01-06T01:00:00Z", end_time_utc: "2026-01-06T02:00:00Z" }, zone)).toMatchObject({ start_local: "2026-01-05 21:30 (UTC-03:30, America/St_Johns)" });
  });
  it("disambiguates repeated wall times across the DST fall-back", () => {
    expect(describeCalendarTime({ start_time_utc: "2026-11-01T04:00:00Z", end_time_utc: "2026-11-01T05:00:00Z" }, zone)).toMatchObject({ start_local: "2026-11-01 01:30 (UTC-02:30, America/St_Johns)", end_local: "2026-11-01 01:30 (UTC-03:30, America/St_Johns)" });
  });
  it("does not shift all-day dates or turn an exclusive end into another day", () => {
    const result = calendarContext({ all_day: true, source_start: "2026-07-26", source_end: "2026-07-27" }, zone);
    expect(result.calendar_time).toEqual({ kind: "all_day", start_date: "2026-07-26", end_date_exclusive: "2026-07-27" });
    expect(result.text).toContain("end date exclusive; do not apply timezone conversion");
    expect(result.text).not.toContain("00:00");
  });
  it.each([
    { start_time: "2026-01-05 19:00:00", end_time: "2026-01-05 20:00:00" },
    { start_time_utc: "2026-01-05T19:00:00", end_time_utc: "2026-01-05T20:00:00" },
    { start_time_utc: "invalid", end_time_utc: "invalid" },
  ])("does not invent a zone for incomplete, invalid, or legacy timestamps: %j", payload => {
    expect(describeCalendarTime(payload, zone)).toMatchObject({ kind: "unknown" });
  });
  it("honors a configured zone other than Newfoundland", () => {
    expect(describeCalendarTime({ start_time_utc: "2026-01-05T19:00:00Z", end_time_utc: "2026-01-05T20:00:00Z" }, "UTC")).toMatchObject({ start_local: "2026-01-05 19:00 (UTC, UTC)" });
  });
});
