import { openaiResponsesAffinityOutput } from './affinity-output.ts';
import { openaiResponsesBody } from './body.ts';
import { buildOpenAIResponsesAttemptTargets } from './build-attempt-targets.ts';
import { openAIResponsesClientOutput } from './client-output.ts';
import { collectOpenAIResponses } from './collect.ts';
import { encodeOpenAIResponsesWebSocket } from './encode-websocket.ts';
import { encodeOpenAIResponses } from './encode.ts';
import { enterOpenAIResponsesBody } from './enter-body.ts';
import { failoverOpenAIResponses } from './failover.ts';
import { parseOpenAIResponsesWebSocket } from './parse-websocket.ts';
import { parseOpenAIResponses } from './parse.ts';
import { serializeOpenAIResponsesItems } from './serialize-stream-items.ts';
import { prepareOpenAIResponsesStatefulInput } from './stateful-input.ts';
import { discoverChatCandidates } from '../../pipeline/discover-chat-candidates.ts';
import { compose } from '../../pipeline/facts.ts';
import { asEntry } from '@floway-dev/pipeline';

const stages = [
  openAIResponsesClientOutput,
  prepareOpenAIResponsesStatefulInput,
  discoverChatCandidates,
  buildOpenAIResponsesAttemptTargets,
  failoverOpenAIResponses,
  serializeOpenAIResponsesItems,
  openaiResponsesAffinityOutput,
] as const;

export const openaiResponsesHttpEntry = asEntry(compose('openaiResponses.http', {
  entry: ['http', 'serve.startedAt'],
  exit: ['http', 'usage?', 'candidate?'],
  stages: [parseOpenAIResponses, encodeOpenAIResponses, collectOpenAIResponses, ...stages],
  ending: enterOpenAIResponsesBody,
  targets: { body: openaiResponsesBody },
}));

export const openaiResponsesWebSocketEntry = asEntry(compose('openaiResponses.websocket', {
  entry: ['http', 'serve.startedAt', 'ws.message', 'ws.eventId?', 'ws.responseId?'],
  exit: ['http', 'openaiResponses', 'usage?', 'candidate?'],
  stages: [parseOpenAIResponsesWebSocket, encodeOpenAIResponsesWebSocket, ...stages],
  ending: enterOpenAIResponsesBody,
  targets: { body: openaiResponsesBody },
}));
