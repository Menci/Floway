// Canonical JSON encoding for persisted rows and structural keys. Key order is
// sorted recursively so equal JSON data always produces equal bytes. Upstream
// config/state writes use that property to recognize no-op mutations; model
// resolution uses it to compare alias rules without a quadratic deep-equality
// walk.

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .toSorted()
        .map(key => [key, canonicalize((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
};

export const serializeCanonicalJson = (value: unknown): string => {
  const serialized = JSON.stringify(canonicalize(value));
  if (serialized === undefined) throw new TypeError('Value is not JSON-serializable');
  return serialized;
};

// state_json is nullable; null/undefined collapse to SQL NULL.
export const serializeStoredState = (value: unknown): string | null =>
  value === null || value === undefined ? null : serializeCanonicalJson(value);

// config_json is NOT NULL; an absent value is stored as the JSON literal `null`.
export const serializeStoredConfig = (value: unknown): string =>
  serializeCanonicalJson(value === undefined ? null : value);
