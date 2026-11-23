import type { OpenAIResponsesStatefulStore } from './store.ts';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';

// A previous_response_id miss is rendered with OpenAI's original envelope.
// Verbatim payload cross-verified from real upstream captures:
// - https://github.com/cline/cline/issues/9399
// - https://github.com/microsoft/semantic-kernel/issues/13128
// - https://github.com/router-for-me/CLIProxyAPI/issues/999
// - https://github.com/openai/openai-agents-python/issues/2020
export const expandPreviousResponseId = async (
  payload: CanonicalOpenAIResponsesPayload,
  store: OpenAIResponsesStatefulStore,
): Promise<CanonicalOpenAIResponsesPayload | { readonly previousResponseNotFound: string }> => {
  const previousResponseId = payload.previous_response_id;
  if (previousResponseId === undefined || previousResponseId === null) return payload;

  const snapshot = await store.loadSnapshot(previousResponseId);
  if (snapshot === null) return { previousResponseNotFound: previousResponseId };

  const { previous_response_id: _previous, ...rest } = payload;
  return {
    ...rest,
    input: [
      ...snapshot.itemIds.map(id => ({ type: 'item_reference' as const, id })),
      ...payload.input,
    ],
  };
};
