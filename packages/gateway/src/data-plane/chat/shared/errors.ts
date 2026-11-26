export interface InputErrorDetails {
  readonly message: string;
  readonly param?: string;
  readonly code?: string;
}

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

export const tryCatchChatServeFailure = <TFailure extends { readonly kind: string }>(error: unknown): TFailure | null =>
  error instanceof ChatServeFailureError ? error.failure as TFailure : null;

export const inputErrorFields = (error: InputErrorDetails): Record<string, unknown> | undefined => {
  const fields = {
    ...(error.param === undefined ? {} : { param: error.param }),
    ...(error.code === undefined ? {} : { code: error.code }),
  };
  return Object.keys(fields).length === 0 ? undefined : fields;
};
