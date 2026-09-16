import type { ProviderDefinition, ProviderPreset } from "./types";

export const PROVIDER_PRESETS = {
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    kind: "openai-compatible",
    baseUrl: "https://api.deepseek.com",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    models: ["deepseek-v4-flash"],
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    kind: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    models: [],
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    kind: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    models: ["deepseek/deepseek-v4-flash"],
  },
  groq: {
    id: "groq",
    label: "Groq",
    kind: "openai-compatible",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKeyEnv: "GROQ_API_KEY",
    models: [],
  },
  xai: {
    id: "xai",
    label: "xAI (Grok)",
    kind: "openai-compatible",
    baseUrl: "https://api.x.ai/v1",
    apiKeyEnv: "XAI_API_KEY",
    models: [],
  },
  google: {
    id: "google",
    label: "Google Gemini",
    kind: "openai-compatible",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKeyEnv: "GEMINI_API_KEY",
    models: [],
  },
  mistral: {
    id: "mistral",
    label: "Mistral",
    kind: "openai-compatible",
    baseUrl: "https://api.mistral.ai/v1",
    apiKeyEnv: "MISTRAL_API_KEY",
    models: [],
  },
  ollama: {
    id: "ollama",
    label: "Ollama (local)",
    kind: "openai-compatible",
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKeyEnv: null,
    models: [],
  },
  lmstudio: {
    id: "lmstudio",
    label: "LM Studio (local)",
    kind: "openai-compatible",
    baseUrl: "http://127.0.0.1:1234/v1",
    apiKeyEnv: null,
    models: [],
  },
} satisfies Record<string, ProviderDefinition>;

export function providerPresetList(): ProviderPreset[] {
  return Object.values(PROVIDER_PRESETS).map((preset) => ({
    id: preset.id,
    label: preset.label,
    baseUrl: preset.baseUrl,
    apiKeyEnv: preset.apiKeyEnv ?? null,
    models: preset.models,
  }));
}
