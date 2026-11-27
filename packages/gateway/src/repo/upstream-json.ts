// Canonical JSON encoding for stored gateway rows. Object keys and Set entries
// are sorted recursively so two writes of the same logical data produce the
// exact same bytes. That lets `saveState` detect no-op mutations and lets
// conditional UPSERTs in `upstream_models` skip unchanged rows.

export const canonicalizeStoredJson = (value: unknown): unknown => {
  if (value instanceof Set) {
    return [...value].map(canonicalizeStoredJson).toSorted();
  }
  if (Array.isArray(value)) return value.map(canonicalizeStoredJson);
  if (value !== null && typeof value === 'object') {
    const entries: [string, unknown][] = [];
    for (const key of Object.keys(value as Record<string, unknown>).toSorted()) {
      const entryValue = (value as Record<string, unknown>)[key];
      if (entryValue !== undefined) {
        entries.push([key, canonicalizeStoredJson(entryValue)]);
      }
    }
    return Object.fromEntries(entries);
  }
  return value;
};

// state_json is nullable; null/undefined collapse to SQL NULL.
export const serializeStoredState = (value: unknown): string | null =>
  value === null || value === undefined ? null : JSON.stringify(canonicalizeStoredJson(value));

// config_json is NOT NULL; an absent value is stored as the JSON literal `null`.
export const serializeStoredConfig = (value: unknown): string =>
  JSON.stringify(canonicalizeStoredJson(value === undefined ? null : value));
