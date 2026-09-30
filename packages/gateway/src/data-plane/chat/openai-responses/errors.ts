import type { ChatServeFailure } from '../shared/errors.ts';
import { toInternalDebugError } from '@floway-dev/provider';

/** The chat-wide refusals plus the one only this protocol can make: a turn that named an item
 *  by id which the store cannot resolve. It is thrown from inside the membrane's hydration
 *  rather than returned, because hydration walks the input and the item that is missing is
 *  found several frames below where the answer is written. */
export type OpenAIResponsesServeFailure = ChatServeFailure | { readonly kind: 'item-not-found'; readonly itemId: string };

export const internalErrorEnvelope = (error: unknown) => {
  const debug = toInternalDebugError(error);
  return {
    error: {
      type: debug.type,
      name: debug.name,
      message: debug.message,
      stack: debug.stack,
      cause: debug.cause,
      target_api: debug.target_api,
    },
  };
};
