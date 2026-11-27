export type ChatRoutingFailure =
  | { readonly kind: 'model-missing'; readonly model: string }
  | { readonly kind: 'model-unsupported'; readonly model: string }
  | { readonly kind: 'routing-unavailable'; readonly message: string };

export interface InputErrorDetails {
  readonly message: string;
  readonly param?: string;
  readonly code?: string;
}

export const noViableCandidateFailure = (
  sawModel: boolean,
  model: string,
): ChatRoutingFailure =>
  sawModel
    ? { kind: 'model-unsupported', model }
    : { kind: 'model-missing', model };

export const inputErrorFields = (error: InputErrorDetails): Record<string, unknown> | undefined => {
  const fields = {
    ...(error.param === undefined ? {} : { param: error.param }),
    ...(error.code === undefined ? {} : { code: error.code }),
  };
  return Object.keys(fields).length === 0 ? undefined : fields;
};
