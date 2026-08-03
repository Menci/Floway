import { describe, expect, it } from 'vitest';

import { buildDisabledModelOptions } from '../../../src/components/upstream-editor/config-sidebar';
import type { UpstreamModelConfig } from '@floway-dev/provider';

const model = (upstreamModelId: string, publicModelId?: string): UpstreamModelConfig => ({
  upstreamModelId,
  ...(publicModelId === undefined ? {} : { publicModelId }),
  kind: 'chat',
  endpoints: { chatCompletions: {} },
});

describe('disabled model options', () => {
  it('combines discovered and manual public ids while retaining stale selections', () => {
    expect(buildDisabledModelOptions(
      [model('wire-b', 'public-b')],
      [model('manual-a')],
      ['public-b', 'removed-c'],
      true,
    )).toEqual([
      { id: 'manual-a', missing: false },
      { id: 'public-b', missing: false },
      { id: 'removed-c', missing: true },
    ]);
  });

  it('does not call a selection missing when the catalog request failed', () => {
    expect(buildDisabledModelOptions([], [], ['unknown'], false))
      .toEqual([{ id: 'unknown', missing: false }]);
  });
});
