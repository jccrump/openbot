import type { ReactElement } from "react";
import {
  siAnthropic,
  siClaude,
  siDeepseek,
  siGooglegemini,
  siLmstudio,
  siMeta,
  siMistralai,
  siOllama,
  siOpenrouter,
} from "simple-icons";
import grokSvg from "../assets/logos/grok.svg?raw";
import groqSvg from "../assets/logos/groq.svg?raw";
import openaiSvg from "../assets/logos/openai.svg?raw";

interface MarkProps {
  size?: number;
}

const BASE = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function PathMark({
  path,
  color,
  size = 20,
}: MarkProps & { path: string; color: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d={path} fill={color} />
    </svg>
  );
}

function RawMark({ svg, size = 20 }: MarkProps & { svg: string }) {
  const viewBox = svg.match(/viewBox="([^"]+)"/)?.[1] ?? "0 0 24 24";
  const body = svg
    .replace(/^[\s\S]*?<svg[^>]*>/, "")
    .replace(/<\/svg>\s*$/, "");
  return (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: body }}
    />
  );
}

function DeepSeekMark({ size = 20 }: MarkProps) {
  return <PathMark size={size} path={siDeepseek.path} color="#4D6BFE" />;
}

function OpenAIMark({ size = 20 }: MarkProps) {
  return <RawMark size={size} svg={openaiSvg} />;
}

function AnthropicMark({ size = 20 }: MarkProps) {
  return <PathMark size={size} path={siAnthropic.path} color="currentColor" />;
}

function ClaudeMark({ size = 20 }: MarkProps) {
  return <PathMark size={size} path={siClaude.path} color="#D97757" />;
}

function XaiMark({ size = 20 }: MarkProps) {
  return <RawMark size={size} svg={grokSvg} />;
}

function GroqMark({ size = 20 }: MarkProps) {
  return <RawMark size={size} svg={groqSvg} />;
}

function MistralMark({ size = 20 }: MarkProps) {
  return <PathMark size={size} path={siMistralai.path} color="#FA520F" />;
}

function MetaMark({ size = 20 }: MarkProps) {
  return <PathMark size={size} path={siMeta.path} color="#0866FF" />;
}

function GeminiMark({ size = 20 }: MarkProps) {
  return <PathMark size={size} path={siGooglegemini.path} color="#8E75B2" />;
}

function LmStudioMark({ size = 20 }: MarkProps) {
  return <PathMark size={size} path={siLmstudio.path} color="currentColor" />;
}

function OllamaMark({ size = 20 }: MarkProps) {
  return <PathMark size={size} path={siOllama.path} color="currentColor" />;
}

function OpenRouterMark({ size = 20 }: MarkProps) {
  return <PathMark size={size} path={siOpenrouter.path} color="currentColor" />;
}

function CubeMark({ size = 20 }: MarkProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...BASE} aria-hidden="true">
      <path d="M12 3 20 7.4v9.2L12 21l-8-4.4V7.4z" />
      <path d="M12 12 20 7.4M12 12v9M12 12 4 7.4" />
    </svg>
  );
}

function OpenBotMark({ size = 20 }: MarkProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...BASE} aria-hidden="true">
      <rect x="4.2" y="7.4" width="15.6" height="12" rx="3.6" />
      <path d="M12 7.4V4.2" />
      <circle cx="12" cy="3.4" r="1" fill="currentColor" stroke="none" />
      <circle cx="9.4" cy="13.2" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="14.6" cy="13.2" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

const PROVIDER_MARKS: Array<{
  keys: string[];
  Mark: (props: MarkProps) => ReactElement;
}> = [
  { keys: ["deepseek"], Mark: DeepSeekMark },
  { keys: ["openai", "chatgpt", "codex", "gpt"], Mark: OpenAIMark },
  { keys: ["anthropic"], Mark: AnthropicMark },
  { keys: ["claude"], Mark: ClaudeMark },
  { keys: ["xai", "grok"], Mark: XaiMark },
  { keys: ["groq"], Mark: GroqMark },
  { keys: ["mistral"], Mark: MistralMark },
  { keys: ["google", "gemini"], Mark: GeminiMark },
  { keys: ["ollama"], Mark: OllamaMark },
  { keys: ["meta", "llama"], Mark: MetaMark },
  { keys: ["lmstudio", "lm-studio", "lm studio"], Mark: LmStudioMark },
  { keys: ["openrouter"], Mark: OpenRouterMark },
];

function matches(keys: string[], id?: string, label?: string): boolean {
  const haystack = `${id ?? ""} ${label ?? ""}`.toLowerCase();
  return keys.some((key) => haystack.includes(key));
}

export function ProviderLogo({
  id,
  label,
  size = 20,
}: MarkProps & { id?: string; label?: string }) {
  for (const { keys, Mark } of PROVIDER_MARKS) {
    if (matches(keys, id, label)) {
      return <Mark size={size} />;
    }
  }
  return <CubeMark size={size} />;
}

export function HarnessLogo({
  id,
  size = 20,
}: MarkProps & { id: string }) {
  if (id === "codex") {
    return <OpenAIMark size={size} />;
  }
  if (id === "openbot") {
    return <OpenBotMark size={size} />;
  }
  return <CubeMark size={size} />;
}
