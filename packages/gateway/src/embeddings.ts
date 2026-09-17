export interface EmbeddingClient {
  model: string;
  embed(texts: string[]): Promise<number[][]>;
}

const HASH_DIMS = 256;

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1);
}

/**
 * Deterministic offline embeddings: hashed token buckets with sublinear
 * term weighting, L2-normalized. Not as good as a real embedding model, but
 * it keeps semantic-ish retrieval working with no provider configured and
 * makes the vector path testable offline.
 */
export function hashEmbedding(text: string, dims = HASH_DIMS): number[] {
  const vector = new Float64Array(dims);
  const counts = new Map<string, number>();
  for (const token of tokenize(text)) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  for (const [token, count] of counts) {
    const hash = fnv1a(token);
    const bucket = hash % dims;
    const sign = (hash >>> 16) % 2 === 0 ? 1 : -1;
    vector[bucket] = (vector[bucket] ?? 0) + sign * (1 + Math.log(count));
  }
  let norm = 0;
  for (let index = 0; index < dims; index += 1) {
    norm += vector[index]! * vector[index]!;
  }
  norm = Math.sqrt(norm) || 1;
  const result = new Array<number>(dims);
  for (let index = 0; index < dims; index += 1) {
    result[index] = vector[index]! / norm;
  }
  return result;
}

export function createHashEmbeddingClient(dims = HASH_DIMS): EmbeddingClient {
  return {
    model: `local-hash-${dims}`,
    async embed(texts) {
      return texts.map((text) => hashEmbedding(text, dims));
    },
  };
}

export function createOpenAIEmbeddingClient(options: {
  baseUrl: string;
  apiKey?: string;
  model: string;
  fetchImpl?: typeof fetch;
}): EmbeddingClient {
  const base = options.baseUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    model: options.model,
    async embed(texts) {
      const response = await fetchImpl(`${base}/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(options.apiKey
            ? { authorization: `Bearer ${options.apiKey}` }
            : {}),
        },
        body: JSON.stringify({ model: options.model, input: texts }),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `embeddings request failed (HTTP ${response.status}): ${body.slice(0, 200)}`,
        );
      }
      const payload = (await response.json()) as {
        data?: Array<{ embedding?: number[] }>;
      };
      const vectors = (payload.data ?? []).map((entry) => entry.embedding ?? []);
      if (vectors.length !== texts.length) {
        throw new Error(
          `embeddings response returned ${vectors.length} vectors for ${texts.length} inputs`,
        );
      }
      return vectors;
    },
  };
}

export function cosineSimilarity(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < length; index += 1) {
    dot += a[index]! * b[index]!;
    normA += a[index]! * a[index]!;
    normB += b[index]! * b[index]!;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
