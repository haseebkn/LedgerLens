# Calendar timezone handling

Timed Google Calendar events are instants. All-day events are calendar dates.
Neither should inherit the server's timezone or require the model to calculate
Newfoundland's half-hour offset.

- Staging reads the source payload as JSON, preserving its original RFC 3339
  offsets and optional IANA timezone. Automatic JSON type inference must not
  discard those details first.
- Timed `start_time` / `end_time` values are normalized to UTC. The calendar
  mart's JSON exposes explicit `start_time_utc` / `end_time_utc` fields and the
  original `source_start` / `source_end` values. Narrative timestamps label UTC.
- All-day dates remain unchanged. Their end date is exclusive: July 26–27 means
  July 26, not a two-day appointment.
- `search_context` hydrates calendar times from the current warehouse, rather
  than trusting potentially stale vector-store narrative text. Code formats
  both endpoints in the agent's configured `USER_TIME_ZONE`, with an event-date
  UTC offset and IANA zone label. The default is `America/St_Johns`.
- Missing or legacy timezone metadata is reported as unknown, not guessed.
  Rebuild dbt before relying on a warehouse created by the older models.

The recorded fixture `2026-01-05T14:00:00-05:00` is `19:00 UTC` and **15:30
(UTC−03:30, America/St_Johns)**. In summer Newfoundland uses UTC−02:30; the
offset is determined from the event date, not today's date.

Regression coverage includes source-offset preservation under different SQL
session timezones, IANA-zone inputs, the recorded dentist case, summer/winter
offsets, a midnight date crossing, DST's repeated hour, all-day semantics, and
stale or incomplete vector metadata. None of these local tests need model calls.

Provider reconnection and source ingestion are separate from timezone handling.
An API connectivity check does not update the warehouse, rerun the full agent
evaluation, or refresh an already-recorded demonstration video.

## Verification — October 20, 2026

Fresh read-only checks passed for Google Calendar events, Plaid Sandbox
accounts (14), and Plaid transaction sync. No ingestion schedule was restarted.

The timezone change was applied to a staged copy of the local warehouse after
10 dbt models and 22 data tests passed. Promotion preserved all 94 context-row
IDs and left non-calendar rows unchanged; the original database was backed up.
Vector files were not modified: calendar tools hydrate current temporal fields
from the rebuilt warehouse rather than reuse stale vector timestamps.

Validation passed: 225 agent tests, 56 web tests, 7 calendar parsing tests,
17 retrieval contract tests, and the extended dbt incremental integration test;
TypeScript checks, production builds, and targeted Python lint/format checks
also passed. Two paid-network smoke tests stayed skipped in the offline suite.

One separately approved live Claude turn over synthetic fixtures answered:
“Your dentist appointment was on 2026-01-05, from 3:30 PM to 4:30 PM
(UTC-03:30, America/St_Johns)” with the correct calendar citation. Configured
estimated model cost: USD 0.024615. This is one regression, not a new full eval.
