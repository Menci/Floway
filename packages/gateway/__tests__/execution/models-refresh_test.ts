import { expect, test } from 'vitest';

import { modelsRefreshTarget, refreshModels, refreshModelsExplicit } from '../../src/execution/models-refresh.ts';
import { saveUpstreamForTest } from '../repo/upstreams.ts';
import { buildCustomUpstreamRecord, setupAppTest } from '../test-utils/app.ts';
import type { ModelPricing } from '@floway-dev/protocols/common';
import { pricingForCodexModelKey } from '@floway-dev/provider-codex';
import { assertCustomUpstreamRecord } from '@floway-dev/provider-custom';
import { jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

test.each([false, true])('Custom refresh keeps reference pricing out of discovered models (fetch=%s)', async modelsFetchEnabled => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  const upstream = assertCustomUpstreamRecord(buildCustomUpstreamRecord());
  const upstreamPricing: ModelPricing = { entries: [{ rates: { input_tokens: '0.000001' } }] };
  const manualPricing: ModelPricing = { entries: [{ rates: { input_tokens: '0' } }] };
  const record = {
    ...upstream,
    config: {
      ...upstream.config,
      useOfficialPricing: true,
      modelsFetch: { enabled: modelsFetchEnabled },
      models: [
        { upstreamModelId: 'gpt-5.4', publicModelId: 'alias', kind: 'chat', endpoints: { openaiChatCompletions: {} } },
        { upstreamModelId: 'gpt-5.4-mini', kind: 'chat', endpoints: { openaiChatCompletions: {} } },
        { upstreamModelId: 'gpt-5.5', kind: 'chat', endpoints: { openaiChatCompletions: {} }, pricing: manualPricing },
      ],
    },
  };
  const response = {
    data: [{ id: 'gpt-5.4' }, { id: 'gpt-5.4-mini', pricing: upstreamPricing }, { id: 'gpt-5.5', pricing: upstreamPricing }],
  };
  const referencePricing = pricingForCodexModelKey('gpt-5.4');
  const fallbackPricing = pricingForCodexModelKey('gpt-5.4-mini');
  expect(referencePricing).not.toBeNull();
  expect(fallbackPricing).not.toBeNull();
  const effectivePricing = [referencePricing, modelsFetchEnabled ? upstreamPricing : fallbackPricing, manualPricing];

  let fetchCalls = 0;
  await withMockedFetch(() => {
    fetchCalls++;
    return jsonResponse(response);
  }, async () => {
    await saveUpstreamForTest(repo.upstreams, record);
    const stored = (await repo.upstreams.getById(record.id))!;
    const target = modelsRefreshTarget(stored);
    const automatic = await refreshModels(target, null);
    if (automatic.kind !== 'discovered') throw new Error('Automatic refresh did not run');
    expect(automatic.publication).toBe('published');
    expect(fetchCalls).toBe(modelsFetchEnabled ? 1 : 0);
    expect((await repo.upstreams.getById(record.id))?.modelsCache?.models.map(model => model.pricing))
      .toEqual(effectivePricing);

    const explicit = await refreshModelsExplicit(target, null);
    if (explicit.kind !== 'discovered') throw new Error('Explicit discovery did not run');
    expect(explicit.publication).toBe('published');
    expect(explicit.discovered?.map(model => model.pricing)).toEqual([undefined, upstreamPricing, upstreamPricing]);
    expect(fetchCalls).toBe(modelsFetchEnabled ? 2 : 1);
    const cached = (await repo.upstreams.getById(record.id))?.modelsCache;
    expect(cached?.discovered).toEqual(explicit.discovered);
    expect(cached?.models.map(model => model.pricing)).toEqual(effectivePricing);
  });
});
