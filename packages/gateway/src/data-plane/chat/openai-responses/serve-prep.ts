import type { StatefulOpenAIResponsesStore } from './items/store.ts';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';

// Thrown when a request names a `previous_response_id` that the store cannot
// resolve. The stage that hydrates catches this and answers with the
// OpenAI-shaped 400 body verbatim — clients (codex) compare it byte-for-byte
// against upstream OpenAI's `previous_response_not_found` envelope, so what
// they read is the upstream's own wording rather than this gateway's.
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

// Stitches a previous turn's snapshot items in front of this turn's input,
// then drops `previous_response_id` from the payload (the snapshot id is a
// gateway concept and never reaches the upstream wire). Native-entry only:
// translated payloads coming in from another protocol's attempt never carry
// `previous_response_id`, so this runs above the fork and never on a wire.
export const expandPreviousResponseId = async (
  payload: CanonicalOpenAIResponsesPayload,
  store: StatefulOpenAIResponsesStore,
): Promise<CanonicalOpenAIResponsesPayload> => {
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
