"""
Tests for the internal retrieval service's HTTP contract: auth enforcement,
readiness gating, and search parameter handling. The real embedding model
and ChromaDB are never loaded here — the service's lifespan-managed state
is stubbed directly with a fake model/collection so these tests run fast
and without a GPU.
"""

import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "vector_prep"))

import vector_prep.retrieval_service as svc_module  # noqa: E402
from vector_prep.retrieval_service import ServiceState, app  # noqa: E402

TOKEN = "test-internal-token"


class FakeModel:
    def encode(self, texts, normalize_embeddings=True):
        return MagicMock(tolist=lambda: [[0.1, 0.2, 0.3]])


class FakeCollection:
    def __init__(self, results=None, count=3):
        self._results = results or {
            "ids": [["calendar_e1", "plaid_t1"]],
            "documents": [["Calendar Event: Dentist", "Financial Transaction: Coffee"]],
            "metadatas": [
                [
                    {"source_system": "calendar", "record_date": "2026-01-05 14:00:00"},
                    {"source_system": "plaid", "record_date": "2026-01-02 09:00:00"},
                ]
            ],
            "distances": [[0.1, 0.3]],
        }
        self._count = count
        self.last_query_kwargs = None

    def query(self, **kwargs):
        self.last_query_kwargs = kwargs
        return self._results

    def count(self):
        return self._count

    def get(self, where=None, **kwargs):
        metadata = self._results["metadatas"][0]
        if where:
            metadata = [
                m
                for m in metadata
                if m["source_system"] == where["source_system"]["$eq"]
            ]
        return {"ids": [str(i) for i in range(len(metadata))], "metadatas": metadata}


@pytest.fixture(autouse=True)
def configured_token(monkeypatch):
    monkeypatch.setattr(svc_module.settings, "retrieval_service_token", TOKEN)


@pytest.fixture
def ready_client():
    state = ServiceState()
    state.model = FakeModel()
    state.collection = FakeCollection()
    state.device_name = "CPU (test)"

    # TestClient without a `with` block does not run the app's lifespan
    # (which would load the real SentenceTransformer model and ChromaDB) —
    # set the state it would have produced directly instead.
    client = TestClient(app)
    client.app.state.retrieval = state
    yield client, state


def test_health_unauthenticated_reports_ready(ready_client):
    client, _ = ready_client
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ready"


def test_health_reports_not_ready_when_state_failed(ready_client):
    client, state = ready_client
    state.model = None
    state.collection = None
    state.error = "chroma dir not found"

    resp = client.get("/health")
    assert resp.status_code == 503
    assert resp.json()["detail"] == "chroma dir not found"


def test_search_requires_token(ready_client):
    client, _ = ready_client
    resp = client.get("/api/search", params={"q": "coffee"})
    assert resp.status_code == 401


def test_search_rejects_wrong_token(ready_client):
    client, _ = ready_client
    resp = client.get(
        "/api/search", params={"q": "coffee"}, headers={"X-Internal-Token": "wrong"}
    )
    assert resp.status_code == 401


