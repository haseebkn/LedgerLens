"""Airflow must not mark failed provider extraction as successful."""

from unittest.mock import MagicMock

import pytest

from extract import run_extraction


@pytest.fixture
def configured_sources(monkeypatch):
    monkeypatch.setattr(run_extraction.os.path, "exists", lambda _: True)
    monkeypatch.setattr(run_extraction, "load_dotenv", lambda: None)
    monkeypatch.setattr(run_extraction, "settings", MagicMock())
    writer = MagicMock()
    monkeypatch.setattr(run_extraction, "RawFileWriter", lambda **_: writer)
    providers = {}
    for name in ("GoogleCalendarExtractor", "AlpacaExtractor", "PlaidExtractor"):
        factory = MagicMock()
        factory.return_value.extract.return_value = iter(
            [{"items": []}]
            if name == "GoogleCalendarExtractor"
            else [{"resource": "accounts", "data": {"id": "fixture"}}]
        )
        monkeypatch.setattr(run_extraction, name, factory)
        providers[name] = factory
    return providers, writer


def test_all_configured_sources_complete(configured_sources):
    _, writer = configured_sources
    run_extraction.main()
    assert writer.write_record.call_count == 3


@pytest.mark.parametrize(
    "provider", ["GoogleCalendarExtractor", "AlpacaExtractor", "PlaidExtractor"]
)
def test_provider_failure_fails_the_airflow_task(configured_sources, provider):
    providers, _ = configured_sources
    providers[provider].side_effect = RuntimeError("provider unavailable")
    with pytest.raises(RuntimeError, match="Extraction failed"):
        run_extraction.main()


def test_no_configured_sources_does_not_report_ingestion_success(
    configured_sources, monkeypatch
):
    monkeypatch.setattr(run_extraction.os.path, "exists", lambda _: False)
    for key in (
        "alpaca_api_key_id",
        "alpaca_api_secret_key",
        "plaid_client_id",
        "plaid_secret",
        "plaid_access_token",
    ):
        setattr(run_extraction.settings, key, None)
    with pytest.raises(RuntimeError, match="No extraction sources"):
        run_extraction.main()


def test_scheduled_google_auth_fails_without_opening_a_browser(monkeypatch):
    from types import SimpleNamespace

    from extract import google_calendar_extractor as calendar

    extractor = calendar.GoogleCalendarExtractor.__new__(
        calendar.GoogleCalendarExtractor
    )
    extractor.token_path = "fixture-token.json"
    extractor.credentials_path = "fixture-credentials.json"
    extractor.scopes = ["https://www.googleapis.com/auth/calendar.readonly"]
    extractor.logger = MagicMock()
    monkeypatch.setattr(calendar.os.path, "exists", lambda _: False)
    monkeypatch.setattr(
        calendar, "settings", SimpleNamespace(google_oauth_interactive=False)
    )
    flow = MagicMock()
    monkeypatch.setattr(calendar.InstalledAppFlow, "from_client_secrets_file", flow)
    with pytest.raises(RuntimeError, match="interactive renewal"):
        extractor._authenticate()
    flow.assert_not_called()
