import { alphaSearchIngress } from '../../../alpha-search/pipeline.ts';
import type { GatewayHttpFacts } from '../../../pipeline/host.ts';
import { httpSucceeded, readHttpBytes } from '../../../pipeline/non-chat.ts';
import type { GatewayServices } from '../../../pipeline/services.ts';
import { type WebSearchCallIR, UNSUPPORTED_LOCAL_WEB_SEARCH_FEATURE_ERROR_NAME, unsupportedLocalWebSearchFeatureIr } from '../operations.ts';
import { Bytes, type StageEnv } from '@floway-dev/pipeline';
import type { CanonicalOpenAIResponsesInputItem, OpenAIResponsesWebSearchAction } from '@floway-dev/protocols/openai-responses';

interface UpstreamErrorDetails {
  message: string;
  name?: string;
}

const upstreamErrorDetails = (raw: string): UpstreamErrorDetails | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const error = (parsed as { error?: unknown }).error;
  if (error === null || typeof error !== 'object') return undefined;
  const { message, name } = error as { message?: unknown; name?: unknown };
  if (typeof message !== 'string') return undefined;
  return {
    message,
    ...(typeof name === 'string' ? { name } : {}),
  };
};

export const executeAlphaSearchSubRun = async (
  env: StageEnv<GatewayServices>, facts: GatewayHttpFacts, args: {
    sessionId: string;
    commands: Record<string, unknown>;
    settings: Record<string, unknown>;
    input: CanonicalOpenAIResponsesInputItem[];
    action: OpenAIResponsesWebSearchAction;
  },
): Promise<WebSearchCallIR> => {
  const { sessionId, commands, settings, input, action } = args;
  const run = env.run(alphaSearchIngress, {
    'request.auth.apiKeyId': facts['request.auth.apiKeyId'],
    'request.auth.user': facts['request.auth.user'],
    'request.route.upstreamIds': facts['request.route.upstreamIds'],
    'request.route.randomizeUpstreams': facts['request.route.randomizeUpstreams'],
    'request.route.runtimeLocation': facts['request.route.runtimeLocation'],
    'request.http': {
      method: 'POST',
      url: { origin: facts['request.http'].url.origin, pathname: '/alpha/search' },
      headers: [['content-type', 'application/json']],
      body: Bytes.fromUtf8(JSON.stringify({ id: sessionId, input, commands, settings })),
    },
  });
  const { 'response.http': response } = await run.result;
  const raw = (await readHttpBytes(response.body)).utf8();
  if (!httpSucceeded(response)) {
    const upstreamError = upstreamErrorDetails(raw);
    if (upstreamError?.name === UNSUPPORTED_LOCAL_WEB_SEARCH_FEATURE_ERROR_NAME) {
      return unsupportedLocalWebSearchFeatureIr(action, upstreamError.message);
    }
    throw new Error(upstreamError?.message ?? `OpenAI search upstream returned HTTP ${response.status}: ${raw}`);
  }

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
    // this explicitly synthetic entry serves OpenAI Responses clients that request
    // `web_search_call.results` without pretending alpha DTOs were preserved.
    results: body.output === ''
      ? []
      : [{ type: 'text_result', url: '', title: 'OpenAI search output', snippet: body.output }],
    outputText: body.output,
  };
};
