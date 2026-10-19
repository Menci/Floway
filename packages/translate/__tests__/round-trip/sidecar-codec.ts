import { klona } from 'klona/json';

import { rawJSON } from '../../src/shared/json/raw-json.ts';
import type { SidecarCodec } from '../../src/types.ts';

const scopes = new Map<string, Map<string, unknown>>();
let nextHandle = 0;
const copyBytes = (value: unknown): unknown => {
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  if (Array.isArray(value)) return value.map(copyBytes);
  if (typeof value === 'object' && value !== null && !rawJSON.isRawJSON(value)) {
    for (const [key, child] of Object.entries(value)) Reflect.set(value, key, copyBytes(child));
  }
  return value;
};
const snapshot = (value: unknown): unknown => copyBytes(klona(value));

export const createTestSidecarCodec = (scope = 'test-codec-scope'): SidecarCodec => {
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
