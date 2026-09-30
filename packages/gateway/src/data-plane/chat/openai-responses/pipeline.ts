import { hydrateStoredItems } from './hydrate-stored-items.ts';
import { failover } from '../../pipeline/failover.ts';
import { materializeAttempt } from '../materialize-attempt.ts';
import { resolveChatCandidates } from '../resolve-candidates.ts';
import { answerOpenAIResponsesWebSocketWarmup } from './answer-websocket-warmup.ts';
import { beginStoredAttempt } from './begin-stored-attempt.ts';
import { projectOpenAIResponsesCollaboration } from './collaboration-shim.ts';
import { asksForCompaction } from './compaction-policy.ts';
import { emitOpenAIResponses } from './emit.ts';
import { expandShimCompactions } from './expand-compactions.ts';
import { OPENAI_RESPONSES_STREAMED_USAGE, type OpenAIResponsesStreamFraming, type OpenAIResponsesServeEntry, type OpenAIResponsesServeExit } from './facts.ts';
import { imageGenerationHostedTool } from './hosted-tools/image-generation.ts';
import { webSearchHostedTool } from './hosted-tools/web-search.ts';
import { hostedTools } from './hosted-tools.ts';
import { normalizeEmptyToolsForOpenAIResponses } from './normalize-empty-tools-tool-choice.ts';
import { summarizeForCompaction } from './summarize-for-compaction.ts';
import { openaiResponsesNarrowing, openaiResponsesTarget } from './target.ts';
import { openaiResponsesWireFor } from './wires.ts';
import { isFailure } from '../../pipeline/facts.ts';
import { writeSettlement } from '../../pipeline/settlement.ts';
import { composeChat as compose } from '../compose.ts';
import { dialChatWire } from '../dial-wire.ts';
import type { Pipeline } from '@floway-dev/pipeline';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';

export const openaiResponsesServePipeline = (
  payload: CanonicalOpenAIResponsesPayload,
  // SSE is what a run is written in when nothing else claims its frames, which is every
  // entry over an HTTP body; the WebSocket transport says so because it writes its own.
  framing: OpenAIResponsesStreamFraming = 'sse',
): Pipeline<OpenAIResponsesServeEntry, OpenAIResponsesServeExit> => {
  // One cell per run, written by the stage directly above the one that reads it. The
  // resolver takes its narrowing at assembly, so this is where the prepared payload crosses
  // from the membrane to the affinity walk; until the membrane has run, what the client sent
  // is the whole of what is known about the turn.
  let prepared = payload;
  return compose('openaiResponsesServe', [
    emitOpenAIResponses(payload, framing),
    writeSettlement(
      handedUp => isFailure((handedUp as { 'response.chat.openaiResponses'?: unknown })['response.chat.openaiResponses']),
      handedUp => (handedUp as { 'response.chat.openaiResponses.streamedUsage'?: unknown })['response.chat.openaiResponses.streamedUsage'] !== null,
    ),
    hydrateStoredItems(payload, hydrated => { prepared = hydrated; }),
    resolveChatCandidates(openaiResponsesNarrowing(() => prepared)),
    failover({
      failed: handedUp => isFailure((handedUp as { 'response.chat.openaiResponses'?: unknown })['response.chat.openaiResponses']),
      owns: [],
      streamedUsage: OPENAI_RESPONSES_STREAMED_USAGE,
    }),
    materializeAttempt('request.chat.openaiResponses'),
    beginStoredAttempt,
    ...framing === 'events' ? [answerOpenAIResponsesWebSocketWarmup] : [],
    expandShimCompactions,
    projectOpenAIResponsesCollaboration,
    summarizeForCompaction(asksForCompaction),
    // Directly above the dial, because every descent it makes is another dial of this same
    // candidate: a hosted tool the upstream does not implement is emulated by asking again with
    // the tool's result folded back in, and the frames of every ask are spliced into one turn.
    hostedTools([webSearchHostedTool, imageGenerationHostedTool], {
      streamedUsage: OPENAI_RESPONSES_STREAMED_USAGE,
      targetOf: candidate => openaiResponsesTarget.pick(candidate.model.endpoints),
    }),
    normalizeEmptyToolsForOpenAIResponses,
    dialChatWire({
      source: 'request.chat.openaiResponses',
      needs: ['request.chat.openaiResponses', 'ingress.http.headers', 'ingress.chat.sourceProtocol'],
      provides: ['response.chat.openaiResponses', OPENAI_RESPONSES_STREAMED_USAGE, 'response.usage.billable', 'response.http.headers'],
      pick: endpoints => openaiResponsesTarget.pick(endpoints),
      wire: openaiResponsesWireFor,
    }),
  ]);
};
