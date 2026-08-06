import {
  UpstreamGenerationMismatchError,
  UpstreamKindMismatchError,
  type UpstreamRecord,
  type UpstreamStateWriteGuard,
} from '@floway-dev/provider';

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

const sameJsonValue = (left: unknown, right: unknown): boolean =>
  JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));

// Provider tests replace the storage repository with in-process doubles. A
// double that runs the mutator without the production CAS guard makes a
// credential-generation race impossible to reproduce, so every such double
// validates the same provider/config preconditions before applying a write.
export const assertUpstreamStateWriteGuard = (
  upstream: UpstreamRecord,
  guard: UpstreamStateWriteGuard,
): void => {
  if (upstream.kind !== guard.kind) {
    throw new UpstreamKindMismatchError(upstream.id, guard.kind, upstream.kind);
  }
  if (guard.config !== undefined && !sameJsonValue(upstream.config, guard.config)) {
    throw new UpstreamGenerationMismatchError(upstream.id);
  }
};
