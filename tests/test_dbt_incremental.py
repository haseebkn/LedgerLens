"""Exercise real dbt builds on copied fixture data and an isolated warehouse."""

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import duckdb

REPO_ROOT = Path(__file__).resolve().parents[1]


def test_incremental_build_propagates_deletions_and_late_arrivals(tmp_path):
    project = tmp_path / "transform"
    raw = tmp_path / "raw"
    warehouse = tmp_path / "audit.duckdb"
    shutil.copytree(
        REPO_ROOT / "transform",
        project,
        ignore=shutil.ignore_patterns("target", "logs", "dbt_packages", ".user.yml"),
    )
    shutil.copytree(REPO_ROOT / "tests" / "fixtures" / "raw", raw)
    env = {
        **os.environ,
        "RAW_DATA_ROOT": raw.as_posix(),
        "DUCKDB_PATH": warehouse.as_posix(),
        "DBT_SEND_ANONYMOUS_USAGE_STATS": "false",
    }

    def build(*args):
        result = subprocess.run(
            [
                sys.executable,
                "-c",
                "from dbt.cli.main import cli; cli()",
                "build",
                "--project-dir",
                str(project),
                "--profiles-dir",
                str(project),
                "--target-path",
                str(project / "target"),
                "--log-path",
                str(project / "logs"),
                *args,
            ],
            cwd=project,
            env=env,
            capture_output=True,
            text=True,
            timeout=120,
        )
        assert result.returncode == 0, result.stdout + result.stderr

    build("--full-refresh")
    original = json.loads(
        (raw / "plaid/transactions/2026-01-01/transactions_fixture.json").read_text()
    )
    removed = {
        "metadata": {**original["metadata"], "extracted_at": "2026-01-03T09:00:00Z"},
        "raw_payload": {
            "added": [],
            "modified": [],
            "removed": [{"transaction_id": "fixture-txn-1"}],
        },
    }
    (raw / "plaid/transactions/2026-01-01/removed.json").write_text(json.dumps(removed))
    build()
    with duckdb.connect(str(warehouse), read_only=True) as conn:
        ids = {
            row[0]
            for row in conn.execute(
                "select row_id from main_analytics.fct_context_rows"
            ).fetchall()
        }
    assert "plaid_fixture-txn-1" not in ids
    assert "plaid_fixture-txn-2" in ids

    # This file arrives after the newer extraction was built, but carries the
    # same timestamp as the existing source rows. A global > watermark loses it.
    late = {
        "metadata": original["metadata"],
        "raw_payload": {
            "added": [
                {**original["raw_payload"]["added"][1], "transaction_id": "late-txn"}
            ],
            "modified": [],
            "removed": [],
        },
    }
    (raw / "plaid/transactions/2026-01-01/late.json").write_text(json.dumps(late))
    build()
    with duckdb.connect(str(warehouse), read_only=True) as conn:
        ids = [
            row[0]
            for row in conn.execute(
                "select row_id from main_analytics.fct_context_rows"
            ).fetchall()
        ]
    assert "plaid_late-txn" in ids
    assert "plaid_fixture-txn-1" not in ids
    assert len(ids) == len(set(ids))

    # Exercise the complete staging -> intermediate -> incremental mart path,
    # not only timestamp parsing in isolation. Existing calendar IDs stay stable.
    with duckdb.connect(str(warehouse), read_only=True) as conn:
        text, payload = conn.execute(
            "select summary_text, raw_payload from main_analytics.fct_context_rows "
            "where row_id = 'calendar_fixture-event-1'"
        ).fetchone()
    assert "2026-01-05T19:00:00Z" in text
    assert "(UTC)" in text
    assert json.loads(payload)["source_start"] == "2026-01-05T14:00:00-05:00"
    assert json.loads(payload)["start_time_utc"] == "2026-01-05T19:00:00Z"

    calendar_dir = raw / "google_calendar/events/2026-01-01"
    calendar = json.loads((calendar_dir / "events_fixture.json").read_text())
    calendar["metadata"]["extracted_at"] = "2026-01-04T09:00:00Z"
    calendar["raw_payload"]["items"] = [
        {
            "id": "all-day-timezone-regression",
            "summary": "Birthday",
            "start": {"date": "2026-07-26"},
            "end": {"date": "2026-07-27"},
        }
    ]
    (calendar_dir / "all-day.json").write_text(json.dumps(calendar))
    build()
    with duckdb.connect(str(warehouse), read_only=True) as conn:
        text, payload = conn.execute(
            "select summary_text, raw_payload from main_analytics.fct_context_rows "
            "where row_id = 'calendar_all-day-timezone-regression'"
        ).fetchone()
    data = json.loads(payload)
    assert data["all_day"] is True
    assert data["source_start"] == "2026-07-26"
    assert data["source_end"] == "2026-07-27"
    assert data["start_time_utc"] is None
    assert "end date exclusive" in text
    assert "00:00" not in text
