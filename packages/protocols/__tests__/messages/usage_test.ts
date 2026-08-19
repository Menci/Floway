import { expect, test } from 'vitest';

import { mergeMessagesUsageSnapshot, messagesUsageSnapshot, splitMessagesCacheCreationTokens } from '../../src/messages/usage.ts';

test.each([
  [{ cache_creation_input_tokens: 9 }, { cacheWrite: 9, cacheWrite1h: 0 }],
  [{ cache_creation_input_tokens: 9, cache_creation: {} }, { cacheWrite: 9, cacheWrite1h: 0 }],
  [{ cache_creation_input_tokens: 9, cache_creation: { ephemeral_1h_input_tokens: 5 } }, { cacheWrite: 4, cacheWrite1h: 5 }],
  [{ cache_creation_input_tokens: 9, cache_creation: { ephemeral_5m_input_tokens: 4 } }, { cacheWrite: 4, cacheWrite1h: 5 }],
  [{ cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 5 } }, { cacheWrite: 4, cacheWrite1h: 5 }],
])('Messages cache creation splits partial TTL detail %#', (usage, expected) => {
  expect(splitMessagesCacheCreationTokens(usage)).toEqual(expected);
});

test('Messages cache creation rejects inconsistent totals', () => {
  expect(() => splitMessagesCacheCreationTokens({
    cache_creation_input_tokens: 9,
    cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 6 },
  })).toThrowError('must sum');
  expect(() => splitMessagesCacheCreationTokens({
    cache_creation_input_tokens: 4,
    cache_creation: { ephemeral_1h_input_tokens: 5 },
  })).toThrowError('exceed');
});

test('Messages usage snapshots merge late counters and atomically replace the tier pair', () => {
  const start = messagesUsageSnapshot({
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 9,
    speed: 'fast',
  });
  expect(mergeMessagesUsageSnapshot(start, {
    input_tokens: 11,
    output_tokens: 2,
    cache_creation: { ephemeral_1h_input_tokens: 5 },
    service_tier: 'priority',
  })).toEqual({
    input_tokens: 11,
    output_tokens: 2,
    cache_creation_input_tokens: 9,
    cache_creation: { ephemeral_1h_input_tokens: 5 },
    speed: undefined,
    service_tier: 'priority',
  });
});

test('Messages usage snapshots read an upstream null counter as an absent counter', () => {
  expect(messagesUsageSnapshot({
    input_tokens: null,
    output_tokens: 2,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    cache_creation: null,
    output_tokens_details: null,
    service_tier: null,
    speed: null,
  })).toEqual({ output_tokens: 2 });
});

test('Messages cache creation splits usage whose upstream reported no cache buckets', () => {
  expect(splitMessagesCacheCreationTokens(messagesUsageSnapshot({
    output_tokens: 2,
    cache_creation_input_tokens: null,
    cache_creation: null,
  }))).toEqual({ cacheWrite: 0, cacheWrite1h: 0 });
});

test('Messages usage snapshots keep counters a later null does not restate', () => {
  const start = messagesUsageSnapshot({
    input_tokens: 11,
    output_tokens: 0,
    cache_creation_input_tokens: 9,
    cache_read_input_tokens: 4,
    output_tokens_details: { thinking_tokens: 3 },
  });
  expect(mergeMessagesUsageSnapshot(start, {
    input_tokens: null,
    output_tokens: 2,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    output_tokens_details: null,
  })).toEqual({
    input_tokens: 11,
    output_tokens: 2,
    cache_creation_input_tokens: 9,
    cache_read_input_tokens: 4,
    output_tokens_details: { thinking_tokens: 3 },
  });
});

test('Messages usage snapshots keep the served tier a later null does not restate', () => {
  const start = messagesUsageSnapshot({ output_tokens: 0, speed: 'fast' });
  expect(mergeMessagesUsageSnapshot(start, { output_tokens: 2, speed: null, service_tier: null }))
    .toEqual({ output_tokens: 2, speed: 'fast' });
  expect(mergeMessagesUsageSnapshot(start, { output_tokens: 2, speed: null, service_tier: 'standard' }))
    .toEqual({ output_tokens: 2, speed: undefined, service_tier: 'standard' });
});

test('Messages usage snapshots preserve nullable iterations and isolate all nested iteration data', () => {
  expect(messagesUsageSnapshot({ output_tokens: 0, iterations: null })).toEqual({ output_tokens: 0, iterations: null });

  const source = [{
    type: 'compaction',
    input_tokens: 7,
    cache_creation: { ephemeral_5m_input_tokens: 3 },
    provider_metadata: {
      attempts: [{ regions: ['us-east', 'us-west'] }],
    },
  }];
  const snapshot = messagesUsageSnapshot({ output_tokens: 0, iterations: source });
  source[0].cache_creation.ephemeral_5m_input_tokens = 9;
  source[0].provider_metadata.attempts[0].regions.push('eu-west');

  expect(snapshot.iterations).toEqual([{
    type: 'compaction',
    input_tokens: 7,
    cache_creation: { ephemeral_5m_input_tokens: 3 },
    provider_metadata: {
      attempts: [{ regions: ['us-east', 'us-west'] }],
    },
  }]);
  expect(mergeMessagesUsageSnapshot(snapshot, { output_tokens: 1, iterations: null }).iterations).toBeNull();
});

test('Messages usage snapshot merges isolate opaque nested iteration data from the delta', () => {
  const iterations = [{
    type: 'model',
    provider_metadata: {
      attempts: [{ warnings: ['slow'] }],
    },
  }];
  const merged = mergeMessagesUsageSnapshot({ output_tokens: 0 }, { output_tokens: 1, iterations });
  iterations[0].provider_metadata.attempts[0].warnings[0] = 'mutated';

  expect(merged.iterations).toEqual([{
    type: 'model',
    provider_metadata: {
      attempts: [{ warnings: ['slow'] }],
    },
  }]);
});
