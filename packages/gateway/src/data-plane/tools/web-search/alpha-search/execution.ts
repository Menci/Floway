import type { AlphaSearchDispatcher } from './upstream.ts';
import type { WebSearchCallIR } from '../operations.ts';
import type { ResponsesInputItem, ResponsesWebSearchAction } from '@floway-dev/protocols/responses';

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
  const body = parsed as { output: string };
  return {
    action,
    // Alpha results are opaque UI metadata (`ref_id`, `domain`, optional
    // thumbnail) and live responses do not include the hosted-search
    // `snippet` field. The model-facing output is the only lossless bridge;
    // this explicitly synthetic entry serves Responses clients that request
    // `web_search_call.results` without pretending alpha DTOs were preserved.
    results: body.output === ''
      ? []
      : [{ type: 'text_result', url: '', title: 'OpenAI search output', snippet: body.output }],
    outputText: body.output,
  };
};
