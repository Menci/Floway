import { collectOpenAIResponsesCompactionTurn, containsCompactionTrigger, decryptOpenAIResponsesCompaction, dropOpenAIResponsesCompactionTurn, expandShimCompactionItems, simulateOpenAIResponsesCompaction, type OpenAIResponsesCompactionTurn } from '../../../non-chat/openai-responses-compact/compaction.ts';
import { defineStage } from '../../pipeline/facts.ts';
import { syntheticEventsFromCompaction } from '../items/output.ts';
import type { Result } from '@floway-dev/pipeline';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import type { ProtocolStreamError } from '@floway-dev/upstream';

export const compactOpenAIResponsesHistory = defineStage({
  name: 'openaiResponses.compact-history',
  through: {
    request: { needs: ['openaiResponses', 'model', 'chat.target'], provides: ['openaiResponses'], consumes: [] },
    response: {
      needs: ['http', 'openaiResponses', 'usage?', 'usageModelKey?'],
      provides: ['http', 'openaiResponses'],
      consumes: [],
    },
  },
  async execute(facts, scope) {
    const payload = expandShimCompactionItems(facts.openaiResponses);
    const { enabledFlags } = facts.model;
    const simulate = facts['chat.target'] !== 'openaiResponses' || enabledFlags.includes('openai-responses-compact-shim');
    const decrypt = enabledFlags.includes('openai-responses-compact-decrypt');
    if (!containsCompactionTrigger(payload.input) || (!simulate && !decrypt)) {
      return await scope.next({ ...facts, openaiResponses: payload });
    }

    const generate = async (request: CanonicalOpenAIResponsesPayload): Promise<OpenAIResponsesCompactionTurn> => {
      const call = scope.next({ ...facts, openaiResponses: request });
      const answer = await call;
      return await collectOpenAIResponsesCompactionTurn(call, answer, scope);
    };
    const drop = (turn: OpenAIResponsesCompactionTurn): void => dropOpenAIResponsesCompactionTurn(turn, scope);
    const { answer, response, outcome } = simulate
      ? await simulateOpenAIResponsesCompaction(payload, generate, drop, () =>
          scope.log.warn('Floway: OpenAI Responses compact shim returned no assistant text, retrying with the legacy summarizer'))
      : await decryptOpenAIResponsesCompaction(await generate(payload), payload.model, generate, drop);
    const { http } = response;
    if (outcome.kind === 'error') return { ...answer, http, openaiResponses: outcome };
    const stream = scope.createStream(async function* (): AsyncGenerator<Result<OpenAIResponsesStreamEventEx, ProtocolStreamError>> {
      for await (const frame of syntheticEventsFromCompaction(outcome.result)) {
        if (frame.type === 'event') yield { ok: true, value: frame.event };
      }
    });
    return { ...answer, http, openaiResponses: { kind: 'stream', stream } };
  },
});
