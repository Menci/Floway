import { RouteAffinityRequestContext, routeCandidateAsLegacySelection } from './affinity.ts';
import { ChatUsageLedger } from './usage-ledger.ts';
import type { GatewayRequestDirectory } from '../../pipeline/index.ts';
import { createGatewayPipelineServices } from '../../pipeline/services.ts';
import { loadWebSearchConfig } from '../../tools/web-search/config.ts';
import type { WebSearchPipelineServices } from '../../tools/web-search/pipeline.ts';
import { resolveConfiguredWebSearchProvider } from '../../tools/web-search/provider.ts';
import type { ConfiguredWebSearchProvider } from '../../tools/web-search/types.ts';
import type { OpenAIResponsesStatefulStore } from '../openai-responses/items/store.ts';
import type { AffinityRequestContext } from '../shared/affinity/context.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import type { SidecarCodecFactory } from '../shared/sidecar-codec.ts';
import type { HeaderEntry, ManagedStream } from '@floway-dev/pipeline';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import type {
  InternalDebugError,
  OpenAIResponsesAction,
  PerformanceTelemetryContext,
  RouteCandidate,
  TelemetryModelIdentity,
} from '@floway-dev/provider';

export interface ChatHttpHead {
  readonly status: number;
  readonly statusText?: string;
  readonly headers: readonly HeaderEntry[];
}

export type ChatAttemptOutcome<TEvent> =
  | {
    readonly type: 'events';
    readonly events: ManagedStream<ProtocolFrame<TEvent>>;
    readonly modelIdentity: TelemetryModelIdentity;
    readonly performance?: PerformanceTelemetryContext;
    readonly http?: ChatHttpHead;
    readonly usageId?: string;
  }
  | {
    readonly type: 'api-error';
    readonly source: 'upstream' | 'gateway';
    readonly upstreamId?: string;
    readonly http: ChatHttpHead;
    readonly body: Uint8Array | null;
    readonly performance?: PerformanceTelemetryContext;
  }
  | {
    readonly type: 'internal-error';
    readonly http: ChatHttpHead;
    readonly error: InternalDebugError;
    readonly performance?: PerformanceTelemetryContext;
  }
  | {
    readonly type: 'plain';
    readonly upstreamId?: string;
    readonly http: ChatHttpHead;
    readonly body: Uint8Array | null;
  };

export type ChatPlainOutcome = Extract<ChatAttemptOutcome<never>, { type: 'plain' }>;

export interface OpenAIChatCompletionsAttemptInput {
  readonly 'route.candidate': RouteCandidate;
  readonly 'request.inboundHeaders': readonly HeaderEntry[];
  readonly 'request.payload': OpenAIChatCompletionsPayloadEx;
}

export interface AnthropicMessagesAttemptInput {
  readonly 'route.candidate': RouteCandidate;
  readonly 'request.inboundHeaders': readonly HeaderEntry[];
  readonly 'request.payload': AnthropicMessagesPayload;
  readonly 'request.anthropicBeta': readonly string[];
}

export interface OpenAIResponsesAttemptInput {
  readonly 'route.candidate': RouteCandidate;
  readonly 'request.inboundHeaders': readonly HeaderEntry[];
  readonly 'request.payload': CanonicalOpenAIResponsesPayload;
  readonly 'request.action': OpenAIResponsesAction;
}

export interface GeminiGenerateContentAttemptInput {
  readonly 'route.candidate': RouteCandidate;
  readonly 'request.inboundHeaders': readonly HeaderEntry[];
  readonly 'request.payload': GeminiGenerateContentPayload;
}

export interface ChatPipelineServices extends WebSearchPipelineServices {
  readonly chatCtx: ChatGatewayCtx;
  readonly affinity: RouteAffinityRequestContext;
  readonly sidecarCodecFactory: SidecarCodecFactory;
  readonly store: OpenAIResponsesStatefulStore;
  readonly usageLedger: ChatUsageLedger;
}

export const createChatPipelineServices = (
  ctx: ChatGatewayCtx,
  options: { readonly directory?: GatewayRequestDirectory } = {},
): ChatPipelineServices => {
  const services = createGatewayPipelineServices(ctx, options);
  const affinityOptions = ctx.affinity as Partial<Pick<AffinityRequestContext, 'select'>>;
  let configuredWebSearchProvider: Promise<ConfiguredWebSearchProvider> | undefined;
  return Object.freeze({
    ...services,
    chatCtx: ctx,
    affinity: new RouteAffinityRequestContext(ctx.affinity.codec, candidate => {
      affinityOptions.select?.call(ctx.affinity, routeCandidateAsLegacySelection(candidate));
    }),
    sidecarCodecFactory: ctx.sidecarCodecFactory,
    store: ctx.store,
    usageLedger: new ChatUsageLedger(),
    webSearchProvider: async () => {
      configuredWebSearchProvider ??= loadWebSearchConfig().then(config => resolveConfiguredWebSearchProvider(config));
      return await configuredWebSearchProvider;
    },
    pageCache: new Map(),
  });
};
