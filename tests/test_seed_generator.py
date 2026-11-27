"""The demo seed must be deterministic and shaped like extractor output."""

import importlib.util
import json
import sys
from datetime import date
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location(
    "seed_generate", REPO_ROOT / "scripts" / "seed" / "generate.py"
)
assert _spec and _spec.loader
seed = importlib.util.module_from_spec(_spec)
# @dataclass looks the module up in sys.modules while the class is created.
sys.modules[_spec.name] = seed
_spec.loader.exec_module(seed)


def _files(root: Path) -> dict[str, bytes]:
    return {
        str(p.relative_to(root)): p.read_bytes() for p in sorted(root.rglob("*.json"))
    }


def test_same_seed_and_end_date_give_identical_files(tmp_path: Path) -> None:
    seed.generate(tmp_path / "a")
    seed.generate(tmp_path / "b")
    assert _files(tmp_path / "a") == _files(tmp_path / "b")


def test_a_different_seed_changes_the_data(tmp_path: Path) -> None:
    seed.generate(tmp_path / "a", seed=1)
    seed.generate(tmp_path / "b", seed=2)
    assert _files(tmp_path / "a") != _files(tmp_path / "b")


def test_writes_the_extractor_envelope_for_every_source(tmp_path: Path) -> None:
    counts = seed.generate(tmp_path)
    assert counts["transactions"] > 100
    assert counts["account_snapshots"] == seed.MONTHS
    for path in tmp_path.rglob("*.json"):
        doc = json.loads(path.read_text(encoding="utf-8"))
        assert set(doc) == {"metadata", "raw_payload"}
        meta = doc["metadata"]
        assert meta["run_id"] == seed.RUN_ID
        # dbt globs <source>/<resource>/<partition>/*.json
        source_dir, resource_dir, partition_dir = path.relative_to(tmp_path).parts[:3]
        assert meta["resource"] == resource_dir
        assert meta["partition_date"] == partition_dir
        assert source_dir in {"plaid", "alpaca", "google_calendar"}


def test_data_stays_inside_the_six_month_window(tmp_path: Path) -> None:
    end = date(2026, 5, 31)
    seed.generate(tmp_path, end=end)
    plaid = json.loads(
        next(tmp_path.glob("plaid/transactions/*/seed.json")).read_text(
            encoding="utf-8"
        )
    )
    days = [date.fromisoformat(t["date"]) for t in plaid["raw_payload"]["added"]]
    assert min(days) >= date(2025, 12, 1)
    assert max(days) <= end
    assert len({t["transaction_id"] for t in plaid["raw_payload"]["added"]}) == len(
        days
    )


def test_includes_the_records_the_demo_questions_rely_on(tmp_path: Path) -> None:
    seed.generate(tmp_path)
    plaid = json.loads(
        next(tmp_path.glob("plaid/transactions/*/seed.json")).read_text(
            encoding="utf-8"
        )
    )
    names = {t["name"] for t in plaid["raw_payload"]["added"]}
    assert {"Starbucks", "Air Canada", "Wallnut Climbing Gym"} <= names
    assert any(t["amount"] < 0 for t in plaid["raw_payload"]["added"]), (
        "payroll is money in"
    )
    events = json.loads(
        next(tmp_path.glob("google_calendar/events/*/seed.json")).read_text(
            encoding="utf-8"
        )
    )
    summaries = {e["summary"] for e in events["raw_payload"]["items"]}
    assert {"Rock climbing", "Dentist appointment"} <= summaries
