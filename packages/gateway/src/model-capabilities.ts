export interface ModelCapabilities {
  vision: boolean;
  contextWindow: number | null;
}

interface CapabilityRule {
  pattern: RegExp;
  vision?: boolean;
  contextWindow?: number;
}

// First match wins. Model ids may carry provider prefixes (for example
// "deepseek/deepseek-v4-flash" from OpenRouter) and local tags ("llava:13b"),
// so family patterns match anywhere in the id. Unknown models stay text-only:
// sending images to a model that rejects them fails the whole request.
const CAPABILITY_RULES: CapabilityRule[] = [
  // DeepSeek. deepseek-flash accepts images in user messages; the retired
  // deepseek-v4-flash-vision-exp is served by the latest Flash model.
  { pattern: /(^|\/)deepseek-flash/, vision: true, contextWindow: 128_000 },
  { pattern: /(^|\/)deepseek-v4-flash/, vision: true, contextWindow: 128_000 },
  { pattern: /(^|\/)deepseek-vl/, vision: true, contextWindow: 128_000 },
  { pattern: /(^|\/)deepseek-v4-pro/, vision: false, contextWindow: 128_000 },
  { pattern: /(^|\/)deepseek-(chat|reasoner|coder)/, vision: false, contextWindow: 128_000 },

  // OpenAI.
  { pattern: /^gpt-4o/, vision: true, contextWindow: 128_000 },
  { pattern: /^gpt-4\.1/, vision: true, contextWindow: 1_000_000 },
  { pattern: /^gpt-4-turbo/, vision: true, contextWindow: 128_000 },
  { pattern: /^gpt-5/, vision: true, contextWindow: 400_000 },
  { pattern: /^o[3-9]/, vision: true, contextWindow: 200_000 },

  // Anthropic (usually through OpenRouter or another router).
  { pattern: /(^|\/)claude-(3|4|5)/, vision: true, contextWindow: 200_000 },
  { pattern: /(^|\/)claude-(opus|sonnet|haiku)/, vision: true, contextWindow: 200_000 },

  // Google.
  { pattern: /(^|\/)gemini-/, vision: true, contextWindow: 1_000_000 },

  // xAI. Only the vision-branded Grok models accept images.
  { pattern: /grok-.*vision/, vision: true, contextWindow: 128_000 },

  // Qwen and other open-weight vision families, commonly served locally.
  { pattern: /qwen[\w.-]*vl/, vision: true, contextWindow: 128_000 },
  { pattern: /llava|bakllava|moondream|minicpm-v|internvl|yi-vl|glm-4v|pixtral/, vision: true, contextWindow: 128_000 },
  { pattern: /mistral-small-3/, vision: true, contextWindow: 128_000 },
  { pattern: /llama-?4/, vision: true, contextWindow: 128_000 },
  { pattern: /gemma-?3/, vision: true, contextWindow: 128_000 },
  { pattern: /phi-?4-multimodal/, vision: true, contextWindow: 128_000 },
];

export function modelCapabilities(model: string): ModelCapabilities {
  const id = model.trim().toLowerCase();
  for (const rule of CAPABILITY_RULES) {
    if (rule.pattern.test(id)) {
      return {
        vision: rule.vision ?? false,
        contextWindow: rule.contextWindow ?? null,
      };
    }
  }
  return { vision: false, contextWindow: null };
}

export function modelSupportsImages(model: string): boolean {
  return modelCapabilities(model).vision;
}

export function modelContextWindow(model: string): number | null {
  return modelCapabilities(model).contextWindow;
}
