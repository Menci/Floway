// Persisted ProviderModel rows contain code-derived metadata as well as the
// upstream response. Increment this whenever that derived catalog contract or
// its serialization changes so older rows become cold across deployments.
export const MODEL_CATALOG_REVISION = 12;

export const MAX_STORED_MODEL_ERROR_LENGTH = 16_384;

export const storedModelErrorMessage = (message: string): string => message.length > MAX_STORED_MODEL_ERROR_LENGTH
  ? `${message.slice(0, MAX_STORED_MODEL_ERROR_LENGTH - 1)}…`
  : message;
