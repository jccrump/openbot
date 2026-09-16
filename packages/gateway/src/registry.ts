import { createOpenAICompatibleProvider } from "./openai-compatible";
import type { ChatProvider, ProviderDefinition } from "./types";

export function createProviders(
  definitions: ProviderDefinition[],
  env: Record<string, string | undefined> = process.env,
): Map<string, ChatProvider> {
  const providers = new Map<string, ChatProvider>();
  for (const definition of definitions) {
    const apiKey =
      definition.apiKey ??
      (definition.apiKeyEnv ? env[definition.apiKeyEnv] : undefined);
    providers.set(
      definition.id,
      createOpenAICompatibleProvider({
        id: definition.id,
        label: definition.label,
        baseUrl: definition.baseUrl,
        apiKey,
        models: definition.models,
      }),
    );
  }
  return providers;
}
