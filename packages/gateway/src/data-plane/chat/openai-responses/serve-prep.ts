import type { hydrateOpenAIResponsesPayload } from './items/hydrate.ts';
import type { OpenAIResponsesStatefulStore } from './items/store.ts';

// Thrown when a request names a `previous_response_id` that the store cannot
// resolve. The HTTP/WS entry layer renders the OpenAI-shaped 400 body
// verbatim — clients compare it byte-for-byte against upstream OpenAI's
// `previous_response_not_found` envelope.
//
// Verbatim payload cross-verified from real upstream captures:
// - https://github.com/cline/cline/issues/9399
// - https://github.com/microsoft/semantic-kernel/issues/13128
// - https://github.com/router-for-me/CLIProxyAPI/issues/999
// - https://github.com/openai/openai-agents-python/issues/2020
export class PreviousResponseNotFoundError extends Error {
  readonly previousResponseId: string;

  constructor(previousResponseId: string) {
    super(`Previous response with id '${previousResponseId}' not found.`);
    this.name = 'PreviousResponseNotFoundError';
    this.previousResponseId = previousResponseId;
  }
}

export const expandPreviousResponseId = async (
  payload: Parameters<typeof hydrateOpenAIResponsesPayload>[0],
  store: OpenAIResponsesStatefulStore,
) => {
  const previousResponseId = payload.previous_response_id;
  if (previousResponseId === undefined || previousResponseId === null) return payload;
  const snapshot = await store.loadSnapshot(previousResponseId);
  if (snapshot === null) throw new PreviousResponseNotFoundError(previousResponseId);
  const { previous_response_id: _previous, ...rest } = payload;
  return {
    ...rest,
    input: [
      ...snapshot.itemIds.map(id => ({ type: 'item_reference' as const, id })),
      ...payload.input,
    ],
  };
};
