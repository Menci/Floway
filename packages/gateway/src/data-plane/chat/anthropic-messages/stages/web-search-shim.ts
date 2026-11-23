import type { AnthropicMessagesTargetRequest } from './facts.ts';
import { type AnthropicMessagesSearch, invalidWebSearchRequest, prepareAnthropicMessagesWebSearchForTarget, rewriteAnthropicMessagesWebSearchEventsToNative } from './web-search-protocol.ts';
import { jsonHttpResponse } from '../../../pipeline/edge-http.ts';
import type { GatewayRouteFacts, GatewayServices } from '../../../pipeline/services.ts';
import { currentHour } from '../../../shared/telemetry/hour.ts';
import type { ConfiguredWebSearchProvider, WebSearchProviderRequest, WebSearchProviderResult } from '../../../tools/web-search/types.ts';
import { type SearchUsageRecords, type SearchUsageSettlementFacts, writeSearchUsage } from '../../../tools/web-search/write-search-usage.ts';
import type { ChatBodyOutput } from '../../shared/route-body.ts';
import { internalAnthropicMessagesErrorPayload } from '../errors.ts';
import { compose, defineEnding, defineStage, type FactValue, link, snapshotError } from '@floway-dev/pipeline';

type Request = AnthropicMessagesTargetRequest;
type SearchAuth = Pick<GatewayRouteFacts, 'request.auth.apiKeyId'>;
type SearchInput = SearchAuth & { readonly 'request.webSearch': Omit<WebSearchProviderRequest, 'signal'> };
type SearchOutput = { readonly 'response.webSearch': WebSearchProviderResult };
type MeasuredSearch = SearchOutput & SearchUsageRecords;

const unavailableSearchProvider = (provider: Exclude<ConfiguredWebSearchProvider, { type: 'enabled' }>): Error =>
  new Error(provider.type === 'disabled'
    ? 'Native Anthropic Messages web search requires an enabled search provider.'
    : `Native Anthropic Messages web search is missing the configured ${provider.provider} credential.`);

const searchEntry = ['request.auth.apiKeyId', 'request.webSearch'] as const;
const searchExit = ['response.webSearch', 'response.searchUsage.settlement'] as const;

const searchPipeline = compose<SearchInput & SearchOutput & SearchUsageSettlementFacts, GatewayServices>()('webSearch', {
  entry: searchEntry,
  exit: searchExit,
  stages: [writeSearchUsage],
  ending: defineEnding<SearchInput, MeasuredSearch, {}, Pick<GatewayServices, 'webSearchProvider'>>({
    name: 'search',
    request: { needs: searchEntry },
    return: { provides: ['response.webSearch', 'response.searchUsage.records'] },
    execute: async (facts, scope) => {
      const provider = await scope.services.webSearchProvider();
      if (provider.type !== 'enabled') throw unavailableSearchProvider(provider);
      let result: WebSearchProviderResult;
      try {
        result = await provider.impl.search({ ...facts['request.webSearch'], signal: scope.signal });
      } catch (error) {
        // Anthropic exposes backend failures as structured tool results.
        scope.log.warn('Web search failed', { error: { ...snapshotError(error) } });
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
export const webSearchShim = defineStage<Request & SearchAuth, Request, GenerateAnswer, GenerateAnswer, GatewayServices>({
  name: 'webSearchShim',
  through: {
    request: {
      needs: ['request.anthropicMessages', 'route.candidate', 'route.targetApi', 'request.auth.apiKeyId'],
      consumes: [],
      provides: ['request.anthropicMessages'],
    },
    response: { needs: ['response.anthropicMessages'], consumes: [], provides: ['response.anthropicMessages'] },
  },
  return: { provides: ['response.http', 'response.anthropicMessages'] },
  execute: async (facts, scope) => {
    const prepared = prepareAnthropicMessagesWebSearchForTarget(facts);
    const errorAnswer = (status: number, error: FactValue): GenerateAnswer => ({
      'response.http': jsonHttpResponse(status, error, scope.clock()),
      'response.anthropicMessages': { kind: 'error', source: 'local', error },
    });
    if (prepared.type === 'invalid-request') return errorAnswer(400, invalidWebSearchRequest(prepared.message));
    if (prepared.state.mode === 'inactive') return await scope.next(facts);

    if (prepared.state.mode === 'active') {
      const configured = await scope.services.webSearchProvider();
      if (configured.type !== 'enabled') {
        return errorAnswer(500, internalAnthropicMessagesErrorPayload(unavailableSearchProvider(configured)) as FactValue);
      }
    }

    const response = await scope.next({ ...facts, 'request.anthropicMessages': prepared.payload });
    const outcome = response['response.anthropicMessages'];
    if (outcome.kind !== 'stream') return response;
    return {
      ...response,
      'response.anthropicMessages': {
        kind: 'stream',
        events: scope.wrapStream(outcome.events, {
          label: 'Anthropic Messages web search',
          async *transform(source, scope) {
            const search: AnthropicMessagesSearch = async request => {
              const handle = scope.run(searchPipeline, {
                'request.auth.apiKeyId': facts['request.auth.apiKeyId'],
                'request.webSearch': request,
              });
              return (await handle.result)['response.webSearch'];
            };
            yield* rewriteAnthropicMessagesWebSearchEventsToNative(source, prepared.state, search);
          },
        }),
      },
    };
  },
});
