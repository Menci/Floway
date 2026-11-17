import { describe, expect, test } from 'vitest';

import {
  agentSetupConfigurationSchema,
  defaultAgentSetupConfiguration,
  type AgentSetupConfiguration,
} from '../src/configuration.ts';

const fullConfiguration: AgentSetupConfiguration = {
  apiKeyId: 'key-a',
  claudeCode: {
    model: 'claude-opus-4-6[1m]',
    defaultFableModel: 'claude-fable-5[1m]',
    defaultOpusModel: 'claude-opus-4-5',
    defaultSonnetModel: 'claude-sonnet-4-5',
    defaultHaikuModel: null,
    effortLevel: 'high',
    cleanupPeriodDays: 365,
    optOutAiAttribution: true,
    disableAutoMemory: true,
    disableAgentView: true,
    disableArtifact: true,
    modelDiscovery: true,
  },
  codex: {
    model: 'gpt-5.6-terra',
    reasoningEffort: 'xhigh',
  },
  pi: {
    model: 'custom-pi-model',
    provider: 'floway',
    thinkingLevel: null,
    retry: { enabled: null, maxRetries: null },
  },
  omp: { model: 'custom-omp-model', provider: 'floway', retry: { enabled: null, maxRetries: null } },
};

describe('agentSetupConfigurationSchema', () => {
  test('rejects an empty-string optional model (absence is null, not "")', () => {
    expect(agentSetupConfigurationSchema.safeParse({
      ...fullConfiguration,
      claudeCode: { ...fullConfiguration.claudeCode, model: '' },
    }).success).toBe(false);
  });

  test('rejects a NUL character in an opaque optional string', () => {
    expect(agentSetupConfigurationSchema.safeParse({
      ...fullConfiguration,
      codex: { ...fullConfiguration.codex, reasoningEffort: 'bad\0value' },
    }).success).toBe(false);
  });
});

describe('defaultAgentSetupConfiguration', () => {
  test('produces a value the schema accepts', () => {
    const config = defaultAgentSetupConfiguration('key-a');
    expect(agentSetupConfigurationSchema.safeParse(config).success).toBe(true);
  });
});

test('validates independent Pi and OMP provider names', () => {
  for (const agent of ['pi', 'omp'] as const) {
    for (const provider of ['', 'personal', 'work.api-2', 'a'.repeat(64)]) expect(agentSetupConfigurationSchema.safeParse({ ...fullConfiguration, [agent]: { ...fullConfiguration[agent], model: null, provider } }).success).toBe(true);
    for (const provider of ['UPPER', '../escape', 'with space', 'a'.repeat(65)]) expect(agentSetupConfigurationSchema.safeParse({ ...fullConfiguration, [agent]: { ...fullConfiguration[agent], model: null, provider } }).success).toBe(false);
  }
});
