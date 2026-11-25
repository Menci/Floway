import { type WebSearchCallIR, UNSUPPORTED_LOCAL_WEB_SEARCH_FEATURE_ERROR_NAME, unsupportedLocalWebSearchFeatureIr } from '../operations.ts';
import type { OpenAIResponsesWebSearchAction } from '@floway-dev/protocols/openai-responses';

interface UpstreamErrorDetails {
  message: string;
  name?: string;
}

const upstreamErrorDetails = (body: unknown): UpstreamErrorDetails | undefined => {
  if (body === null || typeof body !== 'object') return undefined;
  const error = 'error' in body ? body.error : body;
  if (error === null || typeof error !== 'object') return undefined;
  const { message, name } = error as { message?: unknown; name?: unknown };
  if (typeof message !== 'string') return undefined;
  return {
    message,
    ...(typeof name === 'string' ? { name } : {}),
  };
};

export const alphaSearchResultToWebSearchCall = (body: unknown, status: number, action: OpenAIResponsesWebSearchAction): WebSearchCallIR => {
  if (status < 200 || status >= 300) {
    const upstreamError = upstreamErrorDetails(body);
    if (upstreamError?.name === UNSUPPORTED_LOCAL_WEB_SEARCH_FEATURE_ERROR_NAME) {
      return unsupportedLocalWebSearchFeatureIr(action, upstreamError.message);
    }
    throw new Error(upstreamError?.message ?? `OpenAI search upstream returned HTTP ${status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  }
  if (body === null || typeof body !== 'object' || !('output' in body) || typeof body.output !== 'string') {
    throw new Error('OpenAI search upstream response must include an output string');
  }
  const { output } = body;
  return {
    action,
    // Alpha results are opaque UI metadata (`ref_id`, `domain`, optional
    // thumbnail) and live responses do not include the hosted-search
    // `snippet` field. The model-facing output is the only lossless bridge;
    // this explicitly synthetic entry serves OpenAI Responses clients that request
    // `web_search_call.results` without pretending alpha DTOs were preserved.
    results: output === ''
      ? []
      : [{ type: 'text_result', url: '', title: 'OpenAI search output', snippet: output }],
    outputText: output,
  };
};
