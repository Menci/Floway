import { kimiCodeEndpoint } from '../endpoints.ts';
import { selectKimiCodeModel } from '../model-selection.ts';
import type { KimiCodeUpstreamFact } from '../upstream-fact.ts';
import { setHeader, type HttpRequestFact, type HttpResponseFact } from '@floway-dev/http';
import { move } from '@floway-dev/pipeline';
import { FAST_SERVICE_TIER, isFastServiceTier } from '@floway-dev/protocols/common';
import type { ProtocolError, ProviderModelFact } from '@floway-dev/provider';

export const kimiCodeRequest = (
  request: HttpRequestFact, upstream: KimiCodeUpstreamFact, path: string, body: object,
): HttpRequestFact => {
  const { region, apiKey } = upstream.config;
  const authorization = apiKey.map(key => `Bearer ${key}`);
  return move({
    ...request,
    method: 'POST',
    url: kimiCodeEndpoint(region, path),
    headers: setHeader(setHeader(request.headers, 'content-type', 'application/json'), 'authorization', authorization),
    body,
  });
};

type KimiCodeRequestError = {
  readonly http: HttpResponseFact;
  readonly outcome: ProtocolError;
};

const invalidSpeed = (message: string, anthropicMessages: boolean): KimiCodeRequestError => ({
  http: { status: 400, statusText: 'Bad Request', headers: [['content-type', 'application/json']], body: null },
  outcome: {
    kind: 'error',
    source: 'local',
    error: { ...(anthropicMessages ? { type: 'error' } : {}), error: { type: 'invalid_request_error', message } },
  },
});

export const kimiCodeOpenAIModel = (model: ProviderModelFact, serviceTier: string | null | undefined) => {
  const fast = isFastServiceTier(serviceTier);
  const selection = selectKimiCodeModel(model, fast);
  if (selection === undefined) {
    return invalidSpeed(`'${model.id}' is only available with fast mode selected; set \`service_tier: "${FAST_SERVICE_TIER}"\`.`, false);
  }
  const tier = selection.lane === 'fast' ? FAST_SERVICE_TIER : 'default' as const;
  return { modelId: selection.modelId, tier: fast ? tier : undefined } as const;
};

export const kimiCodeAnthropicMessagesModel = (model: ProviderModelFact, speed: unknown) => {
  // https://platform.claude.com/docs/en/build-with-claude/fast-mode
  const selection = selectKimiCodeModel(model, speed === 'fast');
  if (speed === 'fast' && selection?.lane !== 'fast') {
    return invalidSpeed(`'${model.id}' does not support fast mode; omit \`speed\` or set \`speed: "standard"\`.`, true);
  }
  return selection ?? invalidSpeed(`'${model.id}' is only available with fast mode selected; set \`speed: "fast"\`.`, true);
};
