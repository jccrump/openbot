import { cosineSimilarity, type EmbeddingClient } from "@openbot/gateway";
import type { MemoryStatus, MemoryType } from "@openbot/protocol";
import type { MemoryRecord, Store } from "./store";

export interface MemoryHit {
  memory: MemoryRecord;
  score: number;
}

const DECAY_HALF_LIFE_DAYS = 45;
const ARCHIVE_THRESHOLD = 0.1;
const MERGE_SIMILARITY = 0.92;
const DEDUPE_SIMILARITY = 0.86;
const CANDIDATE_LIMIT = 500;

function mergeEvidence(
  existing: string[] | null | undefined,
  incoming: string[] | null | undefined,
): string[] | null {
  const merged = [...(existing ?? []), ...(incoming ?? [])];
  if (merged.length === 0) {
    return null;
  }
  return [...new Set(merged)].slice(0, 12);
}

function ageDays(from: string): number {
  const ms = Date.now() - Date.parse(from);
  return Number.isFinite(ms) ? Math.max(0, ms / 86_400_000) : 0;
}

export class MemoryService {
  constructor(
    private readonly store: Store,
    // Resolved per call so changing the embedding provider takes effect
    // without restarting the daemon.
    private readonly embeddings: () => EmbeddingClient,
  ) {}

  async remember(input: {
    scope: string;
    type: MemoryType;
    content: string;
    evidence?: string[] | null;
    confidence?: number;
    importance?: number;
    source: string;
  }): Promise<MemoryRecord> {
    const content = input.content.trim();
    const embedding = await this.embed(content);
    const similar = embedding
      ? this.findSimilar(input.scope, embedding, DEDUPE_SIMILARITY)
      : null;
    if (similar) {
      // Fold a near-identical memory into the existing one instead of
      // duplicating it, keeping the richer text and the stronger scores.
      const updated = this.store.updateMemory(similar.id, {
        content:
          content.length > similar.content.length ? content : similar.content,
        confidence: Math.max(similar.confidence, input.confidence ?? 0.8),
        importance: Math.max(similar.importance, input.importance ?? 0.5),
        status: "active",
        evidence: mergeEvidence(similar.evidence, input.evidence),
        embedding,
        embeddingModel: this.embeddings().model,
        updatedAt: new Date().toISOString(),
      });
      return updated ?? similar;
    }
    return this.store.createMemory({
      scope: input.scope,
      type: input.type,
      content,
      evidence: input.evidence ?? null,
      confidence: input.confidence ?? 0.8,
      importance: input.importance ?? 0.5,
      source: input.source,
      embedding,
      embeddingModel: this.embeddings().model,
    });
  }

  async recall(
    query: string,
    options: {
      scopes: string[];
      limit?: number;
      types?: MemoryType[];
    },
  ): Promise<MemoryHit[]> {
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }
    const scopeSet = new Set(options.scopes);
    const candidates = this.store
      .listMemories({ status: "active", limit: CANDIDATE_LIMIT })
      .filter((memory) => scopeSet.has(memory.scope));
    if (candidates.length === 0) {
      return [];
    }
    const byId = new Map(candidates.map((memory) => [memory.id, memory]));
    const keywordScores = new Map<string, number>();
    for (const scope of scopeSet) {
      for (const hit of this.store.searchMemoriesFts(trimmed, {
        scope,
        status: "active",
        limit: 40,
      })) {
        keywordScores.set(hit.id, Math.max(keywordScores.get(hit.id) ?? 0, hit.score));
      }
    }
    const maxKeyword = Math.max(1, ...keywordScores.values());

