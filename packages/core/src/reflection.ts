import type { ChatMessage, ChatProvider } from "@openbot/gateway";
import type { Bot, MemoryType } from "@openbot/protocol";
import type { MemoryService } from "./memory";
import { normalizeSoul, renderSoul, type SoulService } from "./soul";
import type { Store } from "./store";

export const MEMORY_EXTRACTION_MARKER = "[memory extraction]";
export const SOUL_REFLECTION_MARKER = "[soul reflection]";

const DEBOUNCE_MS = 8_000;
const INTERVAL_MS = 10 * 60_000;
const MAX_TRANSCRIPT_CHARS = 8_000;
const MAX_MESSAGES = 30;
const MAX_EXTRACTED = 8;
const SOUL_EVERY = 3;
const MODEL_TIMEOUT_MS = 45_000;

const EXTRACTION_SYSTEM_PROMPT =
  `${MEMORY_EXTRACTION_MARKER}\n` +
  "You extract durable memories from a conversation between a user and their " +
  "assistant. Reply with ONLY a JSON array. Each item: " +
  '{"type":"semantic"|"relational"|"procedural"|"episodic","content":string,' +
  '"importance":0..1,"confidence":0..1}. ' +
  "semantic: durable facts about the user, their projects, tools, or " +
  "environment. relational: how the assistant should work with this user " +
  "(preferences, tone, corrections). procedural: reusable how-tos learned " +
  "from doing the work. episodic: notable events worth remembering later. " +
  "Write each memory as one self-contained sentence. Skip transient chatter " +
  "and one-off questions. Reply [] if nothing is durable.";

const SOUL_SYSTEM_PROMPT =
  `${SOUL_REFLECTION_MARKER}\n` +
  "You maintain the assistant's soul: a short constitution with voice, " +
  "commitments, and relationship. Given the current soul and recent durable " +
  "memories, reply with ONLY a JSON object: " +
  '{"voice":string,"commitments":string[],"relationship":string,"reason":string}. ' +
  "Keep it under 120 words total. Merge, sharpen, and prune: only change what " +
  "the memories justify, keep commitments that are still true, and drop ones " +
  "that are stale. Never add instructions about doing a project's work " +
  "directly.";

export interface ReflectionDeps {
  store: Store;
  memory: MemoryService;
  soul: SoulService;
  providers: Map<string, ChatProvider>;
}

export interface ReflectionResult {
  extracted: number;
  soulUpdated: boolean;
  archived: number;
  merged: number;
}

export class Reflector {
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private rerun = false;

  constructor(private readonly deps: ReflectionDeps) {}

