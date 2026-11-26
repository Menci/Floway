import { openAIResponsesLocalError } from './errors.ts';
import { hydrateOpenAIResponsesPayload } from './items/hydrate.ts';
import type { OpenAIResponsesStatefulStore } from './items/store.ts';
import { tryCatchChatServeFailure } from '../shared/errors.ts';
import type { CanonicalOpenAIResponsesInputItem } from '@floway-dev/protocols/openai-responses';

export const hydrateOpenAIResponsesInput = async <Payload extends { input: CanonicalOpenAIResponsesInputItem[]; previous_response_id?: string | null }>(
  payload: Payload,
  store: OpenAIResponsesStatefulStore,
) => {
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
    const failure = tryCatchChatServeFailure<{ kind: 'item-not-found'; itemId: string }>(error);
    if (failure?.kind !== 'item-not-found') throw error;
    return openAIResponsesLocalError(404, `Item with id '${failure.itemId}' not found.`, { param: 'input', code: null });
  }

  await store.stageInputItems(payload.input);
  return { payload: input === request.input ? request : { ...request, input } };
};
