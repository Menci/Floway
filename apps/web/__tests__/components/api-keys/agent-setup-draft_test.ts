import { describe, expect, it } from 'vitest';

import { applyLocalAgentSetupChanges, blankAgentSetupDraft } from '../../../src/components/api-keys/agent-setup';

describe('pre-lease Agent Setup edits', () => {
  it('applies only fields changed from the local baseline', () => {
    const baseline = blankAgentSetupDraft();
    const local = structuredClone(baseline);
    local.claudeCode.defaultOpusModel = 'claude-opus-custom';
    local.pi.model = 'local-pi';
    local.omp.model = 'local-omp';
    const server = { ...blankAgentSetupDraft(), apiKeyId: 'key-1' };
    server.claudeCode.model = 'server-default';
    server.codex.model = 'server-codex';

    expect(applyLocalAgentSetupChanges(server, local, baseline)).toMatchObject({
      apiKeyId: 'key-1',
      claudeCode: { model: 'server-default', defaultOpusModel: 'claude-opus-custom' },
      codex: { model: 'server-codex' },
      pi: { model: 'local-pi' },
      omp: { model: 'local-omp' },
    });
  });
  it('preserves untouched nested settings from the server while applying local retry edits', () => {
    const baseline = blankAgentSetupDraft();
    const local = structuredClone(baseline);
    local.pi.retry.maxRetries = 4;
    const server = blankAgentSetupDraft();
    server.pi.retry.enabled = false;
    server.omp.retry.maxRetries = 2;
    const merged = applyLocalAgentSetupChanges(server, local, baseline);
    expect(merged.pi.retry).toEqual({ enabled: false, maxRetries: 4 });
    expect(merged.omp.retry).toEqual({ enabled: null, maxRetries: 2 });
  });

});
