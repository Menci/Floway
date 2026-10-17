import { ThinReference, type ReferencePart } from '../../src/round-trip/thin/reference.ts';
import { rawJSON } from '../../src/shared/json/raw-json.ts';
import type { TranslateSidecarCodec } from '../../src/types.ts';

const scopes = new Map<string, Map<string, unknown>>();
let nextHandle = 0;
const snapshot = (value: unknown): unknown => {
  if (value instanceof ThinReference) return new ThinReference(value.restoration, value.parts.map((part): ReferencePart =>
    typeof part === 'number' ? part : [part[0], part[1], part[2]]));
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  if (Array.isArray(value)) return value.map(snapshot);
  if (typeof value === 'object' && value !== null && !rawJSON.isRawJSON(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, snapshot(child)]));
  }
  return value;
};

export const createTestSidecarCodec = (scope = 'test-codec-scope'): TranslateSidecarCodec => {
  let values = scopes.get(scope);
  if (values === undefined) { values = new Map(); scopes.set(scope, values); }
  const store = values;
  return {
    encode: async payload => {
      if (payload === undefined) throw new TypeError('Sidecar payload must not be undefined');
      const handle = `sidecar-${nextHandle++}`;
      store.set(handle, snapshot(payload));
      return handle;
    },
    decode: async handle => snapshot(store.get(handle)),
  };
};
