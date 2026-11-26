import { describe, expect, it } from 'vitest';

import { buildDisabledModelOptions } from '../../../src/components/upstream-editor/config-sidebar';
import type { UpstreamModelConfig } from '@floway-dev/upstream/browser';

const model = (upstreamModelId: string, publicModelId?: string): UpstreamModelConfig => ({
  upstreamModelId,
  ...(publicModelId === undefined ? {} : { publicModelId }),
  kind: 'chat',
  endpoints: { openaiChatCompletions: {} },
});

describe('disabled model options', () => {
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
});
