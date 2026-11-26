import { expect, it } from 'vitest';

import { normalizeUpstreamMetricIdentity, upstreamMetricIdentityKey } from '../src/upstream-metric-identity.ts';

it('sorts flat labels and preserves prototype-like names as data properties', () => {
  const labels = Object.fromEntries([['z', 1], ['__proto__', 'prototype'], ['constructor', true], ['a', null]]);
  const identity = normalizeUpstreamMetricIdentity('metric', labels);
  expect(Object.keys(identity.labels)).toEqual(['__proto__', 'a', 'constructor', 'z']);
  expect(Object.hasOwn(identity.labels, '__proto__')).toBe(true);
  expect(identity.labels.__proto__).toBe('prototype');
  expect(upstreamMetricIdentityKey(identity)).toBe('["metric",{"__proto__":"prototype","a":null,"constructor":true,"z":1}]');
  const reordered = Object.fromEntries([['constructor', true], ['a', null], ['z', 1], ['__proto__', 'prototype']]);
  expect(upstreamMetricIdentityKey({ name: 'metric', labels: reordered })).toBe(upstreamMetricIdentityKey(identity));
});

it('rejects nested, missing, and nonfinite label values', () => {
  for (const labels of [[], { nested: {} }, { missing: undefined }, { infinite: Infinity }]) {
    expect(() => normalizeUpstreamMetricIdentity('metric', labels as never)).toThrow(TypeError);
  }
});