  schedule(): void {
    if (this.debounce) {
      return;
    }
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.tick();
    }, DEBOUNCE_MS);
    this.debounce.unref?.();
  }

  start(): void {
    if (this.interval) {
      return;
    }
    this.interval = setInterval(() => {
      void this.tick();
    }, INTERVAL_MS);
    this.interval.unref?.();
  }

  stop(): void {
    if (this.debounce) {
      clearTimeout(this.debounce);
      this.debounce = null;
    }
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  async tick(): Promise<ReflectionResult> {
    if (this.running) {
      this.rerun = true;
      return { extracted: 0, soulUpdated: false, archived: 0, merged: 0 };
    }
    this.running = true;
    let extracted = 0;
    let soulUpdated = false;
    try {
      extracted = await this.extractAll();
      soulUpdated = await this.reflectSouls();
    } catch (error) {
      console.warn(`memory extraction failed: ${(error as Error).message}`);
    }
    let archived = 0;
    let merged = 0;
    try {
      const pruned = await this.deps.memory.decayAndPrune();
      archived = pruned.archived;
      merged = pruned.merged;
    } catch (error) {
      console.warn(`memory pruning failed: ${(error as Error).message}`);
    }
    this.running = false;
    if (this.rerun) {
      this.rerun = false;
      this.schedule();
    }
    return { extracted, soulUpdated, archived, merged };
  }

  private scopeBots(): Array<{ scope: string; bot: Bot }> {
    const bots = this.deps.store.listBots();
    // Every agent owns its own memory scope; there is no shared scope.
    return bots.map((bot) => ({ scope: bot.id, bot }));
  }

  private async extractAll(): Promise<number> {
    let total = 0;
    for (const { scope, bot } of this.scopeBots()) {
      try {
        total += await this.extractScope(scope, bot);
      } catch (error) {
        console.warn(
          `memory extraction failed for ${scope}: ${(error as Error).message}`,
        );
      }
    }
    return total;
  }

  private async extractScope(scope: string, bot: Bot): Promise<number> {
    const store = this.deps.store;
    const cursorKey = `memory.cursor.${scope}`;
    const cursor = store.getSetting(cursorKey);
    const thread = store.getOrCreateThread(bot.id);
    const all = store.listMessages(thread.id, { includeFolded: true });
    const fresh = all.filter(
      (message) =>
        !cursor || message.createdAt > cursor,
    );
    if (fresh.length === 0) {
      return 0;
    }
    const recent = fresh.slice(-MAX_MESSAGES);
    const transcript = recent
      .map((message) => `${message.role}: ${message.content}`)
      .join("\n")
      .slice(-MAX_TRANSCRIPT_CHARS);
    const raw = await this.complete(bot, EXTRACTION_SYSTEM_PROMPT, transcript);
    const candidates = this.parseMemories(raw);
    let added = 0;
    for (const candidate of candidates.slice(0, MAX_EXTRACTED)) {
      await this.deps.memory.remember({
        scope,
        type: candidate.type,
        content: candidate.content,
        importance: candidate.importance,
        confidence: candidate.confidence,
        source: "reflection",
      });
      added += 1;
    }
    const newest = recent[recent.length - 1]!;
    store.setSetting(cursorKey, newest.createdAt);
    if (added > 0) {
      const countKey = `memory.extractions.${scope}`;
      const count = Number(store.getSetting(countKey) ?? "0") + added;
      store.setSetting(countKey, String(count));
    }
    return added;
  }

  private async reflectSouls(): Promise<boolean> {
    const store = this.deps.store;
    let updated = false;
    for (const { scope, bot } of this.scopeBots()) {
      const count = Number(store.getSetting(`memory.extractions.${scope}`) ?? "0");
      const applied = Number(store.getSetting(`soul.applied.${scope}`) ?? "0");
      if (count < applied + SOUL_EVERY) {
        continue;
      }
      const current = this.deps.soul.current(bot.id);
      const memories = this.deps.memory
        .list({ scope, status: "active", limit: 15 })
        .map((memory) => `- (${memory.type}) ${memory.content}`)
        .join("\n");
      const prompt =
        `Current soul:\n${renderSoul(current.content)}\n\n` +
        `Recent durable memories:\n${memories || "(none)"}`;
      const raw = await this.complete(bot, SOUL_SYSTEM_PROMPT, prompt);
      const parsed = this.parseSoul(raw);
      if (!parsed) {
        continue;
      }
      this.deps.soul.apply(
        bot.id,
        {
          voice: parsed.voice ?? current.content.voice,
          commitments:
            parsed.commitments ?? current.content.commitments,
          relationship:
            parsed.relationship ?? current.content.relationship,
        },
        parsed.reason ?? "reflection",
        "reflection",
      );
      store.setSetting(`soul.applied.${scope}`, String(count));
      updated = true;
    }
    return updated;
  }

  private async complete(
    bot: Bot,
    system: string,
    user: string,
  ): Promise<string> {
    const provider = this.deps.providers.get(bot.model.provider);
    if (!provider) {
      throw new Error(`unknown provider: ${bot.model.provider}`);
    }
    const messages: ChatMessage[] = [
      { role: "system", content: system },
      { role: "user", content: user },
    ];
    let text = "";
    for await (const event of provider.chat({
      model: bot.model.model,
      messages,
      ...(bot.model.effort ? { reasoningEffort: bot.model.effort } : {}),
      signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    })) {
      if (event.type === "text_delta") {
        text += event.text;
      }
    }
    return text;
  }

  private parseMemories(raw: string): Array<{
    type: MemoryType;
    content: string;
    importance: number;
    confidence: number;
  }> {
    const start = raw.indexOf("[");
    const end = raw.lastIndexOf("]");
    if (start === -1 || end <= start) {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.slice(start, end + 1));
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) {
      return [];
    }
    const types = new Set<MemoryType>([
      "semantic",
      "relational",
      "procedural",
      "episodic",
    ]);
    const results: Array<{
      type: MemoryType;
      content: string;
      importance: number;
      confidence: number;
    }> = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const record = entry as Record<string, unknown>;
      const content =
        typeof record.content === "string" ? record.content.trim() : "";
      const type =
        typeof record.type === "string" &&
        types.has(record.type as MemoryType)
          ? (record.type as MemoryType)
          : "semantic";
      if (!content || content.length < 8) {
        continue;
      }
      const importance =
        typeof record.importance === "number"
          ? Math.min(1, Math.max(0, record.importance))
          : 0.5;
      const confidence =
        typeof record.confidence === "number"
          ? Math.min(1, Math.max(0, record.confidence))
          : 0.8;
      results.push({
        type,
        content: content.slice(0, 400),
        importance,
        confidence,
      });
    }
    return results;
  }

  private parseSoul(raw: string): {
    voice?: string;
    commitments?: string[];
    relationship?: string;
    reason?: string;
  } | null {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end <= start) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<
        string,
        unknown
      >;
      const normalized = normalizeSoul({
        voice: typeof parsed.voice === "string" ? parsed.voice : undefined,
        commitments: Array.isArray(parsed.commitments)
          ? (parsed.commitments.filter(
              (entry) => typeof entry === "string",
            ) as string[])
          : undefined,
        relationship:
          typeof parsed.relationship === "string"
            ? parsed.relationship
            : undefined,
      });
      return {
        voice: normalized.voice,
        commitments: normalized.commitments,
        relationship: normalized.relationship,
        reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
      };
    } catch {
      return null;
    }
  }
}
