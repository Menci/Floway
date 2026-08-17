import type { ChatServeFailure } from '../shared/errors.ts';

/** The chat-wide refusals plus the one only this protocol can make: a turn that named an item
 *  by id which the store cannot resolve. It is thrown from inside the membrane's hydration
 *  rather than returned, because hydration walks the input and the item that is missing is
 *  found several frames below where the answer is written. */
export type ResponsesServeFailure = ChatServeFailure | { readonly kind: 'item-not-found'; readonly itemId: string };
