import { describe, expect, it } from 'vitest';

import { buildDisabledModelOptions } from '../../../src/components/upstream-editor/config-sidebar';
import type { UpstreamModelConfig } from '@floway-dev/provider/browser';

const model = (upstreamModelId: string, publicModelId?: string): UpstreamModelConfig => ({
  upstreamModelId,
  ...(publicModelId === undefined ? {} : { publicModelId }),
  kind: 'chat',
  endpoints: { openaiChatCompletions: {} },
});

describe('disabled model options', () => {
  it('labels catalog models by display name while retaining their routing id', () => {
    expect(buildDisabledModelOptions([{ ...model('kimi-for-coding', 'kimi-k2.8-preview'), display_name: 'Kimi K2.8 Preview' }], [], [], true))
      .toEqual([{ id: 'kimi-k2.8-preview', label: 'Kimi K2.8 Preview', missing: false }]);
  });
  it('combines discovered and manual public ids while retaining stale selections', () => {
    expect(buildDisabledModelOptions(
      [model('wire-b', 'public-b')],
      [model('manual-a')],
      ['public-b', 'removed-c'],
      true,
    )).toEqual([
      { id: 'manual-a', label: 'manual-a', missing: false },
      { id: 'public-b', label: 'public-b', missing: false },
      { id: 'removed-c', label: 'removed-c', missing: true },
    ]);
  });

  it('does not call a selection missing when the catalog request failed', () => {
    expect(buildDisabledModelOptions([], [], ['unknown'], false))
      .toEqual([{ id: 'unknown', label: 'unknown', missing: false }]);
  });
});
