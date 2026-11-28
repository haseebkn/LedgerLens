"""Source offsets and all-day semantics must survive actual DuckDB parsing."""

import json
from pathlib import Path

import duckdb
import pytest

ROOT = Path(__file__).resolve().parents[1]


def staged_events(tmp_path, events, session_zone="UTC"):
    path = tmp_path / "calendar.json"
    path.write_text(
        json.dumps(
            {
                "metadata": {
                    "extracted_at": "2026-01-01T09:00:00Z",
                    "run_id": "timezone-test",
                },
                "raw_payload": {"items": events},
            }
        ),
        encoding="utf-8",
    )
    sql = (ROOT / "transform/models/staging/stg_calendar_events.sql").read_text()
    sql = sql.replace('{{ var("google_calendar_events_path") }}', path.as_posix())
    with duckdb.connect() as connection:
        connection.execute("SET TimeZone = ?", [session_zone])
        cursor = connection.execute(sql)
        columns = [field[0] for field in cursor.description]
        return [dict(zip(columns, row, strict=True)) for row in cursor.fetchall()]


@pytest.mark.parametrize(
    "session_zone", ["UTC", "America/St_Johns", "America/Los_Angeles"]
)
def test_original_offset_and_utc_instant_survive_json_inference(tmp_path, session_zone):
    [row] = staged_events(
        tmp_path,
        [
            {
                "id": "dentist",
                "start": {"dateTime": "2026-01-05T14:00:00-05:00"},
                "end": {"dateTime": "2026-01-05T15:00:00-05:00"},
            }
        ],
        session_zone,
    )
    assert row["source_start"] == "2026-01-05T14:00:00-05:00"
    assert row["start_time"].isoformat() == "2026-01-05T19:00:00"
    assert row["end_time"].isoformat() == "2026-01-05T20:00:00"
    assert row["time_zone_known"] is True
    assert row["all_day"] is False


def test_all_day_dates_and_exclusive_end_are_not_timezone_shifted(tmp_path):
    [row] = staged_events(
        tmp_path,
        [
            {
                "id": "birthday",
                "start": {"date": "2026-07-26"},
                "end": {"date": "2026-07-27"},
            }
        ],
        "America/St_Johns",
    )
    assert row["all_day"] is True
    assert row["source_start"] == "2026-07-26"
    assert row["source_end"] == "2026-07-27"
    assert row["start_time"].isoformat() == "2026-07-26T00:00:00"


def test_explicit_iana_zone_is_used_when_source_omits_offset(tmp_path):
    [row] = staged_events(
        tmp_path,
        [
            {
                "id": "summer",
                "start": {
                    "dateTime": "2026-07-05T14:00:00",
                    "timeZone": "America/New_York",
                },
                "end": {
                    "dateTime": "2026-07-05T15:00:00",
                    "timeZone": "America/New_York",
                },
            }
        ],
    )
    assert row["start_time"].isoformat() == "2026-07-05T18:00:00"
    assert row["time_zone_known"] is True


def test_ambiguous_offset_free_times_are_not_claimed_to_be_utc(tmp_path):
    [row] = staged_events(
        tmp_path,
        [
            {
                "id": "unknown",
                "start": {"dateTime": "2026-01-05T14:00:00"},
                "end": {"dateTime": "2026-01-05T15:00:00"},
            }
        ],
    )
    assert not row["time_zone_known"]


def test_offsets_disambiguate_the_repeated_hour_at_dst_fall_back(tmp_path):
    [row] = staged_events(
        tmp_path,
        [
            {
                "id": "fall-back",
                "start": {"dateTime": "2026-11-01T01:30:00-02:30"},
                "end": {"dateTime": "2026-11-01T01:30:00-03:30"},
            }
        ],
    )
    assert (row["end_time"] - row["start_time"]).total_seconds() == 3600
