import { describe, expect, it } from 'vitest';

import type { ControlPlaneModel, UpstreamRecord } from '../../../src/api/types';
import { eligibleSearchUpstreams } from '../../../src/components/search/eligibility';

describe('OpenAI search passthrough eligibility', () => {
  it('keeps only enabled Codex or Custom upstreams with chat models', () => {
    const upstreams = [
      { id: 'codex', kind: 'codex', enabled: true },
      { id: 'custom', kind: 'custom', enabled: false },
      { id: 'ollama', kind: 'ollama', enabled: true },
    ] as UpstreamRecord[];
    const models = [{
      id: 'gpt-5', kind: 'chat', upstreams: [{ id: 'codex', kind: 'codex', name: 'Codex', hue: 210 }],
    }] as ControlPlaneModel[];
    expect(eligibleSearchUpstreams(upstreams, models).map(upstream => upstream.id)).toEqual(['codex']);
  });
});
