"""Deterministic synthetic demo data for LedgerLens.

Writes Plaid transactions, Alpaca account snapshots and orders, and Google
Calendar events in the same raw JSON envelope the extractors write
(load/file_writer.py), so `dbt build` runs on it unchanged:

    python scripts/seed/generate.py --out .demo/raw_data
    RAW_DATA_ROOT=../.demo/raw_data DUCKDB_PATH=../.demo/financial_engine.db dbt build

Everything is synthetic: one fictional person, fictional merchants and
accounts. No real person's financial data is involved. The same --seed and
--end-date always produce byte-identical files, so eval answers stay stable;
nothing reads the clock.
"""

from __future__ import annotations

import argparse
import json
import random
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from pathlib import Path

DEFAULT_SEED = 20261130
DEFAULT_END = date(2026, 11, 30)
MONTHS = 6
TIME_ZONE = "America/St_Johns"
RUN_ID = "synthetic-seed-v1"
ACCOUNT_ID = "demo-checking-0001"
BROKER_ACCOUNT_ID = "demo-brokerage-0001"
CALENDAR_OWNER = "demo.user@example.com"


@dataclass(frozen=True)
class Merchant:
    name: str
    category: tuple[str, str]
    low: float
    high: float


COFFEE = [
    Merchant("Starbucks", ("Food and Drink", "Coffee Shop"), 4.33, 4.33),
    Merchant("Tim Hortons", ("Food and Drink", "Coffee Shop"), 2.10, 6.45),
    Merchant("Fixed Coffee & Baking", ("Food and Drink", "Coffee Shop"), 4.75, 9.80),
]
GROCERIES = [
    Merchant("Sobeys", ("Shops", "Supermarkets and Groceries"), 48.0, 142.0),
    Merchant("Costco", ("Shops", "Supermarkets and Groceries"), 95.0, 260.0),
]
RESTAURANTS = [
    Merchant("Mallard Cottage", ("Food and Drink", "Restaurants"), 38.0, 96.0),
    Merchant("Piatto Pizzeria", ("Food and Drink", "Restaurants"), 24.0, 58.0),
    Merchant("Pi Pizzeria", ("Food and Drink", "Restaurants"), 18.0, 42.0),
]
SHOPPING = [
    Merchant("Amazon", ("Shops", "Digital Purchase"), 12.0, 89.0),
    Merchant("Canadian Tire", ("Shops", "Hardware Store"), 15.0, 120.0),
]
RIDES = [Merchant("Uber", ("Travel", "Ride Share"), 9.0, 27.0)]


def money(rng: random.Random, low: float, high: float) -> float:
    return round(rng.uniform(low, high), 2) if high > low else round(low, 2)


def month_starts(end: date, months: int) -> list[date]:
    first = end.replace(day=1)
    starts = []
    for _ in range(months):
        starts.append(first)
        first = (first - timedelta(days=1)).replace(day=1)
    return sorted(starts)


def envelope(source: str, resource: str, extracted: datetime, payload: object) -> dict:
    return {
        "metadata": {
            "extracted_at": extracted.strftime("%Y-%m-%dT%H:%M:%S.000000+00:00"),
            "source": source,
            "resource": resource,
            "run_id": RUN_ID,
            "partition_date": extracted.date().isoformat(),
        },
        "raw_payload": payload,
    }


