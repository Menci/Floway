import { test } from 'vitest';

import { emptyKnownModels, mergeKnownModels, projectKnownModels, type CopilotKnownModels } from '../src/known-models.ts';
import type { CopilotModelsResponse, CopilotRawModel } from '../src/types.ts';
import { assertEquals } from '@floway-dev/test-utils';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const model = (id: string): CopilotRawModel => ({ id, name: id, version: '1' });
const response = (...ids: string[]): CopilotModelsResponse => ({ object: 'list', data: ids.map(model) });

test('emptyKnownModels returns a known-models view with no models and fetchedAt 0', () => {
  const knownModels = emptyKnownModels();
  assertEquals(knownModels.fetchedAt, 0);
  assertEquals(Object.keys(knownModels.models).length, 0);
});

test('mergeKnownModels seeds an empty view with every model in the response', () => {
  const merged = mergeKnownModels(emptyKnownModels(), response('a', 'b'), 1_000_000);
  assertEquals(merged.fetchedAt, 1_000_000);
  assertEquals(Object.keys(merged.models).sort(), ['a', 'b']);
  assertEquals(merged.models.a.lastSeenAt, 1_000_000);
});

test('mergeKnownModels preserves previously-seen models that are missing this fetch', () => {
  const prev: CopilotKnownModels = {
    fetchedAt: 1_000_000,
    models: {
      a: { snapshot: model('a'), lastSeenAt: 1_000_000 },
      b: { snapshot: model('b'), lastSeenAt: 1_000_000 },
    },
  };
  const merged = mergeKnownModels(prev, response('a'), 1_000_000 + HOUR);
  assertEquals(Object.keys(merged.models).sort(), ['a', 'b']);
  assertEquals(merged.models.a.lastSeenAt, 1_000_000 + HOUR);
  assertEquals(merged.models.b.lastSeenAt, 1_000_000, 'missing model keeps its old lastSeenAt');
});

test('mergeKnownModels drops models whose lastSeenAt is older than 24 h', () => {
  const prev: CopilotKnownModels = {
    fetchedAt: 1_000_000,
    models: {
      stale: { snapshot: model('stale'), lastSeenAt: 1_000_000 },
      fresh: { snapshot: model('fresh'), lastSeenAt: 1_000_000 + HOUR },
    },
  };
  const merged = mergeKnownModels(prev, response(), 1_000_000 + DAY + 1);
  assertEquals(Object.keys(merged.models).sort(), ['fresh']);
});

test('mergeKnownModels refreshes snapshot data when the model reappears', () => {
  const prev: CopilotKnownModels = {
    fetchedAt: 1_000_000,
    models: { a: { snapshot: { ...model('a'), name: 'old' }, lastSeenAt: 1_000_000 } },
  };
  const response: CopilotModelsResponse = {
    object: 'list',
    data: [{ ...model('a'), name: 'new' }],
  };
  const merged = mergeKnownModels(prev, response, 1_000_000 + HOUR);
  assertEquals(merged.models.a.snapshot.name, 'new');
});

test('projectKnownModels returns only entries within the 24 h window', () => {
  const knownModels: CopilotKnownModels = {
    fetchedAt: 1_000_000,
    models: {
      stale: { snapshot: model('stale'), lastSeenAt: 1_000_000 },
      fresh: { snapshot: model('fresh'), lastSeenAt: 1_000_000 + HOUR },
    },
  };
  const projected = projectKnownModels(knownModels, 1_000_000 + DAY + 1);
  assertEquals(projected.length, 1);
  assertEquals(projected[0].id, 'fresh');
});
