import { describe, expect, it } from 'vitest';

import { applyLocalAgentSetupChanges, blankAgentSetupDraft } from '../../../src/components/api-keys/agent-setup';

describe('pre-lease Agent Setup edits', () => {
  it('applies only fields changed from the local baseline', () => {
    const baseline = blankAgentSetupDraft();
    const local = structuredClone(baseline);
    local.claudeCode.defaultOpusModel = 'claude-opus-custom';
    local.omp.model = 'local-omp';
    const server = { ...blankAgentSetupDraft(), apiKeyId: 'key-1' };
    server.claudeCode.model = 'server-default';
    server.codex.model = 'server-codex';

    expect(applyLocalAgentSetupChanges(server, local, baseline)).toMatchObject({
      apiKeyId: 'key-1',
      claudeCode: { model: 'server-default', defaultOpusModel: 'claude-opus-custom' },
      codex: { model: 'server-codex' },
      omp: { model: 'local-omp' },
    });
  });
});