def transactions(rng: random.Random, start: date, end: date) -> list[dict]:
    rows: list[tuple[date, str, tuple[str, str], float]] = []

    def add(day: date, name: str, category: tuple[str, str], amount: float) -> None:
        if start <= day <= end:
            rows.append((day, name, category, round(amount, 2)))

    for month in month_starts(end, MONTHS):
        add(month, "Harbourview Property Management", ("Payment", "Rent"), 1650.00)
        add(
            month + timedelta(days=4),
            "Newfoundland Power",
            ("Service", "Utilities"),
            money(rng, 78, 141),
        )
        add(
            month + timedelta(days=9),
            "Bell Mobility",
            ("Service", "Telecommunication Services"),
            55.00,
        )
        add(month + timedelta(days=11), "Netflix", ("Service", "Subscription"), 16.99)
        add(
            month + timedelta(days=2),
            "Wallnut Climbing Gym",
            ("Recreation", "Gyms and Fitness Centers"),
            65.00,
        )

    # Biweekly payroll (Plaid: money in is negative).
    payday = start + timedelta(days=(4 - start.weekday()) % 7)  # first Friday
    while payday <= end:
        add(
            payday,
            "Payroll Deposit - Atlantic Analytics",
            ("Transfer", "Payroll"),
            -2850.00,
        )
        payday += timedelta(days=14)

    day = start
    while day <= end:
        weekday = day.weekday()
        if weekday < 5 and rng.random() < 0.55:
            m = rng.choice(COFFEE)
            add(day, m.name, m.category, money(rng, m.low, m.high))
        if weekday == 5:
            m = rng.choice(GROCERIES)
            add(day, m.name, m.category, money(rng, m.low, m.high))
        if weekday in (4, 5) and rng.random() < 0.45:
            m = rng.choice(RESTAURANTS)
            add(day, m.name, m.category, money(rng, m.low, m.high))
        if rng.random() < 0.09:
            m = rng.choice(SHOPPING)
            add(day, m.name, m.category, money(rng, m.low, m.high))
        if rng.random() < 0.06:
            m = RIDES[0]
            add(day, m.name, m.category, money(rng, m.low, m.high))
        if weekday == 2 and rng.random() < 0.3:
            add(
                day,
                "Wallnut Climbing Gym - Day Pass",
                ("Recreation", "Gyms and Fitness Centers"),
                22.00,
            )
        day += timedelta(days=1)

    # One trip, so "travel" questions have an answer.
    trip = end.replace(day=1) - timedelta(days=40)
    add(trip, "Air Canada", ("Travel", "Airlines and Aviation Services"), 412.30)
    add(trip + timedelta(days=1), "Hotel X Toronto", ("Travel", "Lodging"), 389.40)

    rows.sort(key=lambda r: (r[0], r[1], r[3]))
    return [
        {
            "transaction_id": f"seed-txn-{i:04d}",
            "account_id": ACCOUNT_ID,
            "amount": amount,
            "date": day.isoformat(),
            "name": name,
            "category": list(category),
            "pending": False,
        }
        for i, (day, name, category, amount) in enumerate(rows, start=1)
    ]


def orders(rng: random.Random, start: date, end: date) -> list[dict]:
    plan = [
        ("VTI", "buy", 4, 286.40),
        ("AAPL", "buy", 5, 229.15),
        ("MSFT", "buy", 3, 431.80),
        ("VTI", "buy", 4, 291.05),
        ("NVDA", "buy", 6, 132.60),
        ("AAPL", "sell", 2, 236.90),
        ("VTI", "buy", 4, 297.25),
        ("MSFT", "buy", 2, 446.10),
    ]
    span = (end - start).days
    out = []
    for i, (symbol, side, qty, price) in enumerate(plan, start=1):
        day = start + timedelta(days=round(span * i / (len(plan) + 1)))
        created = datetime.combine(day, time(14, 30))
        filled = created + timedelta(seconds=rng.randint(1, 9))
        out.append(
            {
                "id": f"seed-order-{i:03d}",
                "client_order_id": f"seed-client-order-{i:03d}",
                "symbol": symbol,
                "qty": str(qty),
                "type": "market",
                "side": side,
                "status": "filled",
                "created_at": created.strftime("%Y-%m-%dT%H:%M:%S.000000Z"),
                "filled_at": filled.strftime("%Y-%m-%dT%H:%M:%S.000000Z"),
                "filled_avg_price": f"{price:.2f}",
            }
        )
    return out


def account_snapshot(month_end: date, index: int) -> dict:
    cash = 18250.00 - index * 410.00
    long_value = 9800.00 + index * 735.50
    equity = round(cash + long_value, 2)
    return {
        "id": BROKER_ACCOUNT_ID,
        "status": "ACTIVE",
        "cash": f"{cash:.2f}",
        "equity": f"{equity:.2f}",
        "portfolio_value": f"{equity:.2f}",
        "buying_power": f"{cash * 2:.2f}",
        "long_market_value": f"{long_value:.2f}",
        "short_market_value": "0",
    }


def timed(
    eid: str,
    summary: str,
    day: date,
    start: time,
    minutes: int,
    location: str | None,
    description: str,
) -> dict:
    begin = datetime.combine(day, start)
    finish = begin + timedelta(minutes=minutes)
    return {
        "kind": "calendar#event",
        "id": eid,
        "status": "confirmed",
        "summary": summary,
        "description": description,
        "start": {
            "dateTime": begin.strftime("%Y-%m-%dT%H:%M:%S"),
            "timeZone": TIME_ZONE,
        },
        "end": {
            "dateTime": finish.strftime("%Y-%m-%dT%H:%M:%S"),
            "timeZone": TIME_ZONE,
        },
        "organizer": {"email": CALENDAR_OWNER},
        "location": location,
    }


