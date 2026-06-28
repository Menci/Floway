// Failures a protocol can render before reaching an upstream; unexpected
// throws bubble as-is. `failedUpstreams` on model-{missing,unsupported}
// carries the upstream names whose catalog fetch threw during this
// resolution — surfaced parenthetically so the caller can tell a genuine
// "no upstream has this model" miss from a transient outage where the
// upstream that owns the model is currently unreachable. Empty means
// every consulted upstream returned a catalog.
export type ChatServeFailure =
  | { readonly kind: 'model-missing'; readonly model: string; readonly failedUpstreams: readonly string[] }
  | { readonly kind: 'model-unsupported'; readonly model: string; readonly failedUpstreams: readonly string[] }
  | { readonly kind: 'item-not-found'; readonly itemId: string }
  | { readonly kind: 'routing-unavailable'; readonly message: string };

class ChatServeFailureError extends Error {
  readonly failure: ChatServeFailure;

  constructor(failure: ChatServeFailure) {
    super(`ChatServeFailure: ${failure.kind}`);
    this.failure = failure;
  }
}

export const throwChatServeFailure = (failure: ChatServeFailure): never => {
  throw new ChatServeFailureError(failure);
};

export const tryCatchChatServeFailure = (error: unknown): ChatServeFailure | null =>
  error instanceof ChatServeFailureError ? error.failure : null;

// Builds the failure value every serve dispatches with after `canServe` has
// dropped every candidate: `sawModel=true` means the inbound id exists in
// some upstream's catalog but no upstream wire reaches it for this protocol,
// rendered as 400 model-unsupported; `sawModel=false` means no upstream knows
// the id at all, rendered as 404 model-missing. The per-protocol failure
// renderer turns the value into its own envelope shape.
export const noViableCandidateFailure = (
  sawModel: boolean,
  model: string,
  failedUpstreams: readonly string[],
): ChatServeFailure =>
  sawModel
    ? { kind: 'model-unsupported', model, failedUpstreams }
    : { kind: 'model-missing', model, failedUpstreams };
