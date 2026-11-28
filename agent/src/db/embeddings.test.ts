import { describe, expect, it, vi } from "vitest";
import { computeLocalEmbedding, EMBEDDING_DIM, embedTexts, toPgVectorLiteral } from "./embeddings.js";

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}

describe("embeddings", () => {
  it("produces deterministic, L2-normalized 384-dim local embeddings", () => {
    const v1 = computeLocalEmbedding("Maya's university tuition $28,000 per year");
    const v2 = computeLocalEmbedding("Maya's university tuition $28,000 per year");
    expect(v1).toHaveLength(EMBEDDING_DIM);
    expect(v1).toEqual(v2);
    const norm = Math.sqrt(v1.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 3);
  });

  it("ranks semantically related advisor notes closer than unrelated notes", () => {
    const query = computeLocalEmbedding("daughter university tuition education funding");
    const chenNote = computeLocalEmbedding("Maya was accepted for engineering. Her daughter's tuition is $28,000/yr from RESP.");
    const unrelated = computeLocalEmbedding("Confirmed executor contact details with solicitor for estate beneficiary review.");
    expect(cosine(query, chenNote)).toBeGreaterThan(cosine(query, unrelated));
  });

  it("formats pgvector literals and validates dimension", () => {
    const vec = computeLocalEmbedding("test");
    const literal = toPgVectorLiteral(vec);
    expect(literal.startsWith("[")).toBe(true);
    expect(literal.endsWith("]")).toBe(true);
    expect(() => toPgVectorLiteral([1, 2, 3])).toThrow(/Expected 384-dim/);
  });

  it("calls external embeddings API when configured, and falls back locally otherwise", async () => {
    const local = await embedTexts(["hello"], { apiUrl: "", apiKey: "" });
    expect(local).toHaveLength(1);
    expect(local[0]).toHaveLength(EMBEDDING_DIM);

    const fakeVec = Array.from({ length: EMBEDDING_DIM }, (_, i) => (i === 0 ? 1 : 0));
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ index: 0, embedding: fakeVec }] }), { status: 200 }),
    );
    const remote = await embedTexts(["hello"], {
      apiUrl: "https://embeddings.example/v1/embeddings",
      apiKey: "secret-key",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(remote[0]).toEqual(fakeVec);
  });
});
