import importlib.util
import sys
from datetime import date
from pathlib import Path

SEED_PATH = (
    Path(__file__).resolve().parents[1]
    / "scripts"
    / "seed"
    / "generate_advisor_book.py"
)


def _load_module():
    spec = importlib.util.spec_from_file_location("generate_advisor_book", SEED_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_advisor_book_is_byte_identical_across_runs(tmp_path):
    mod = _load_module()
    p1 = tmp_path / "run1.json"
    p2 = tmp_path / "run2.json"
    mod.write_book(p1)
    mod.write_book(p2)
    assert p1.read_bytes() == p2.read_bytes()


def test_advisor_book_matches_phase3_shape_and_synthetic_label():
    mod = _load_module()
    book = mod.generate_advisor_book()

    assert book["meta"]["synthetic"] is True
    assert len(book["firms"]) == 1
    assert len(book["advisors"]) == 2
    assert len(book["households"]) == 60
    assert len(book["accounts"]) >= 120
    assert len(book["meeting_notes"]) == 150
    assert len(book["emails"]) == 300
    assert len(book["calendar_events"]) >= 30
    assert len(book["tasks"]) >= 20

    custodians = {a["custodian"] for a in book["accounts"]}
    assert custodians == {"Harbour Clearing", "Northstar Custody"}


def test_advisor_book_contains_all_four_deliberate_messes_and_anchors():
    mod = _load_module()
    book = mod.generate_advisor_book()

    # 1. Same client at two custodians (Priya Nair)
    priya_accts = [a for a in book["accounts"] if a["household_id"] == "hh_priya_nair"]
    assert {a["custodian"] for a in priya_accts} == {
        "Harbour Clearing",
        "Northstar Custody",
    }

    # 2. Spouse in two households (Elena Vance)
    elena_hhs = {
        m["household_id"]
        for m in book["household_members"]
        if m["full_name"] == "Elena Vance"
    }
    assert elena_hhs == {"hh_vance_joint", "hh_vance_trust"}

    # 3. Stale address for Priya Nair (CRM has 48 Duckworth St; note has 12 Water St)
    priya_hh = next(
        h for h in book["households"] if h["household_id"] == "hh_priya_nair"
    )
    assert "48 Duckworth St" in priya_hh["address"]
    priya_note = next(
        n for n in book["meeting_notes"] if n["note_id"] == "note_priya_move"
    )
    assert "12 Water St" in priya_note["transcript"]

    # 4. Embedded prompt-injection meeting note
    inj_note = next(
        n for n in book["meeting_notes"] if n["note_id"] == "note_injection_001"
    )
    assert "IGNORE ALL PRIOR INSTRUCTIONS" in inj_note["transcript"]

    # Anchor flow: Chens' daughter's tuition
    chen_note = next(
        n for n in book["meeting_notes"] if n["note_id"] == "note_chen_tuition"
    )
    assert "tuition" in chen_note["transcript"].lower()
    assert "$28,000" in chen_note["transcript"]

    # Anchor flow: Multiple adv_sarah clients hold MSFT & have overdue reviews
    cutoff = date(2026, 5, 30).isoformat()
    msft_hhs = {
        p["household_id"]
        for p in book["positions"]
        if p["symbol"] == "MSFT" and p["advisor_id"] == "adv_sarah"
    }
    overdue_msft = [
        h
        for h in book["households"]
        if h["advisor_id"] == "adv_sarah"
        and h["household_id"] in msft_hhs
        and h["last_review_date"] < cutoff
    ]
    assert len(overdue_msft) >= 5

    # Anchor flow: Marcus's client is isolated under adv_marcus
    owen = next(
        h for h in book["households"] if h["household_id"] == "hh_marcus_anchor"
    )
    assert owen["advisor_id"] == "adv_marcus"
