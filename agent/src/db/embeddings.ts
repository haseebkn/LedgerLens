import { createHash } from "node:crypto";

/**
 * 384-dimensional embeddings for pgvector hybrid search.
 *
 * - When EMBEDDING_API_URL + EMBEDDING_API_KEY are configured (OpenAI/Voyage
 *   compatible `/embeddings` endpoint), calls that API.
 * - Otherwise produces a deterministic, L2-normalized 384-dim hashed-feature +
 *   wealth-domain-synonym vector locally with zero external API keys, paired
 *   with Postgres tsvector full-text ranking via Reciprocal Rank Fusion (RRF).
 *   This keeps `make demo` and CI runnable with only ANTHROPIC_API_KEY.
 */

export const EMBEDDING_DIM = 384;

const DOMAIN_CLUSTERS: readonly (readonly string[])[] = [
  ["tuition", "university", "college", "education", "resp", "school", "daughter", "son", "degree"],
  ["address", "moved", "move", "relocated", "mailing", "street", "water", "duckworth", "residence"],
  ["retirement", "pension", "rrsp", "rrif", "horizon", "drawdown", "income"],
  ["tax", "harvesting", "capital", "gains", "tfsa", "slip", "accountant"],
  ["estate", "beneficiary", "successor", "executor", "solicitor", "trust", "will"],
  ["liquidity", "cash", "renovation", "buffer", "treasury", "wire", "proceeds", "property"],
  ["rebalance", "allocation", "drift", "target", "concentration", "overweight", "equity", "bonds"],
  ["msft", "microsoft", "aapl", "apple", "nvda", "vti", "bnd", "agg", "sgov", "xeqt"],
  ["dividend", "distribution", "yield", "interest"],
  ["review", "meeting", "quarterly", "annual", "checkin", "portfolio"],
];

const CLUSTER_EXPANSION = new Map<string, readonly string[]>();
for (const cluster of DOMAIN_CLUSTERS) {
  for (const term of cluster) CLUSTER_EXPANSION.set(term, cluster);
}

function stemTerm(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith("ing") && word.length > 5) return word.slice(0, -3);
  if (word.endsWith("ed") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 3) return word.slice(0, -1);
  return word;
}

function addFeature(vec: Float64Array, feature: string, weight: number): void {
  const digest = createHash("sha256").update(feature).digest();
  const idx = digest.readUInt32BE(0) % EMBEDDING_DIM;
  const sign = (digest[4]! & 1) === 0 ? 1 : -1;
  vec[idx] = (vec[idx] ?? 0) + sign * weight;
}

/** Deterministic local 384-dim L2-normalized embedding (zero external dependencies). */
export function computeLocalEmbedding(text: string): number[] {
  const vec = new Float64Array(EMBEDDING_DIM);
  const rawTokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const tokens = rawTokens.map(stemTerm);

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    addFeature(vec, `t:${tok}`, 1.0);
    // Character 3-grams improve recall on typos and inflections.
    if (tok.length >= 4) {
      for (let j = 0; j <= tok.length - 3; j++) {
        addFeature(vec, `g:${tok.slice(j, j + 3)}`, 0.25);
      }
    }
    // Bigrams capture multi-word phrases like "daughter tuition" or "water st".
    if (i + 1 < tokens.length) {
      addFeature(vec, `b:${tok}_${tokens[i + 1]!}`, 0.6);
    }
    // Domain synonym cluster projection at lower weight.
    const raw = rawTokens[i]!;
    const peers = CLUSTER_EXPANSION.get(raw) ?? CLUSTER_EXPANSION.get(tok);
    if (peers) {
      for (const peer of peers) addFeature(vec, `c:${peer}`, 0.35);
    }
  }

  let normSq = 0;
  for (let i = 0; i < EMBEDDING_DIM; i++) normSq += vec[i]! * vec[i]!;
  const norm = Math.sqrt(normSq);
  if (norm === 0) {
    vec[0] = 1;
    return Array.from(vec);
  }
  return Array.from(vec, (v) => Math.round((v / norm) * 1e6) / 1e6);
}

/** Formats a numeric vector as a pgvector literal `[v1,v2,...]`. */
export function toPgVectorLiteral(embedding: readonly number[]): string {
  if (embedding.length !== EMBEDDING_DIM) {
    throw new Error(`Expected ${EMBEDDING_DIM}-dim embedding, got ${embedding.length}`);
  }
  return `[${embedding.join(",")}]`;
}

export interface EmbeddingProviderOptions {
  apiUrl?: string;
  apiKey?: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

/** Computes 384-dim embeddings via an external API when configured, else locally. */
export async function embedTexts(texts: string[], options?: EmbeddingProviderOptions): Promise<number[][]> {
  if (texts.length === 0) return [];
  const apiUrl = options?.apiUrl ?? process.env.EMBEDDING_API_URL?.trim();
  const apiKey = options?.apiKey ?? process.env.EMBEDDING_API_KEY?.trim();

  if (!apiUrl || !apiKey) {
    return texts.map(computeLocalEmbedding);
  }

  const response = await (options?.fetchImpl ?? fetch)(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      input: texts,
      model: options?.model ?? process.env.EMBEDDING_MODEL ?? "text-embedding-3-small",
      dimensions: EMBEDDING_DIM,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Embedding API returned ${response.status}: ${await response.text().catch(() => "")}`);
  }

  const json = (await response.json()) as { data?: { embedding: number[]; index?: number }[] };
  if (!Array.isArray(json.data) || json.data.length !== texts.length) {
    throw new Error("Embedding API returned an unexpected payload shape");
  }
  const ordered = [...json.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return ordered.map((item) => item.embedding);
}
