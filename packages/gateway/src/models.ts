export interface FetchModelsOptions {
  baseUrl: string;
  apiKey?: string | null;
  fetchImpl?: typeof fetch;
}

export async function fetchModels(
  options: FetchModelsOptions,
): Promise<string[]> {
  const url = `${options.baseUrl.replace(/\/+$/, "")}/models`;
  const response = await (options.fetchImpl ?? fetch)(url, {
    headers: options.apiKey
      ? { authorization: `Bearer ${options.apiKey}` }
      : {},
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}: ${body.slice(0, 300)}`);
  }
  const payload = (await response.json()) as {
    data?: Array<{ id?: string }>;
  };
  return (payload.data ?? [])
    .map((entry) => entry.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .sort((a, b) => a.localeCompare(b));
}
