import type { AnthropicMessagesPreparedFacts, AnthropicMessagesGenerateOutcome } from './types.ts';
import { providerWebSearchSubPipeline } from '../../../tools/web-search/pipeline.ts';
import type { WebSearchProviderRequest } from '../../../tools/web-search/types.ts';
import { internalErrorChatOutcome, gatewayInputErrorOutcome } from '../../pipeline/index.ts';
import type { ChatPipelineServices } from '../../pipeline/index.ts';
import {
  anthropicMessagesWebSearchInvalidRequestBody,
  prepareAnthropicMessagesWebSearchStage,
  rewriteAnthropicMessagesWebSearchEventsToNative,
} from '../web-search-shim.ts';
import { defineStage } from '@floway-dev/pipeline';
import { toInternalDebugError } from '@floway-dev/provider';

export const webSearchShim = defineStage<
  AnthropicMessagesPreparedFacts,
  Pick<AnthropicMessagesPreparedFacts, 'request.payload' | 'web-search.state'>,
  AnthropicMessagesGenerateOutcome,
  AnthropicMessagesGenerateOutcome,
  never,
  ChatPipelineServices
>({
  name: 'webSearchShim',
  provides: ['request.payload', 'web-search.state'],
  execute: async (facts, next, env) => {
    const prepared = prepareAnthropicMessagesWebSearchStage(
      facts['request.payload'],
      facts['route.candidate'],
      facts['route.targetApi']!,
    );
    if (prepared.type === 'inactive') {
      return await next({
        'request.payload': facts['request.payload'],
        'web-search.state': facts['web-search.state'],
      });
    }
    if (prepared.type === 'invalid-request') {
      return gatewayInputErrorOutcome(400, anthropicMessagesWebSearchInvalidRequestBody(prepared.message));
    }

    if (prepared.state.mode === 'active') {
      const configured = await env.webSearchProvider();
      if (configured.type !== 'enabled') {
        return internalErrorChatOutcome(500, toInternalDebugError(new Error(
          configured.type === 'disabled'
            ? 'Native Anthropic Messages web search requires an enabled search provider.'
            : `Native Anthropic Messages web search is missing the configured ${configured.provider} credential.`,
        )));
      }
    }

    const result = await next({
      'request.payload': prepared.payload,
      'web-search.state': prepared.state,
    });
    if (result.type !== 'events') return result;
    return {
      ...result,
      events: env.wrapStream(result.events, {
        label: 'anthropic-messages.web-search.events',
        transform: (source, _signal, streamEnv) => rewriteAnthropicMessagesWebSearchEventsToNative(
          source,
          prepared.state,
          prepared.state.mode === 'active'
            ? async (request: WebSearchProviderRequest) => await streamEnv.spawnSubRun(providerWebSearchSubPipeline, { 'web-search.request': request })
            : undefined,
        ),
      }),
    };
  },
});

export const webSearchRequestPrepared = defineStage<
  AnthropicMessagesPreparedFacts,
  Pick<AnthropicMessagesPreparedFacts, 'request.payload' | 'web-search.state'>,
  import('../../pipeline/index.ts').ChatPlainOutcome,
  import('../../pipeline/index.ts').ChatPlainOutcome,
  never,
  ChatPipelineServices
>({
  name: 'webSearchRequestPrepared',
  provides: ['request.payload', 'web-search.state'],
  execute: async (facts, next) => {
    const prepared = prepareAnthropicMessagesWebSearchStage(
      facts['request.payload'],
      facts['route.candidate'],
      facts['route.targetApi']!,
    );
    if (prepared.type === 'inactive') {
      return await next({
        'request.payload': facts['request.payload'],
        'web-search.state': facts['web-search.state'],
      });
    }
    if (prepared.type === 'invalid-request') {
      return {
        type: 'plain' as const,
        http: {
          status: 400,
          headers: Object.freeze([Object.freeze(['content-type', 'application/json'] as const)]),
        },
        body: new TextEncoder().encode(JSON.stringify(anthropicMessagesWebSearchInvalidRequestBody(prepared.message))),
      };
    }
    return await next({
      'request.payload': prepared.payload,
      'web-search.state': prepared.state,
    });
  },
});
