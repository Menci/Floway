// Failures a chat protocol makes before it reaches an upstream, as a throw the chain that can
// answer them catches. Unexpected throws bubble as-is.
//
// Almost every refusal is a value on the record — narrowing states its own, and the edge
// renders it. What is left here is the one shape that cannot be: a fault found several frames
// inside a walk, where the answer is written by the stage that started the walk.

/** `routing-unavailable` is what affinity says when a turn carries state for an upstream no
 *  candidate can be routed to. Its message is the caller's to read: only the selection knows
 *  which of the carried targets went missing. */
export type ChatServeFailure = { readonly kind: 'routing-unavailable'; readonly message: string };

class ChatServeFailureError<TFailure extends { readonly kind: string }> extends Error {
  readonly failure: TFailure;

  constructor(failure: TFailure) {
    super(`ChatServeFailure: ${failure.kind}`);
    this.failure = failure;
  }
}

export const throwChatServeFailure = <TFailure extends { readonly kind: string }>(failure: TFailure): never => {
  throw new ChatServeFailureError(failure);
};

export const tryCatchChatServeFailure = <TFailure extends { readonly kind: string } = ChatServeFailure>(error: unknown): TFailure | null =>
  error instanceof ChatServeFailureError ? error.failure as TFailure : null;
