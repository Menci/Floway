// Per-upstream model name prefix. When set, a routing layer can address the
// upstream's models in two forms — bare id (e.g. "gpt-4o") and prefix-qualified
// (e.g. "openrouter/gpt-4o") — and the listing layer can publish either or
// both. The shape is generic across providers; the registry honors it.
//
// `addressable` is what the data plane accepts on inbound requests; `listed`
// (always a subset of addressable) is what /v1/models surfaces. Splitting the
// two lets an operator publish a single canonical form while still accepting
// the prefixed form during a migration, or vice versa.

export type AddressableForm = 'unprefixed' | 'prefixed';

export interface ModelPrefixConfig {
  prefix: string;
  addressable: AddressableForm[];
  listed: AddressableForm[];
}

// Matches a prefix string built from path segments of valid id characters,
// separated by single slashes, and terminated by exactly one trailing slash.
// Examples:
//   `openrouter/`        — one segment
//   `vendor/sub/region/` — three segments
// Empty segments (`vendor//`, `a//b/`) are barred because no model id of any
// upstream we care about uses them, and matching them as a prefix would
// silently consume an unintended portion of an inbound id.
export const MODEL_PREFIX_REGEX = /^[a-zA-Z0-9._-]+(\/[a-zA-Z0-9._-]+)*\/$/;

// Caps the operator-controlled prefix length. The data plane runs
// `modelId.startsWith(prefix)` on every prefixed-addressable upstream per
// request, so a degenerate kilobytes-long prefix would waste cycles for no
// product benefit. 64 is generous for human-readable disambiguators
// ("openrouter/", "vendor/sub/region/", etc.) and the boundary catches obvious
// paste mistakes early.
export const MODEL_PREFIX_MAX_LENGTH = 64;

const FORM_ORDER: readonly AddressableForm[] = ['unprefixed', 'prefixed'];

// Validate every element is a known AddressableForm, then return a canonical
// (deduped, ordered) array. Silently dropping unknown members would mask a
// malformed import payload — `addressable: ['foo']` would normalize to `[]`
// and surface as `addressable must be non-empty`, which hides the real fault.
const canonicalForms = (input: unknown, fieldName: string): AddressableForm[] => {
  if (!Array.isArray(input)) {
    throw new Error(`modelPrefix.${fieldName} must be an array`);
  }
  for (const item of input) {
    if (item !== 'unprefixed' && item !== 'prefixed') {
      throw new Error(`modelPrefix.${fieldName} entry must be 'unprefixed' or 'prefixed', got ${JSON.stringify(item)}`);
    }
  }
  const set = new Set(input as AddressableForm[]);
  return FORM_ORDER.filter(f => set.has(f));
};

export const normalizeModelPrefix = (input: unknown): ModelPrefixConfig | null => {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'object') throw new Error('modelPrefix must be an object or null');
  const raw = input as { prefix?: unknown; addressable?: unknown; listed?: unknown };

  if (typeof raw.prefix !== 'string' || !MODEL_PREFIX_REGEX.test(raw.prefix)) {
    throw new Error('modelPrefix.prefix is invalid');
  }
  if (raw.prefix.length > MODEL_PREFIX_MAX_LENGTH) {
    throw new Error(`modelPrefix.prefix must be at most ${MODEL_PREFIX_MAX_LENGTH} characters`);
  }
  const addressable = canonicalForms(raw.addressable, 'addressable');
  const listed = canonicalForms(raw.listed, 'listed');
  if (addressable.length === 0) throw new Error('modelPrefix.addressable must be non-empty');
  const addressableSet = new Set(addressable);
  for (const form of listed) {
    if (!addressableSet.has(form)) {
      throw new Error(`modelPrefix.listed entry '${form}' is not in modelPrefix.addressable`);
    }
  }
  return { prefix: raw.prefix, addressable, listed };
};
