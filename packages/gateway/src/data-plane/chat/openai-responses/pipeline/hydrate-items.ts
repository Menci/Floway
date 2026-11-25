import { openAIResponsesError } from './error.ts';
import { openAIResponsesExit, openAIResponsesFactSpace } from './facts.ts';
import type { OpenAIResponsesServices } from './services.ts';
import { tryCatchChatServeFailure } from '../../shared/errors.ts';
import { hydrateOpenAIResponsesPayload } from '../items/hydrate.ts';
import { move } from '@floway-dev/pipeline';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';

const { defineStage } = openAIResponsesFactSpace<Pick<OpenAIResponsesServices, 'openAIResponsesState'>>();

export const hydrateOpenAIResponsesItems = defineStage({
  name: 'openaiResponses.hydrate-items',
  through: {
    request: { needs: ['request.openaiResponses'], provides: ['request.openaiResponses'], consumes: [] },
    response: { needs: openAIResponsesExit, provides: [], consumes: [] },
  },
  return: { provides: openAIResponsesExit },
  async execute(facts, scope) {
    const payload = facts['request.openaiResponses'];
    const { store } = scope.services.openAIResponsesState(payload);
    const { previous_response_id: previousResponseId, ...withoutPrevious } = payload;
    let prepared = payload;
    if (previousResponseId != null) {
      const snapshot = await store.loadSnapshot(previousResponseId);
      if (snapshot === null) return openAIResponsesError(400, {
        error: {
          message: `Previous response with id '${previousResponseId}' not found.`,
          type: 'invalid_request_error',
          param: 'previous_response_id',
          code: 'previous_response_not_found',
        },
      });
      prepared = {
        ...withoutPrevious,
        input: [...snapshot.itemIds.map(id => ({ type: 'item_reference' as const, id })), ...payload.input],
      };
    }
    await store.loadInputItems(prepared.input, payload.input);
    let hydrated: CanonicalOpenAIResponsesPayload;
    try {
      hydrated = hydrateOpenAIResponsesPayload(prepared, store);
    } catch (error) {
      const failure = tryCatchChatServeFailure<{ readonly kind: 'item-not-found'; readonly itemId: string }>(error);
      if (failure === null) throw error;
      return openAIResponsesError(404, {
        error: { message: `Item with id '${failure.itemId}' not found.`, type: 'invalid_request_error', param: 'input', code: null },
      });
    }

    await store.stageInputItems(payload.input);
    return await scope.next({ ...facts, 'request.openaiResponses': move(hydrated) });
  },
});