def test_search_returns_results_with_similarity(ready_client):
    client, _ = ready_client
    resp = client.get(
        "/api/search", params={"q": "coffee"}, headers={"X-Internal-Token": TOKEN}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["query"] == "coffee"
    assert len(body["results"]) == 2
    first = body["results"][0]
    assert first["row_id"] == "calendar_e1"
    assert first["source"] == "calendar"
    assert first["distance"] == pytest.approx(0.1)
    assert first["similarity"] == pytest.approx(0.9)


def test_search_without_token_configured_is_503(ready_client, monkeypatch):
    client, _ = ready_client
    monkeypatch.setattr(svc_module.settings, "retrieval_service_token", None)
    resp = client.get(
        "/api/search", params={"q": "coffee"}, headers={"X-Internal-Token": "anything"}
    )
    assert resp.status_code == 503


def test_search_not_ready_returns_503(ready_client):
    client, state = ready_client
    state.model = None
    resp = client.get(
        "/api/search", params={"q": "coffee"}, headers={"X-Internal-Token": TOKEN}
    )
    assert resp.status_code == 503


def test_search_builds_source_filter(ready_client):
    client, state = ready_client
    client.get(
        "/api/search",
        params={"q": "coffee", "source": "plaid"},
        headers={"X-Internal-Token": TOKEN},
    )
    assert state.collection.last_query_kwargs["where"] == {
        "source_system": {"$eq": "plaid"}
    }


def test_search_builds_combined_date_range_and_source_filter(ready_client):
    client, state = ready_client
    client.get(
        "/api/search",
        params={
            "q": "coffee",
            "source": "plaid",
            "after": "2026-01-01",
            "before": "2026-01-31",
        },
        headers={"X-Internal-Token": TOKEN},
    )
    where = state.collection.last_query_kwargs["where"]
    assert where == {
        "$and": [
            {"source_system": {"$eq": "plaid"}},
            {"record_date": {"$in": ["2026-01-02 09:00:00"]}},
        ]
    }


def test_search_no_filters_passes_none_where(ready_client):
    client, state = ready_client
    client.get(
        "/api/search", params={"q": "coffee"}, headers={"X-Internal-Token": TOKEN}
    )
    assert state.collection.last_query_kwargs["where"] is None


def test_search_limit_is_clamped_by_query_validation(ready_client):
    client, _ = ready_client
    resp = client.get(
        "/api/search",
        params={"q": "coffee", "limit": 999},
        headers={"X-Internal-Token": TOKEN},
    )
    assert resp.status_code == 422  # exceeds le=MAX_LIMIT


def test_stats_returns_expected_shape(ready_client):
    client, _ = ready_client
    resp = client.get("/api/stats", headers={"X-Internal-Token": TOKEN})
    assert resp.status_code == 200
    body = resp.json()
    assert body["total_records"] == 3
    assert body["metric"] == "cosine"


@pytest.mark.parametrize(
    "params",
    [
        {"after": "not-a-date"},
        {"before": "2026-02-30"},
        {"after": "2026-02-01", "before": "2026-01-31"},
        {"after": "2026-01-01T00:00:00Z"},
    ],
)
def test_search_invalid_date_range_is_422(ready_client, params):
    client, state = ready_client
    response = client.get(
        "/api/search",
        params={"q": "coffee", **params},
        headers={"X-Internal-Token": TOKEN},
    )
    assert response.status_code == 422
    assert state.collection.last_query_kwargs is None


def test_date_filter_works_on_real_chroma_and_includes_the_whole_end_date(
    ready_client, tmp_path
):
    import chromadb
    from chromadb.config import Settings

    client, state = ready_client
    vectors = chromadb.PersistentClient(
        path=str(tmp_path / "vectors"), settings=Settings(anonymized_telemetry=False)
    ).create_collection("date-regression", metadata={"hnsw:space": "cosine"})
    vectors.upsert(
        ids=["jan-start", "jan-end", "feb", "calendar"],
        embeddings=[[0.1, 0.2, 0.3]] * 4,
        documents=["coffee"] * 4,
        metadatas=[
            {"record_date": "2026-01-01 00:00:00", "source_system": "plaid"},
            {"record_date": "2026-01-31 23:59:59.999999", "source_system": "plaid"},
            {"record_date": "2026-02-01 00:00:00", "source_system": "plaid"},
            {"record_date": "2026-01-15 12:00:00", "source_system": "calendar"},
        ],
    )
    state.collection = vectors
    response = client.get(
        "/api/search",
        params={
            "q": "coffee",
            "source": "plaid",
            "after": "2026-01-01",
            "before": "2026-01-31",
        },
        headers={"X-Internal-Token": TOKEN},
    )
    assert response.status_code == 200
    assert {row["row_id"] for row in response.json()["results"]} == {
        "jan-start",
        "jan-end",
    }

    empty = client.get(
        "/api/search",
        params={"q": "coffee", "before": "2025-01-01"},
        headers={"X-Internal-Token": TOKEN},
    )
    assert empty.status_code == 200
    assert empty.json()["results"] == []
