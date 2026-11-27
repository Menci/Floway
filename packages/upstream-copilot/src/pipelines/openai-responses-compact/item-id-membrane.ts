import { defineCopilotStage } from '../facts.ts';
import { normalizeCompactionResult, restoreInputItem } from '../openai-responses/item-id-membrane/normalize.ts';
import { mapChanged } from '../shared/map-changed.ts';

export const itemIdMembrane = defineCopilotStage({
  name: 'copilot.openaiResponsesCompact.itemIdMembrane',
  through: {
    request: { needs: ['openaiResponsesCompact'], provides: ['openaiResponsesCompact'], consumes: [] },
    response: { needs: ['openaiResponsesCompact'], provides: ['openaiResponsesCompact'], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = facts['openaiResponsesCompact'];
    const input = mapChanged(payload.input, restoreInputItem);
    const back = await scope.next(input === payload.input ? facts : { ...facts, 'openaiResponsesCompact': { ...payload, input } });
    const outcome = back['openaiResponsesCompact'];
    return outcome.kind === 'result'
      ? { ...back, 'openaiResponsesCompact': { ...outcome, result: normalizeCompactionResult(outcome.result) } }
      : back;
  },
});