def all_day(eid: str, summary: str, first: date, days: int, description: str) -> dict:
    return {
        "kind": "calendar#event",
        "id": eid,
        "status": "confirmed",
        "summary": summary,
        "description": description,
        "start": {"date": first.isoformat()},
        "end": {"date": (first + timedelta(days=days)).isoformat()},
        "organizer": {"email": CALENDAR_OWNER},
        "location": None,
    }


def events(rng: random.Random, start: date, end: date) -> list[dict]:
    out = []
    n = 0

    def next_id() -> str:
        nonlocal n
        n += 1
        return f"seed-event-{n:04d}"

    day = start
    while day <= end:
        if day.weekday() in (1, 3) and rng.random() < 0.7:
            out.append(
                timed(
                    next_id(),
                    "Rock climbing",
                    day,
                    time(18, 30),
                    90,
                    "Wallnut Climbing Gym",
                    "Bouldering session",
                )
            )
        if day.weekday() == 0:
            out.append(
                timed(
                    next_id(),
                    "1:1 with manager",
                    day,
                    time(10, 0),
                    30,
                    None,
                    "Weekly check-in",
                )
            )
        day += timedelta(days=1)

    middle = start + (end - start) / 2
    out.append(
        timed(
            next_id(),
            "Dentist appointment",
            middle,
            time(14, 0),
            60,
            "Water Street Dental",
            "Cleaning and checkup",
        )
    )
    out.append(
        timed(
            next_id(),
            "Doctor appointment",
            start + timedelta(days=20),
            time(9, 30),
            30,
            "Torbay Road Clinic",
            "Annual physical",
        )
    )
    trip = end.replace(day=1) - timedelta(days=40)
    out.append(
        all_day(
            next_id(), "Trip to Toronto", trip, 3, "Conference and visiting friends"
        )
    )
    out.append(
        timed(
            next_id(),
            "Flight AC 691 to Toronto",
            trip,
            time(7, 15),
            165,
            "St. John's Airport (YYT)",
            "Air Canada",
        )
    )
    out.append(
        all_day(
            next_id(), "Sam's birthday", end - timedelta(days=12), 1, "Bring a card"
        )
    )
    out.sort(key=lambda e: (e["start"].get("dateTime") or e["start"]["date"], e["id"]))
    return out


def write(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(data, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
        newline="\n",
    )


def generate(
    out: Path, seed: int = DEFAULT_SEED, end: date = DEFAULT_END
) -> dict[str, int]:
    starts = month_starts(end, MONTHS)
    start = starts[0]
    extracted = datetime.combine(end + timedelta(days=1), time(9, 0))
    partition = extracted.date().isoformat()

    # Separate generators per source, so adding a source never shifts another's data.
    txns = transactions(random.Random(seed), start, end)
    write(
        out / "plaid" / "transactions" / partition / "seed.json",
        envelope(
            "plaid",
            "transactions",
            extracted,
            {"added": txns, "modified": [], "removed": []},
        ),
    )

    order_rows = orders(random.Random(seed + 1), start, end)
    write(
        out / "alpaca" / "orders" / partition / "seed.json",
        envelope("alpaca", "orders", extracted, order_rows),
    )

    for index, month in enumerate(starts):
        month_end = (month + timedelta(days=32)).replace(day=1) - timedelta(days=1)
        stamp = datetime.combine(min(month_end, end) + timedelta(days=1), time(9, 0))
        write(
            out / "alpaca" / "account" / stamp.date().isoformat() / "seed.json",
            envelope("alpaca", "account", stamp, account_snapshot(month_end, index)),
        )

    event_rows = events(random.Random(seed + 2), start, end)
    write(
        out / "google_calendar" / "events" / partition / "seed.json",
        envelope(
            "google_calendar",
            "events",
            extracted,
            {
                "kind": "calendar#events",
                "summary": CALENDAR_OWNER,
                "timeZone": TIME_ZONE,
                "items": event_rows,
            },
        ),
    )

    return {
        "transactions": len(txns),
        "orders": len(order_rows),
        "account_snapshots": len(starts),
        "events": len(event_rows),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument(
        "--out",
        type=Path,
        default=Path(".demo/raw_data"),
        help="raw_data root to write into",
    )
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument(
        "--end-date",
        type=date.fromisoformat,
        default=DEFAULT_END,
        help="last day of data (YYYY-MM-DD); six months are generated up to it",
    )
    args = parser.parse_args()
    counts = generate(args.out, args.seed, args.end_date)
    print(json.dumps({"out": str(args.out), **counts}))


if __name__ == "__main__":
    main()
