// Canonical JSON encoding for upstream rows. Key order is sorted recursively so
// a row's stored text is a function of its data alone: two writes of the same
// object produce the same bytes, which is what lets `saveState` recognize a
// mutator that changed nothing and skip the write. config_json shares the
// encoder for symmetry.

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

// state_json is nullable; null/undefined collapse to SQL NULL.
export const serializeStoredState = (value: unknown): string | null =>
  value === null || value === undefined ? null : JSON.stringify(canonicalize(value));

// config_json is NOT NULL; an absent value is stored as the JSON literal `null`.
export const serializeStoredConfig = (value: unknown): string =>
  JSON.stringify(canonicalize(value === undefined ? null : value));
