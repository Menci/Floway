import { expect, test } from 'vitest';

import type { FlagId } from '../src/flags.ts';
import { providerModelFacts } from '../src/pipeline.ts';
import { encodeRun, move } from '@floway-dev/pipeline';
import { stubProviderModel } from '@floway-dev/test-utils';

test('provider model facts retain flags as immutable dump content while sharing unchanged metadata', () => {
  const enabledFlags = new Set<FlagId>(['vendor-kimi']);
  const model = stubProviderModel({ enabledFlags, providerData: { id: 'upstream-model' } });
  const snapshot = move(providerModelFacts(model));
  expect(snapshot.limits).toBe(model.limits);
  expect(snapshot.providerData).toBe(model.providerData);
  expect(snapshot.enabledFlags).toEqual(['vendor-kimi']);
  expect(() => (snapshot.enabledFlags as FlagId[]).push('vendor-deepseek')).toThrow();
  enabledFlags.add('vendor-deepseek');
  expect(snapshot.enabledFlags).toEqual(['vendor-kimi']);
  const encoded = encodeRun([{ type: 'stage.entered', stageId: 0, name: 'provider', parentStageId: null, facts: { 'request.provider.model': snapshot } }]);
  expect(JSON.stringify(encoded)).toContain('vendor-kimi');
  expect(JSON.stringify(encoded)).not.toContain('vendor-deepseek');
});
