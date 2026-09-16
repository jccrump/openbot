import {
  createOpenAICompatibleProvider,
  type ChatProvider,
} from "@openbot/gateway";
import type { ProviderInfo } from "@openbot/protocol";
import type { ProviderRecord } from "./store";

export class ProviderRegistry {
  readonly map = new Map<string, ChatProvider>();
  private records: ProviderRecord[] = [];

  constructor(
    private readonly env: Record<string, string | undefined> = process.env,
  ) {}

  reload(records: ProviderRecord[]): void {
    this.records = records;
    this.map.clear();
    for (const record of records) {
      if (!record.enabled) {
        continue;
      }
      this.map.set(
        record.id,
        createOpenAICompatibleProvider({
          id: record.id,
          label: record.label,
          baseUrl: record.baseUrl,
          apiKey: this.resolveKey(record),
          models: record.models,
        }),
      );
    }
  }

  list(): ProviderRecord[] {
    return this.records;
  }

  infos(): ProviderInfo[] {
    return this.records.map((record) => ({
      id: record.id,
      label: record.label,
      baseUrl: record.baseUrl,
      models: record.models,
      hasApiKey: Boolean(this.resolveKey(record)),
      apiKeyEnv: record.apiKeyEnv,
      enabled: record.enabled,
    }));
  }

  resolveKey(record: ProviderRecord): string | undefined {
    if (record.apiKey) {
      return record.apiKey;
    }
    if (record.apiKeyEnv) {
      return this.env[record.apiKeyEnv];
    }
    return undefined;
  }
}
