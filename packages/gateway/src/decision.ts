import {
  TypeSafeClient,
  type ChoiceCriteria,
  type ChoiceResponse,
  type EntryType,
  type NoulQuestion,
  type NoulResponse,
  type Question,
  type Questions,
  type ResultFor,
  type ScoreCriteria,
  type ScoreResponse,
  choice,
  noul,
  score,
} from "@typesafe-ai/sdk";

export {
  choice,
  noul,
  score,
  type ChoiceCriteria,
  type ChoiceResponse,
  type EntryType,
  type NoulQuestion,
  type NoulResponse,
  type Question,
  type Questions,
  type ResultFor,
  type ScoreCriteria,
  type ScoreResponse,
};

export interface DecisionClientOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface DecisionRequest<Q extends Questions> {
  state: EntryType;
  questions: Q;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface DecisionResult<Q extends Questions> {
  answers: { [K in keyof Q]: ResultFor<Q[K]> };
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface DecisionClient {
  evaluate<Q extends Questions>(
    request: DecisionRequest<Q>,
  ): Promise<DecisionResult<Q>>;
}

export function createDecisionClient(
  options: DecisionClientOptions,
): DecisionClient {
  const client = new TypeSafeClient({
    apiKey: options.apiKey,
    ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
    ...(options.model ? { defaultModel: options.model } : {}),
    timeout: options.timeoutMs ?? 5_000,
    retry: { maxRetries: options.maxRetries ?? 1 },
    logLevel: "off",
  });

  return {
    async evaluate<Q extends Questions>(
      request: DecisionRequest<Q>,
    ): Promise<DecisionResult<Q>> {
      const result = await client.systemOne(
        { state: request.state, questions: request.questions },
        {
          ...(request.signal ? { signal: request.signal } : {}),
          ...(request.timeoutMs ? { timeout: request.timeoutMs } : {}),
        },
      );
      return {
        answers: result.answers,
        model: result.model,
        usage: {
          inputTokens: result.usage.input_tokens,
          outputTokens: result.usage.output_tokens,
        },
      };
    },
  };
}
