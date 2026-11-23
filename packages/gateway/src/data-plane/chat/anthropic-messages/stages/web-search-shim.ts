import type { AnthropicMessagesTargetRequest } from './facts.ts';
import { type AnthropicMessagesSearch, invalidWebSearchRequest, prepareAnthropicMessagesWebSearchForTarget, rewriteAnthropicMessagesWebSearchEventsToNative } from './web-search-protocol.ts';
import { answerKeys, gatewayAnswer } from '../../../pipeline/answer.ts';
import { jsonHttpResponse } from '../../../pipeline/edge-http.ts';
import type { GatewayRouteFacts, GatewayServices } from '../../../pipeline/services.ts';
import { currentHour } from '../../../shared/telemetry/hour.ts';
import type { ConfiguredWebSearchProvider, WebSearchProviderRequest, WebSearchProviderResult } from '../../../tools/web-search/types.ts';
import { type SearchUsageRecords, type SearchUsageSettlementFacts, writeSearchUsage } from '../../../tools/web-search/write-search-usage.ts';
import type { ChatBodyOutput } from '../../shared/route-body.ts';
import { internalAnthropicMessagesErrorPayload } from '../errors.ts';
import { compose, defineEnding, defineStage, link, snapshotError } from '@floway-dev/pipeline';

type Request = AnthropicMessagesTargetRequest;
type SearchAuth = Pick<GatewayRouteFacts, 'request.auth.apiKeyId'>;
type SearchInput = SearchAuth & { readonly 'request.webSearch': Omit<WebSearchProviderRequest, 'signal'> };
type SearchOutput = { readonly 'response.webSearch': WebSearchProviderResult };
type MeasuredSearch = SearchOutput & SearchUsageRecords;
type SearchServices = Pick<GatewayServices, 'webSearchProvider' | 'searchUsageStore'>;

const unavailableSearchProvider = (provider: Exclude<ConfiguredWebSearchProvider, { type: 'enabled' }>): Error =>
  new Error(provider.type === 'disabled'
    ? 'Native Anthropic Messages web search requires an enabled search provider.'
    : `Native Anthropic Messages web search is missing the configured ${provider.provider} credential.`);

const searchPipeline = compose<SearchInput, SearchOutput & SearchUsageSettlementFacts, SearchServices>('webSearch', {
  stages: [writeSearchUsage],
  ending: defineEnding<SearchInput, MeasuredSearch, {}, Pick<GatewayServices, 'webSearchProvider'>>({
    name: 'search',
    request: { needs: ['request.auth.apiKeyId', 'request.webSearch'] },
    return: { provides: ['response.webSearch', 'response.searchUsage.records'] },
    execute: async (facts, _into, env) => {
      const provider = await env.services.webSearchProvider();
      if (provider.type !== 'enabled') throw unavailableSearchProvider(provider);
      let result: WebSearchProviderResult;
      try {
        result = await provider.impl.search({ ...facts['request.webSearch'], signal: env.signal });
      } catch (error) {
        // Anthropic exposes backend failures as structured tool results.
        env.log.warn('Web search failed', { error: { ...snapshotError(error) } });
        result = { type: 'error', errorCode: 'unavailable' };
      }
      return {
        'response.webSearch': result,
        'response.searchUsage.records': [{
          provider: provider.provider,
          keyId: facts['request.auth.apiKeyId'],
          action: 'search',
          hour: currentHour(),
          requests: 1,
        }],
      };
    },
  }),
});
link([searchPipeline]);

type GenerateAnswer = ChatBodyOutput<'anthropicMessages'>;

// Translated targets need an ordinary client tool. Native targets use the shim
// when the selected model opts in, and the stream preserves Anthropic's server-tool frames.
export const webSearchShim = defineStage<Request & SearchAuth, Request, GenerateAnswer, GenerateAnswer, SearchServices>({
  name: 'webSearchShim',
  through: {
    request: {
      needs: ['request.anthropicMessages', 'route.candidate', 'route.targetApi', 'request.auth.apiKeyId'],
      consumes: [],
      provides: ['request.anthropicMessages'],
    },
    response: { needs: ['response.anthropicMessages'], consumes: [], provides: ['response.anthropicMessages'] },
  },
  return: { provides: [...answerKeys, 'response.anthropicMessages'] },
  execute: async (facts, next, env) => {
    const prepared = prepareAnthropicMessagesWebSearchForTarget(facts);
    const errorAnswer = (status: number, body: unknown): GenerateAnswer => ({
      ...gatewayAnswer(env, jsonHttpResponse(status, body, env.clock())),
      'response.anthropicMessages': undefined,
    });
    if (prepared.type === 'invalid-request') return errorAnswer(400, invalidWebSearchRequest(prepared.message));
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
