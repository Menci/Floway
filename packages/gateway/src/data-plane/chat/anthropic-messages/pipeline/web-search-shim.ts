import { anthropicMessagesLocalError } from './parse-request.ts';
import { transformAnthropicMessagesFrames } from './protocol-stream.ts';
import { prepareAnthropicMessagesWebSearchShimRequest, rewriteAnthropicMessagesWebSearchEventsToNative } from './web-search-shim/mechanics.ts';
import { gatewayFactSpace } from '../../../pipeline/facts.ts';
import { providerSupportsOperation } from '../../../pipeline/provider-pipelines.ts';
import { loadWebSearchConfig } from '../../../tools/web-search/config.ts';
import { resolveConfiguredWebSearchProvider } from '../../../tools/web-search/provider.ts';
import { move } from '@floway-dev/pipeline';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import { internalDebugErrorFields, toInternalDebugError } from '@floway-dev/provider';

const { defineStage } = gatewayFactSpace<{}>();
const requestKey = 'request.anthropicMessages';
const responseKey = 'response.anthropicMessages';
const response = ['response.http', responseKey] as const;

export const anthropicMessagesWebSearch = (operation: 'anthropicMessages' | 'anthropicMessagesCountTokens') => defineStage({
  name: `${operation}.web-search-shim`,
  through: {
    request: { needs: [requestKey, 'serve.candidate', 'request.auth.apiKeyId'], provides: [requestKey], consumes: [] },
    response: { needs: response, provides: [responseKey], consumes: [] },
  },
  return: { provides: response },
  async execute(facts, scope) {
    const { model, upstream } = facts['serve.candidate'];
    const native = model.endpoints.anthropicMessages !== undefined && providerSupportsOperation(upstream.kind, operation);
    if (native && !model.enabledFlags.includes('anthropic-messages-web-search-shim')) return await scope.next(facts);
    const prepared = prepareAnthropicMessagesWebSearchShimRequest(facts[requestKey] as AnthropicMessagesPayload);
    if (prepared.type === 'invalid-request') return anthropicMessagesLocalError(400, {
      type: 'error',
      error: { type: 'invalid_request_error', message: prepared.message },
    });
    const { state, payload } = prepared;
    if (state.mode === 'inactive') return await scope.next(facts);
    const request = { ...facts, [requestKey]: move(payload) };
    if (operation === 'anthropicMessagesCountTokens') return await scope.next(request);

    let provider: Parameters<typeof rewriteAnthropicMessagesWebSearchEventsToNative>[2];
    if (state.mode === 'active') {
      const configured = resolveConfiguredWebSearchProvider(await loadWebSearchConfig());
      if (configured.type !== 'enabled') {
        const error = toInternalDebugError(new Error(configured.type === 'disabled'
          ? 'Native Anthropic Messages web search requires an enabled search provider.'
          : `Native Anthropic Messages web search is missing the configured ${configured.provider} credential.`));
        return anthropicMessagesLocalError(500, {
          type: 'error',
          error: { type: error.type, message: error.message, provider_specific_fields: internalDebugErrorFields(error) },
        });
      }
      provider = { providerName: configured.provider, impl: configured.impl, apiKeyId: facts['request.auth.apiKeyId'] };
    }

    const call = scope.next(request);
    const back = await call;
    const outcome = back[responseKey];
    if (outcome.kind !== 'stream') return back;
    const stream = scope.wrapStream(outcome.stream, (items, producer) =>
      transformAnthropicMessagesFrames(items, frames => rewriteAnthropicMessagesWebSearchEventsToNative(frames, state, provider),
        () => { producer.abort(call); }));
    return { ...back, [responseKey]: move({ kind: 'stream', stream } as const) };
  },
});
