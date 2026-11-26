import type { AffinityCodec } from './affinity/carrier.ts';
import type { AffinityEgressOptions } from './affinity/context.ts';
import type { AffinityRequestAnalysis } from './affinity/selection.ts';
import type { ChatCollectionFailure, ChatCollector } from './collect.ts';
import type { StreamUsage } from '../../pipeline/compute-usage.ts';
import type { defineOperationStage, GatewayPipelineFacts, OperationEvent } from '../../pipeline/facts.ts';
import type { GatewayServices } from '../../pipeline/services.ts';
import type { HttpRequestFact, HttpResponseFact } from '@floway-dev/http';
import { factSpace, type ManagedStream } from '@floway-dev/pipeline';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ProtocolError, ProtocolStreamError } from '@floway-dev/provider';
import type { TranslateInputError } from '@floway-dev/translate';

export type ChatOperation = 'anthropicMessages' | 'geminiGenerateContent' | 'openaiChatCompletions' | 'openaiResponses';
export type ChatPayload<Op extends ChatOperation> = GatewayPipelineFacts[`request.${Op}`];
export type CollectedChatResult<Op extends ChatOperation> = Extract<GatewayPipelineFacts[`response.${Op}`], { kind: 'result' }>['result'];
export type ChatOutcome<Op extends ChatOperation> =
  | { kind: 'stream'; stream: ManagedStream<OperationEvent<Op>, ProtocolStreamError> }
  | { kind: 'result'; result: CollectedChatResult<Op> }
  | ProtocolError;

type Stage = ReturnType<typeof defineOperationStage>;
type LocalAnswer = { http: HttpResponseFact; outcome: ProtocolError };

export interface ChatProtocolStages<Op extends ChatOperation, Delivery extends { stream: boolean }> {
  parse: Stage;
  parseWebSocket?: Stage;
  encode: Stage;
  ingress?: readonly Stage[];
  clientEgress?: readonly Stage[];
  body?: readonly Stage[];
  egress?: readonly Stage[];
  usage(): StreamUsage<OperationEvent<Op>>;
  collect(delivery: Delivery): ChatCollector<Op>;
  streamError(error: ProtocolStreamError): ChatCollectionFailure;
  model: 'request.model' | ((payload: ChatPayload<Op>, http: HttpRequestFact) => string);
  unavailable(input: { model: string; exists: boolean; failedUpstreams: readonly string[] }): LocalAnswer;
  affinityUnavailable(message: string): LocalAnswer;
  invalidTranslation(error: TranslateInputError): LocalAnswer;
  analyzeAffinity(payload: ChatPayload<Op>, codec: AffinityCodec): Promise<AffinityRequestAnalysis<ChatPayload<Op>>>;
  affinityEgress?(
    frames: AsyncIterable<ProtocolFrame<OperationEvent<Op>>>,
    options: AffinityEgressOptions,
  ): AsyncIterable<ProtocolFrame<OperationEvent<Op>>>;
}

type ChatFacts = GatewayPipelineFacts & { 'request.ws.responseId': string };

export const { compose: composeChat, composeGroup: composeChatBodies } = factSpace<ChatFacts, GatewayServices>();

export const chatEgressEntry = <Op extends ChatOperation>(operation: Op) => [
  'request.http',
  'request.auth.apiKeyId',
  'serve.runtimeLocation',
  'provider.upstream',
  'provider.model',
  'request.aliasRules?',
  `request.${operation}`,
] as const;

const chatBodyExtras = {
  anthropicMessages: [],
  geminiGenerateContent: ['request.model'],
  openaiChatCompletions: [],
  openaiResponses: ['request.ws.responseId?'],
} as const;

export const chatBodyEntry = <Op extends ChatOperation>(operation: Op) => [
  ...chatEgressEntry(operation),
  'request.auth.userId',
  'request.auth.isAdmin',
  'request.auth.upstreamIds',
  'request.auth.randomizeUpstreams',
  ...chatBodyExtras[operation],
] as const;

export const chatEgressExit = <Op extends ChatOperation>(operation: Op) => ['response.http', `response.${operation}`, 'response.usage', 'response.performance'] as const;
export const chatBodyExit = <Op extends ChatOperation>(operation: Op) => ['response.http', `response.${operation}`, 'response.usage?', 'response.performance?'] as const;

export const passthrough = (request: readonly string[], response: readonly string[]) => ({
  request: { needs: request, provides: [], consumes: [] },
  response: { needs: response, provides: [], consumes: [] },
});
