import { anthropicMessagesChat } from './anthropic-messages/pipeline-stages.ts';
import { geminiGenerateContentChat } from './gemini-generate-content/pipeline-stages.ts';
import { openAIChatCompletionsChat } from './openai-chat-completions/pipeline-stages.ts';
import { openAIResponsesChat } from './openai-responses/pipeline-stages.ts';
import { buildAttemptTargets } from './shared/affinity/attempt-targets.ts';
import { affinityOutput } from './shared/affinity/output.ts';
import { collectChat } from './shared/collect.ts';
import { enterChatProtocol } from './shared/enter-body.ts';
import { firstOutputTokenSignal } from './shared/first-output-token.ts';
import { chatBodyEntry, chatBodyExit, chatEgressEntry, chatEgressExit, composeChat, composeChatBodies, type ChatOperation, type ChatProtocolStages } from './shared/pipeline.ts';
import { chatTargets, pickChatTarget, routeChatBody } from './shared/translate.ts';
import { stripAuthenticationHeaders } from '../pipeline/auth-headers.ts';
import { computeUsage } from '../pipeline/compute-usage.ts';
import { discoverCandidates } from '../pipeline/discover-candidates.ts';
import { failover } from '../pipeline/failover.ts';
import { measurePerformance } from '../pipeline/performance.ts';
import { providerTargets } from '../pipeline/provider-targets.ts';
import { storeUsage } from '../pipeline/store-usage.ts';
import { eventFrame } from '@floway-dev/protocols/common';

const chatEgress = <Op extends ChatOperation, Delivery extends { stream: boolean }>(
  operation: Op,
  protocol: ChatProtocolStages<Op, Delivery>,
) => composeChat(`${operation}.egress`, {
  entry: chatEgressEntry(operation),
  exit: chatEgressExit(operation),
  stages: [
    measurePerformance(operation, 'chat', event => firstOutputTokenSignal(eventFrame(event), operation) !== null),
    storeUsage,
    computeUsage(operation, { stream: protocol.usage }),
    ...protocol.egress ?? [],
  ],
  ...providerTargets(operation),
});

const chatBody = <Op extends ChatOperation, Delivery extends { stream: boolean }>(
  operation: Op,
  protocol: ChatProtocolStages<Op, Delivery>,
) => ({
  entry: chatBodyEntry(operation),
  exit: chatBodyExit(operation),
  stages: protocol.body ?? [],
  ending: routeChatBody(operation, protocol.invalidTranslation),
  targets: { ...chatTargets[operation], native: chatEgress(operation, protocol) },
});

export const chatBodies = composeChatBodies({
  anthropicMessages: chatBody('anthropicMessages', anthropicMessagesChat),
  geminiGenerateContent: chatBody('geminiGenerateContent', geminiGenerateContentChat),
  openaiChatCompletions: chatBody('openaiChatCompletions', openAIChatCompletionsChat),
  openaiResponses: chatBody('openaiResponses', openAIResponsesChat),
});

const chatIngressEntry = [
  'request.http',
  'request.auth.apiKeyId',
  'request.auth.userId',
  'request.auth.isAdmin',
  'request.auth.upstreamIds',
  'request.auth.randomizeUpstreams',
  'serve.runtimeLocation',
] as const;

const chatIngressExit = ['response.http', 'response.candidate?', 'response.usage?', 'response.performance?', 'response.requestedModel?'] as const;

const chatAttempt = <Op extends ChatOperation, Delivery extends { stream: boolean }>(
  operation: Op,
  protocol: ChatProtocolStages<Op, Delivery>,
) => [
  ...protocol.ingress ?? [],
  discoverCandidates(operation, {
    kind: 'chat',
    model: protocol.model,
    supports: ({ endpoints }) => pickChatTarget(operation, endpoints) !== undefined,
    unavailable: protocol.unavailable,
  }),
  buildAttemptTargets(operation, protocol.analyzeAffinity, protocol.affinityUnavailable),
  failover(operation, undefined, { attemptTargets: true }),
  ...protocol.affinityEgress === undefined ? [] : [affinityOutput(operation, protocol.affinityEgress)],
  ...protocol.clientEgress ?? [],
];

const chatIngress = <Op extends ChatOperation, Delivery extends { stream: boolean }, const Extra extends readonly ('serve.startedAt' | 'request.ws.responseId?')[]>(
  operation: Op,
  protocol: ChatProtocolStages<Op, Delivery>,
  extra: Extra,
) => composeChat(`${operation}.ingress`, {
  entry: [...chatIngressEntry, ...extra],
  exit: [...chatIngressExit, 'response.outcome'],
  stages: [
    stripAuthenticationHeaders,
    protocol.parse,
    protocol.encode,
    collectChat(operation, protocol.collect, protocol.streamError),
    ...chatAttempt(operation, protocol),
  ],
  ending: enterChatProtocol(operation),
  targets: { body: chatBodies[operation] },
});

export const anthropicMessagesIngress = chatIngress('anthropicMessages', anthropicMessagesChat, []);
export const geminiGenerateContentIngress = chatIngress('geminiGenerateContent', geminiGenerateContentChat, []);
export const openAIChatCompletionsIngress = chatIngress('openaiChatCompletions', openAIChatCompletionsChat, []);
export const openAIResponsesIngress = chatIngress('openaiResponses', openAIResponsesChat, ['serve.startedAt', 'request.ws.responseId?']);

if (openAIResponsesChat.parseWebSocket === undefined) throw new Error('OpenAI Responses requires a WebSocket parser');

export const openAIResponsesWebSocketIngress = composeChat('openaiResponses.websocket-ingress', {
  entry: [...chatIngressEntry, 'serve.startedAt', 'request.ws.responseId'],
  exit: [...chatIngressExit, 'response.openaiResponses'],
  stages: [stripAuthenticationHeaders, openAIResponsesChat.parseWebSocket, ...chatAttempt('openaiResponses', openAIResponsesChat)],
  ending: enterChatProtocol('openaiResponses'),
  targets: { body: chatBodies.openaiResponses },
});
