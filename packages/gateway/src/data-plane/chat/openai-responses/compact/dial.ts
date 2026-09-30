import type { Fields } from './facts.ts';
import type { ChatServices } from '../../services.ts';
import type { ChatWire } from '../../wire.ts';
import { simulatesCompaction } from '../compaction-policy.ts';
import { OPENAI_RESPONSES_STREAMED_USAGE } from '../facts.ts';
import { defineStage } from '@floway-dev/pipeline';

/**
 * Picks how this candidate's compaction is produced.
 *
 * An upstream whose own endpoint compacts is asked to, unless the operator asked for the
 * simulation instead — which is what the `openai-responses-compact-shim` flag is: an opt-in for an
 * OpenAI Responses upstream that would answer a compaction itself. Everything else is simulated,
 * structurally rather than by choice: no translation carries a compaction, so an Anthropic
 * Messages or OpenAI Chat Completions candidate has no compaction to dial.
 *
 * It is last, which is what earns it the right to name a target at all, and it holds no state
 * across candidates: failover re-running the suffix re-runs this stage.
 */
export const dialOpenAIResponsesCompaction = (wires: { native: ChatWire; simulated: ChatWire }) => defineStage<
  Fields<'route.attempt'> & Record<string, unknown>,
  Record<string, unknown>,
  Record<string, unknown>,
  Record<string, unknown>,
  ChatServices
>({
  name: 'dialOpenAIResponsesCompaction',
  into: {
    request: {
      needs: ['route.attempt', 'request.chat.openaiResponses', 'ingress.http.headers', 'ingress.chat.sourceProtocol'],
      consumes: [],
      provides: [],
    },
    // Nothing is read on the way back — a wire hands up this family's own keys and they ride
    // through — but this is where they enter the chain, so this is the stage that provides
    // them and the runner checks that the wire delivered.
    response: {
      needs: [],
      consumes: [],
      provides: [
        'response.chat.openaiResponses',
        OPENAI_RESPONSES_STREAMED_USAGE,
        'response.usage.billable',
        'response.http.headers',
      ],
    },
  },
  execute: async (facts, next, use) => {
    const candidate = use.resolveAttempt(facts['route.attempt']);
    const compacts = !simulatesCompaction(candidate, facts['route.attempt']);
    use.log.debug('compacting', { upstream: facts['route.attempt'].upstreamId, wire: compacts ? 'compact' : 'simulated' });
    return await next(facts, compacts ? wires.native : wires.simulated);
  },
});
