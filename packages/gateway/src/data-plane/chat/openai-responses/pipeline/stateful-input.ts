import { openAIResponsesLocalError } from './local-error.ts';
import { defineStage } from '../../pipeline/facts.ts';
import { hydrateOpenAIResponsesPayload, OpenAIResponsesItemNotFoundError } from '../items/hydrate.ts';
import type { OpenAIResponsesStatefulStore } from '../items/store.ts';
import type { CanonicalOpenAIResponsesInputItem } from '@floway-dev/protocols/openai-responses';

export const hydrateOpenAIResponsesInput = async <Payload extends {
  model: string;
  input: CanonicalOpenAIResponsesInputItem[];
  previous_response_id?: string | null;
}>(payload: Payload, store: OpenAIResponsesStatefulStore) => {
  const { previous_response_id: previousId, ...history } = payload;
  const request = previousId == null ? payload : history;
  let input = payload.input;
  if (previousId != null) {
    const snapshot = await store.loadSnapshot(previousId);
    if (snapshot === null) {
      // https://github.com/openai/openai-agents-python/issues/2020
      return openAIResponsesLocalError(400, `Previous response with id '${previousId}' not found.`, {
        param: 'previous_response_id', code: 'previous_response_not_found',
      });
    }
    input = [...snapshot.itemIds.map(id => ({ type: 'item_reference' as const, id })), ...input];
  }
  await store.loadInputItems(input, payload.input);
  try {
    input = hydrateOpenAIResponsesPayload({ ...request, input }, store).input;
  } catch (error) {
    if (!(error instanceof OpenAIResponsesItemNotFoundError)) throw error;
    return openAIResponsesLocalError(404, error.message);
  }

  await store.stageInputItems(payload.input);
  const hydrated = { ...payload, input };
  if (previousId != null) delete hydrated.previous_response_id;
  return { payload: hydrated };
};

export const prepareOpenAIResponsesStatefulInput = defineStage({
  name: 'openaiResponses.hydrate-stateful-input',
  through: {
    request: { needs: ['openaiResponses', 'delivery', 'serve.startedAt'], provides: ['openaiResponses'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['http', 'openaiResponses'] },
  async execute(facts, scope) {
    const store = scope.services.openaiResponsesStore(facts['serve.startedAt'], facts.delivery.store);
    const prepared = await hydrateOpenAIResponsesInput(facts.openaiResponses, store);
    if ('openaiResponses' in prepared) return prepared;
    return await scope.next({ ...facts, openaiResponses: prepared.payload });
  },
});
