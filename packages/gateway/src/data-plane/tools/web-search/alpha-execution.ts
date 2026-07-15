import type { AlphaSearchDispatcher } from './alpha-upstream.ts';
import type { WebSearchCallIR } from './operations.ts';
import type { ResponsesInputItem, ResponsesWebSearchAction, ResponsesWebSearchResult } from '@floway-dev/protocols/responses';

const structuredResults = (value: unknown): ResponsesWebSearchResult[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap(entry => {
    if (entry === null || typeof entry !== 'object') return [];
    const result = entry as Record<string, unknown>;
    if (result.type !== 'text_result' || typeof result.url !== 'string' || typeof result.title !== 'string' || typeof result.snippet !== 'string') {
      return [];
    }
    return [{ ...result, type: 'text_result', url: result.url, title: result.title, snippet: result.snippet } as ResponsesWebSearchResult];
  });
};

export const executeAlphaSearch = async ({
  dispatcher,
  sessionId,
  commands,
  settings,
  input,
  action,
  signal,
}: {
  dispatcher: AlphaSearchDispatcher;
  sessionId: string;
  commands: Record<string, unknown>;
  settings: Record<string, unknown>;
  input: ResponsesInputItem[];
  action: ResponsesWebSearchAction;
  signal: AbortSignal | undefined;
}): Promise<WebSearchCallIR> => {
  const response = await dispatcher({
    id: sessionId,
    input,
    commands,
    settings,
  }, signal, new Headers());
  const raw = await response.text();
  if (!response.ok) throw new Error(`OpenAI search upstream returned HTTP ${response.status}: ${raw.slice(0, 512)}`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('OpenAI search upstream returned a non-JSON success body');
  }
  if (parsed === null || typeof parsed !== 'object' || typeof (parsed as { output?: unknown }).output !== 'string') {
    throw new Error('OpenAI search upstream response must include an output string');
  }
  const body = parsed as { output: string; results?: unknown };
  const results = structuredResults(body.results);
  return {
    action,
    results: results.length > 0 || body.output === ''
      ? results
      : [{ type: 'text_result', url: '', title: 'OpenAI search', snippet: body.output }],
    outputText: body.output,
  };
};
