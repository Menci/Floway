import { failover } from '../../pipeline/failover.ts';
import { resolveChatCandidates } from '../resolve-candidates.ts';
import { OPENAI_RESPONSES_STREAMED_USAGE } from './facts.ts';
import { materializeAttempt } from '../materialize-attempt.ts';
import { beginStoredAttempt } from './begin-stored-attempt.ts';
import { projectOpenAIResponsesCollaboration } from './collaboration-shim.ts';
import { composeChat as compose } from '../compose.ts';
import { dialOpenAIResponsesCompaction } from './compact/dial.ts';
import { emitOpenAIResponsesCompaction } from './compact/emit.ts';
import type { OpenAIResponsesCompactEntry, OpenAIResponsesCompactExit } from './compact/facts.ts';
import { compactionWire, simulationWire } from './compact/wire.ts';
import { expandShimCompactions } from './expand-compactions.ts';
import { imageGenerationHostedTool } from './hosted-tools/image-generation.ts';
import { webSearchHostedTool } from './hosted-tools/web-search.ts';
import { hostedTools } from './hosted-tools.ts';
import { hydrateStoredItems } from './hydrate-stored-items.ts';
import { openaiResponsesNarrowing, openaiResponsesTarget } from './target.ts';
import { isFailure } from '../../pipeline/facts.ts';
import { writeSettlement } from '../../pipeline/settlement.ts';
import type { Pipeline } from '@floway-dev/pipeline';

export const openaiResponsesCompactPipeline = (): Pipeline<OpenAIResponsesCompactEntry, OpenAIResponsesCompactExit> => {
  return compose('openaiResponsesCompact', [
    writeSettlement(handedUp => Number(handedUp['response.http.status']) >= 400, OPENAI_RESPONSES_STREAMED_USAGE),
    emitOpenAIResponsesCompaction,
    hydrateStoredItems,
    resolveChatCandidates(openaiResponsesNarrowing),
    failover({
      failed: handedUp => isFailure((handedUp as { 'response.chat.openaiResponses'?: unknown })['response.chat.openaiResponses']),
      owns: ['response.http.body'],
      pendingUsage: OPENAI_RESPONSES_STREAMED_USAGE,
    }),
    materializeAttempt('request.chat.openaiResponses'),
    beginStoredAttempt,
    expandShimCompactions,
    projectOpenAIResponsesCollaboration,
    // A compaction declares no hosted tool of its own, so what this does here is the other half
    // of the same rule: an `image_generation_call` or `web_search_call` echoed from an earlier
    // turn is rewritten into something the upstream can read. The loop never runs — there is no
    // hosted tool to dispatch — which is what keeps a summarization from calling out.
    hostedTools([webSearchHostedTool, imageGenerationHostedTool], {
      streamedUsage: OPENAI_RESPONSES_STREAMED_USAGE,
      targetOf: candidate => openaiResponsesTarget.pick(candidate.model.endpoints),
    }),
    dialOpenAIResponsesCompaction({ native: compactionWire, simulated: simulationWire }),
  ]);
};
