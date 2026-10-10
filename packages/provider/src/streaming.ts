import type { ProviderStreamResult } from './provider.ts';
import { isEventStreamMediaType, type ProtocolFrame } from '@floway-dev/protocols/common';

export type ProviderStreamParser<TEvent> = (
  body: ReadableStream<Uint8Array>,
  options?: { signal?: AbortSignal },
) => AsyncIterable<ProtocolFrame<TEvent>>;

const BODY_SNIPPET_CHARS = 1024;

const readBodySnippet = async (response: Response): Promise<string> => {
  try {
    const text = await response.text();
    if (text.length === 0) return '<empty>';
    return text.length > BODY_SNIPPET_CHARS ? `${text.slice(0, BODY_SNIPPET_CHARS)}...[truncated]` : text;
  } catch {
    return '<unreadable>';
  }
};

// A 2xx non-SSE upstream is a provider-contract violation: every streaming
// endpoint is called with stream=true. The throw bubbles to the target
// boundary, which turns it into a 502. The upstream's body (or a snippet
// of it) is folded into the error message so what the upstream actually
// returned reaches the operator instead of being discarded — content-type
// "unknown" with no body context is otherwise impossible to debug.
export const streamingProviderCall = async <TEvent>(
  upstreamFetch: Promise<Response>,
  parser: ProviderStreamParser<TEvent>,
  modelKey: string,
  signal: AbortSignal | undefined,
): Promise<ProviderStreamResult<TEvent>> => {
  const response = await upstreamFetch;
  if (!response.ok) {
    return { ok: false, response, modelKey };
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!response.body || !isEventStreamMediaType(contentType)) {
    const snippet = await readBodySnippet(response);
    throw new Error(`Upstream returned ${response.status} with content-type "${contentType || 'unknown'}" but stream is required (provider must force stream=true and return text/event-stream when response.ok). Body: ${snippet}`);
  }
  return { ok: true, events: parser(response.body, { signal }), modelKey, headers: response.headers };
};
