export interface InputErrorDetails {
  readonly message: string;
  readonly param?: string;
  readonly code?: string;
}

export const inputErrorFields = (error: InputErrorDetails): Record<string, unknown> | undefined => {
  const fields = {
    ...(error.param === undefined ? {} : { param: error.param }),
    ...(error.code === undefined ? {} : { code: error.code }),
  };
  return Object.keys(fields).length === 0 ? undefined : fields;
};
