import type { AnthropicMessagesCandidateRequest } from './facts.ts';
import { type AnthropicMessagesSearch, type PrepareAnthropicMessagesWebSearchShimRequestResult, prepareAnthropicMessagesWebSearchShimRequest, rewriteAnthropicMessagesWebSearchEventsToNative } from './web-search-events.ts';
import { type HttpOutput, jsonHttpResponse } from '../../../pipeline/edge-http.ts';
import { emptyUsageFacts, type UsageFacts, usageResponseKeys } from '../../../pipeline/observe-usage.ts';
import type { GatewayRouteFacts, GatewayServices } from '../../../pipeline/services.ts';
import { runWebSearchAndRecordUsage } from '../../../tools/web-search/search.ts';
import type { ConfiguredWebSearchProvider, WebSearchProviderRequest, WebSearchProviderResult } from '../../../tools/web-search/types.ts';
import type { ChatBodyOutput } from '../../shared/route-body.ts';
import { internalAnthropicMessagesErrorPayload } from '../errors.ts';
import { compose, defineEnding, defineStage, link, snapshotError } from '@floway-dev/pipeline';
import type { ChatTargetApi } from '@floway-dev/provider';

type Request = AnthropicMessagesCandidateRequest & { readonly 'route.targetApi': ChatTargetApi };
type SearchAuth = Pick<GatewayRouteFacts, 'request.auth.apiKeyId'>;
type SearchInput = SearchAuth & { readonly 'request.webSearch': Omit<WebSearchProviderRequest, 'signal'> };
type SearchOutput = { readonly 'response.webSearch': WebSearchProviderResult };
type SearchServices = Pick<GatewayServices, 'webSearchProvider'>;

const unavailableSearchProvider = (provider: Exclude<ConfiguredWebSearchProvider, { type: 'enabled' }>): Error =>
  new Error(provider.type === 'disabled'
    ? 'Native Anthropic Messages web search requires an enabled search provider.'
    : `Native Anthropic Messages web search is missing the configured ${provider.provider} credential.`);

const searchPipeline = compose<SearchInput, SearchOutput, SearchServices>('webSearch', {
  stages: [],
  ending: defineEnding<SearchInput, SearchOutput, {}, SearchServices>({
    name: 'search',
    request: { needs: ['request.auth.apiKeyId', 'request.webSearch'] },
    return: { provides: ['response.webSearch'] },
    execute: async (facts, _into, env) => {
      const provider = await env.services.webSearchProvider();
      if (provider.type !== 'enabled') throw unavailableSearchProvider(provider);
      try {
        return {
          'response.webSearch': await runWebSearchAndRecordUsage({
            provider: provider.impl,
            providerName: provider.provider,
            keyId: facts['request.auth.apiKeyId'],
            request: { ...facts['request.webSearch'], signal: env.signal },
          }),
        };
      } catch (error) {
        // Anthropic exposes backend failures as structured tool results.
        env.log.warn('Web search failed', { error: { ...snapshotError(error) } });
        return { 'response.webSearch': { type: 'error', errorCode: 'unavailable' } };
      }
    },
  }),
});
link([searchPipeline]);

const prepareRequest = (facts: Request): PrepareAnthropicMessagesWebSearchShimRequestResult => {
  const payload = facts['request.anthropicMessages'];
  if (facts['route.targetApi'] === 'anthropicMessages' && !facts['route.candidate'].providerModel.enabledFlags.includes('anthropic-messages-web-search-shim')) {
    return { type: 'ok', payload, state: { mode: 'inactive' } };
  }
  return prepareAnthropicMessagesWebSearchShimRequest(payload);
};

const invalidRequest = (message: string) => ({ type: 'error', error: { type: 'invalid_request_error', message } });
const requestChange = {
  needs: ['request.anthropicMessages', 'route.candidate', 'route.targetApi'],
  consumes: [],
  provides: ['request.anthropicMessages'],
};

type GenerateAnswer = ChatBodyOutput<'anthropicMessages'>;

// Translated targets need an ordinary client tool. Native targets use the shim
// when the selected model opts in, and the stream preserves Anthropic's server-tool frames.
export const webSearchShim = defineStage<Request & SearchAuth, Request, GenerateAnswer, GenerateAnswer, SearchServices>({
  name: 'webSearchShim',
  through: {
    request: { ...requestChange, needs: [...requestChange.needs, 'request.auth.apiKeyId'] },
    response: { needs: ['response.anthropicMessages'], consumes: [], provides: ['response.anthropicMessages'] },
  },
  return: { provides: ['response.http', 'response.anthropicMessages', ...usageResponseKeys] },
  execute: async (facts, next, env) => {
    const prepared = prepareRequest(facts);
    const errorAnswer = (status: number, body: unknown): GenerateAnswer => ({
      'response.http': jsonHttpResponse(status, body, env.clock()),
      'response.anthropicMessages': undefined,
      ...emptyUsageFacts(env),
    });
    if (prepared.type === 'invalid-request') return errorAnswer(400, invalidRequest(prepared.message));
    if (prepared.state.mode === 'inactive') return await next(facts);

    let search: AnthropicMessagesSearch | undefined;
    if (prepared.state.mode === 'active') {
      const configured = await env.services.webSearchProvider();
      if (configured.type !== 'enabled') return errorAnswer(500, internalAnthropicMessagesErrorPayload(unavailableSearchProvider(configured)));
      search = async request => {
        const handle = env.run(searchPipeline, {
          'request.auth.apiKeyId': facts['request.auth.apiKeyId'],
          'request.webSearch': request,
        });
        return (await handle.result)['response.webSearch'];
      };
    }

    const response = await next({ ...facts, 'request.anthropicMessages': prepared.payload });
    const events = response['response.anthropicMessages'];
    if (events === undefined) return response;
    return {
      ...response,
      'response.anthropicMessages': env.wrapStream(events, {
        label: 'Anthropic Messages web search',
        transform: source => rewriteAnthropicMessagesWebSearchEventsToNative(source, prepared.state, search),
      }),
    };
  },
});

type CountAnswer = HttpOutput & UsageFacts & { readonly 'response.targetApi': 'anthropicMessages' };

export const prepareWebSearchCount = defineStage<Request, Request, CountAnswer, CountAnswer>({
  name: 'prepareWebSearchCount',
  through: {
    request: requestChange,
    response: { needs: [], consumes: [], provides: [] },
  },
  return: { provides: ['response.http', 'response.targetApi', ...usageResponseKeys] },
  execute: async (facts, next, env) => {
    const prepared = prepareRequest(facts);
    if (prepared.type === 'invalid-request') {
      return {
        'response.http': jsonHttpResponse(400, invalidRequest(prepared.message), env.clock()),
        'response.targetApi': 'anthropicMessages',
        ...emptyUsageFacts(env),
      };
    }
    return await next({ ...facts, 'request.anthropicMessages': prepared.payload });
  },
});
