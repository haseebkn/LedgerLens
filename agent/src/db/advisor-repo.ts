import type { Pool } from "pg";
import { withTenantContext, type TenantContext } from "./client.js";
import { embedTexts, toPgVectorLiteral } from "./embeddings.js";

/**
 * Tenant-scoped Postgres queries for advisor communications and CRM records.
 * Every query runs inside `withTenantContext`, so Postgres RLS guarantees an
 * advisor can never read or write another advisor's households.
 */

export interface NoteSearchHit {
  docId: string;
  kind: "meeting_note" | "email";
  householdId: string;
  householdName: string;
  date: string;
  title: string;
  snippet: string;
  rrfScore: number;
}

/**
 * Hybrid search across meeting_notes and emails using Reciprocal Rank Fusion
 * combining pgvector cosine distance (`<=>`) and Postgres full-text search
 * (`websearch_to_tsquery` + `ts_rank_cd`), strictly scoped by Postgres RLS.
 */
export async function searchAdvisorNotes(
  pool: Pool,
  ctx: TenantContext,
  params: { query: string; householdId?: string; limit?: number },
): Promise<NoteSearchHit[]> {
  const limit = Math.max(1, Math.min(20, params.limit ?? 8));
  const [queryVec] = await embedTexts([params.query]);
  const vecLiteral = toPgVectorLiteral(queryVec!);

  return withTenantContext(
    pool,
    ctx,
    async (client) => {
      const res = await client.query<{
        doc_id: string;
        kind: "meeting_note" | "email";
        household_id: string;
        household_name: string;
        doc_date: string;
        title: string;
        snippet: string;
        rrf_score: number;
      }>(
        `
        WITH docs AS (
          SELECT
            n.note_id AS doc_id,
            'meeting_note'::text AS kind,
            n.household_id,
            h.name AS household_name,
            n.meeting_date::text AS doc_date,
            n.title,
            LEFT(n.transcript, 500) AS snippet,
            n.search_tsv,
            n.embedding
          FROM meeting_notes n
          JOIN households h ON h.household_id = n.household_id
          WHERE ($2::text IS NULL OR n.household_id = $2)

          UNION ALL

          SELECT
            e.email_id AS doc_id,
            'email'::text AS kind,
            e.household_id,
            h.name AS household_name,
            e.sent_at::date::text AS doc_date,
            e.subject AS title,
            LEFT(e.body, 500) AS snippet,
            e.search_tsv,
            e.embedding
          FROM emails e
          JOIN households h ON h.household_id = e.household_id
          WHERE ($2::text IS NULL OR e.household_id = $2)
        ),
        vec_rank AS (
          SELECT
            doc_id,
            ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector ASC) AS r_vec,
            1 - (embedding <=> $1::vector) AS cosine_sim
          FROM docs
          ORDER BY embedding <=> $1::vector ASC
          LIMIT 40
        ),
        fts_rank AS (
          SELECT
            doc_id,
            ROW_NUMBER() OVER (ORDER BY ts_rank_cd(search_tsv, websearch_to_tsquery('english', $3)) DESC) AS r_fts
          FROM docs
          WHERE search_tsv @@ websearch_to_tsquery('english', $3)
          LIMIT 40
        )
        SELECT
          d.doc_id,
          d.kind,
          d.household_id,
          d.household_name,
          d.doc_date,
          d.title,
          d.snippet,
          (
            COALESCE(1.0 / (60.0 + f.r_fts), 0) * 2.0 +
            COALESCE(CASE WHEN v.cosine_sim > 0.15 THEN 1.0 / (60.0 + v.r_vec) ELSE 0 END, 0)
          )::double precision AS rrf_score
        FROM docs d
        LEFT JOIN vec_rank v ON v.doc_id = d.doc_id
        LEFT JOIN fts_rank f ON f.doc_id = d.doc_id
        WHERE f.doc_id IS NOT NULL OR (v.doc_id IS NOT NULL AND v.cosine_sim > 0.20)
        ORDER BY rrf_score DESC, d.doc_date DESC
        LIMIT $4
        `,
        [vecLiteral, params.householdId ?? null, params.query, limit],
      );

      return res.rows.map((r) => ({
        docId: r.doc_id,
        kind: r.kind,
        householdId: r.household_id,
        householdName: r.household_name,
        date: r.doc_date,
        title: r.title,
        snippet: r.snippet,
        rrfScore: Number(r.rrf_score),
      }));
    },
    { readOnly: true, statementTimeoutMs: 5_000, role: process.env.DB_APP_ROLE },
  );
}
