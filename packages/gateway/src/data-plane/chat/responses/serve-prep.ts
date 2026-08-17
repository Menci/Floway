import type { StatefulResponsesStore } from './items/store.ts';
import type { CanonicalResponsesPayload } from '@floway-dev/protocols/responses';

// Thrown when a request names a `previous_response_id` that the store cannot
// resolve. The HTTP/WS entry layer catches this and renders the OpenAI-shaped
// 400 body verbatim — clients (codex) compare it byte-for-byte against
// upstream OpenAI's `previous_response_not_found` envelope, so the rendering
// stays at the entry boundary instead of being folded into the generic
// ChatServeFailure renderer.
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
// `previous_response_id`, so this prep runs in serve and not in attempt.
export const expandPreviousResponseId = async (
  payload: CanonicalResponsesPayload,
  store: StatefulResponsesStore,
): Promise<CanonicalResponsesPayload> => {
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
