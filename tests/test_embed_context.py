"""Vector synchronization must mirror deletions as well as changes."""

from unittest.mock import MagicMock

import chromadb
import numpy as np
import pandas as pd
import pytest
from chromadb.config import Settings

from vector_prep.embed_context import content_hash, synchronize_collection


@pytest.fixture
def collection(tmp_path):
    client = chromadb.PersistentClient(
        path=str(tmp_path / "vectors"), settings=Settings(anonymized_telemetry=False)
    )
    return client.create_collection("audit-vectors", metadata={"hnsw:space": "cosine"})


def snapshot(*rows):
    return pd.DataFrame(
        [(row_id, text, "plaid", "2026-01-01 00:00:00") for row_id, text in rows],
        columns=["unique_id", "context_string", "source_system", "record_date"],
    )


def test_sync_updates_prunes_and_is_idempotent(collection):
    collection.upsert(
        ids=["keep", "change", "removed"],
        documents=["unchanged", "old", "deleted transaction"],
        embeddings=[[1.0, 0.0]] * 3,
        metadatas=[
            {"content_hash": content_hash(text)}
            for text in ["unchanged", "old", "deleted transaction"]
        ],
    )
    model = MagicMock()
    model.encode.return_value = np.array([[0.0, 1.0], [0.0, 1.0]])
    df = snapshot(("keep", "unchanged"), ("change", "updated"), ("new", "added"))
    stats = synchronize_collection(df, model, collection)
    assert stats == {"scanned": 3, "embedded": 2, "skipped": 1, "deleted": 1}
    stored = collection.get(include=["documents"])
    assert dict(zip(stored["ids"], stored["documents"], strict=True)) == {
        "keep": "unchanged",
        "change": "updated",
        "new": "added",
    }
    model.reset_mock()
    assert synchronize_collection(df, model, collection) == {
        "scanned": 3,
        "embedded": 0,
        "skipped": 3,
        "deleted": 0,
    }
    model.encode.assert_not_called()


def test_empty_snapshot_prunes_all_pages_without_skipping(collection, monkeypatch):
    monkeypatch.setattr("vector_prep.embed_context.BATCH_SIZE", 2)
    collection.upsert(ids=[f"gone-{i}" for i in range(7)], embeddings=[[1.0, 0.0]] * 7)
    stats = synchronize_collection(snapshot(), MagicMock(), collection)
    assert stats["deleted"] == 7
    assert collection.count() == 0


def test_failed_embedding_does_not_delete_existing_records(collection):
    collection.upsert(ids=["existing"], embeddings=[[1.0, 0.0]])
    model = MagicMock()
    model.encode.side_effect = RuntimeError("embedding failed")
    with pytest.raises(RuntimeError, match="embedding failed"):
        synchronize_collection(snapshot(("new", "new document")), model, collection)
    assert collection.get()["ids"] == ["existing"]
