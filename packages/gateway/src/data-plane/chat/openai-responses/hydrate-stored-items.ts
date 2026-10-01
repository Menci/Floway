import type { Fields } from './facts.ts';
import type { ChatServices } from '../services.ts';
import type { OpenAIResponsesServeFailure } from './errors.ts';
import { hydrateOpenAIResponsesPayload } from './items/hydrate.ts';
import { expandPreviousResponseId, PreviousResponseNotFoundError } from './serve-prep.ts';
import { tryCatchChatServeFailure } from '../shared/errors.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';

/** A refusal the membrane makes on its own, in the shape every other refusal in this chain
 *  takes: an empty billed set and empty headers are what "no upstream was called" looks like
 *  on those two keys, and the envelope is what an OpenAI client reads. */
const refuseStoredItems = (
  status: number,
  message: string,
  extra: { readonly param: string; readonly code: string | null },
): Fields<'response.chat.openaiResponses' | 'response.chat.openaiResponses.streamedUsage' | 'response.usage.billable' | 'response.http.headers' | 'response.http.body' | 'response.http.status'> => ({
  'response.usage.billable': [],
  'response.http.headers': [],
  'response.http.body': null, 'response.http.status': status,
  'response.chat.openaiResponses.streamedUsage': null,
  'response.chat.openaiResponses': {
    status,
    message,
    envelope: { error: { message, type: 'invalid_request_error', ...extra } },
  },
});

/**
 * The stored-items membrane, on the way in.
 *
 * Three things, in an order the store fixes. A `previous_response_id` becomes the snapshot's
 * items in front of this turn's input, and the id itself never reaches a wire — it names
 * something only this gateway holds. Every item the turn now names is read back out of the
 * store, so an item the client echoed by id is sent as the row we stored rather than as the
 * client's copy of it, and whatever server-only state that row carried comes back with it.
 * Then the items this turn *adds* are staged, so the snapshot the next turn continues from
 * holds them alongside the history it inherited.
 *
 * It sits above the resolver because everything after it routes on the result: the payload
 * affinity reads is the hydrated one, and a turn whose continuation does not resolve has
 * nowhere to be routed to. Both of its refusals are answers it already holds, which is why
 * it carries the `return` trait alongside `through`.
 */
export const hydrateStoredItems = defineStage<
  Fields<'request.chat.openaiResponses'>,
  Fields<'request.chat.openaiResponses' | 'request.chat.openaiResponses.privatePayloads'>,
  Record<string, never>,
  Record<string, never>,
  Fields<'response.chat.openaiResponses' | 'response.chat.openaiResponses.streamedUsage' | 'response.usage.billable' | 'response.http.headers' | 'response.http.body' | 'response.http.status'>,
  ChatServices
>({
  name: 'hydrateStoredItems',
  through: {
    request: {
      needs: ['request.chat.openaiResponses'],
      consumes: [],
      provides: ['request.chat.openaiResponses', 'request.chat.openaiResponses.privatePayloads'],
    },
    response: { needs: [], consumes: [], provides: [] },
  },
  return: {
    provides: [
      'response.chat.openaiResponses',
      'response.chat.openaiResponses.streamedUsage',
      'response.usage.billable',
      'response.http.headers', 'response.http.body', 'response.http.status',
    ],
  },
  execute: async (facts, next, use) => {
    const store = use.gateway.store;
    // The key holds what a client may send, whose `input` is a string or a list; this chain
    // runs on the canonical form the entry normalized it to.
    const asked = facts['request.chat.openaiResponses'] as CanonicalOpenAIResponsesPayload;

    let expanded: CanonicalOpenAIResponsesPayload;
    try {
      expanded = await expandPreviousResponseId(asked, store);
    } catch (error) {
      if (!(error instanceof PreviousResponseNotFoundError)) throw error;
      // OpenAI's own words for a continuation that does not resolve, byte for byte: Codex
      // compares this body against upstream's. See the cross-references on
      // `PreviousResponseNotFoundError`.
      return move({
        ...facts,
        ...refuseStoredItems(400, error.message, { param: 'previous_response_id', code: 'previous_response_not_found' }),
      });
    }

    // Both lists: what the turn now names is read by id, and what the client itself sent is
    // read by item hash as well, so a body repeated verbatim finds the row it already made.
    await store.loadInputItems(expanded.input, asked.input);

    let hydrated: ReturnType<typeof hydrateOpenAIResponsesPayload>;
    try {
      hydrated = hydrateOpenAIResponsesPayload(expanded, store);
    } catch (error) {
      const failure = tryCatchChatServeFailure<OpenAIResponsesServeFailure>(error);
      if (failure?.kind !== 'item-not-found') throw error;
      return move({
        ...facts,
        ...refuseStoredItems(404, `Item with id '${failure.itemId}' not found.`, { param: 'input', code: null }),
      });
    }

    // The client's own input, not the expansion's `item_reference` prefix: the prefix is
    // already in the snapshot this turn inherited, and staging it again would repeat it.
    await store.stageInputItems(asked.input);

    return await next({
      ...facts,
      'request.chat.openaiResponses': move(hydrated.payload),
      'request.chat.openaiResponses.privatePayloads': move([...hydrated.privatePayloads]),
    });
  },
});