    const queryEmbedding = await this.embed(trimmed);
    const scored: MemoryHit[] = [];
    for (const memory of candidates) {
      if (options.types && !options.types.includes(memory.type)) {
        continue;
      }
      const keyword = (keywordScores.get(memory.id) ?? 0) / maxKeyword;
      const vector =
        queryEmbedding && memory.embedding
          ? Math.max(0, cosineSimilarity(queryEmbedding, memory.embedding))
          : 0;
      const relevance =
        queryEmbedding && memory.embedding
          ? 0.65 * vector + 0.35 * keyword
          : keyword;
      if (relevance <= 0) {
        continue;
      }
      const reference = memory.lastUsedAt ?? memory.updatedAt;
      const recency = Math.exp(-ageDays(reference) / 120);
      const score =
        relevance *
        (0.55 + 0.45 * memory.importance) *
        (0.6 + 0.4 * memory.confidence) *
        (0.7 + 0.3 * recency);
      scored.push({ memory, score });
    }
    scored.sort((a, b) => b.score - a.score);
    const limit = options.limit ?? 8;
    const hits = scored.slice(0, limit);
    this.store.touchMemories(hits.map((hit) => hit.memory.id));
    return hits;
  }

  list(options: {
    scope?: string;
    status?: MemoryStatus;
    limit?: number;
  }): MemoryRecord[] {
    return this.store.listMemories(options);
  }

  forget(id: string): boolean {
    return Boolean(
      this.store.updateMemory(id, {
        status: "archived",
        updatedAt: new Date().toISOString(),
      }),
    );
  }

  /**
   * Automatic upkeep: decay unused memories toward the archive threshold and
   * merge near-duplicates. Runs in the background, so failures are harmless.
   */
  async decayAndPrune(): Promise<{ archived: number; merged: number }> {
    const active = this.store.listMemories({
      status: "active",
      limit: CANDIDATE_LIMIT,
    });
    let archived = 0;
    let merged = 0;
    const survivors: MemoryRecord[] = [];
    for (const memory of active) {
      const reference = memory.lastUsedAt ?? memory.updatedAt;
      const decayed =
        memory.importance *
        memory.confidence *
        Math.exp(-ageDays(reference) / DECAY_HALF_LIFE_DAYS);
      if (decayed < ARCHIVE_THRESHOLD && memory.useCount < 2) {
        this.store.updateMemory(memory.id, { status: "archived" });
        archived += 1;
        continue;
      }
      survivors.push(memory);
    }

    // Merge near-duplicates within a scope, keeping the newer, stronger one.
    const archivedIds = new Set<string>();
    for (let left = 0; left < survivors.length; left += 1) {
      const a = survivors[left]!;
      if (archivedIds.has(a.id) || !a.embedding) {
        continue;
      }
      for (let right = left + 1; right < survivors.length; right += 1) {
        const b = survivors[right]!;
        if (archivedIds.has(b.id) || !b.embedding || a.scope !== b.scope) {
          continue;
        }
        const similarity = cosineSimilarity(a.embedding, b.embedding);
        if (similarity < MERGE_SIMILARITY) {
          continue;
        }
        const [keep, drop] =
          b.importance > a.importance ||
          (b.importance === a.importance && b.updatedAt > a.updatedAt)
            ? [b, a]
            : [a, b];
        const updated = this.store.updateMemory(keep.id, {
          content:
            drop.content.length > keep.content.length
              ? drop.content
              : keep.content,
          confidence: Math.max(keep.confidence, drop.confidence),
          importance: Math.max(keep.importance, drop.importance),
          evidence: mergeEvidence(keep.evidence, drop.evidence),
          updatedAt: new Date().toISOString(),
        });
        if (updated) {
          this.store.updateMemory(drop.id, { status: "archived" });
          archivedIds.add(drop.id);
          merged += 1;
        }
      }
    }
    return { archived, merged };
  }

  private findSimilar(
    scope: string,
    embedding: Float32Array,
    threshold: number,
  ): MemoryRecord | null {
    let best: MemoryRecord | null = null;
    let bestScore = threshold;
    for (const memory of this.store.listMemories({
      scope,
      status: "active",
      limit: CANDIDATE_LIMIT,
    })) {
      if (!memory.embedding) {
        continue;
      }
      const score = cosineSimilarity(embedding, memory.embedding);
      if (score >= bestScore) {
        best = memory;
        bestScore = score;
      }
    }
    return best;
  }

  private async embed(text: string): Promise<Float32Array | null> {
    try {
      const [vector] = await this.embeddings().embed([text]);
      return vector && vector.length > 0 ? new Float32Array(vector) : null;
    } catch (error) {
      console.warn(`memory embedding failed: ${(error as Error).message}`);
      return null;
    }
  }
}
