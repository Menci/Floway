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
  test('accepts a fully-specified configuration', () => {
    expect(agentSetupConfigurationSchema.safeParse(fullConfiguration).success).toBe(true);
  });

  test('accepts nulls for every optional Claude field and an open Codex effort', () => {
    expect(agentSetupConfigurationSchema.safeParse({
      apiKeyId: 'key-a',
      claudeCode: {
        model: null, defaultFableModel: null, defaultOpusModel: null, defaultSonnetModel: null,
        defaultHaikuModel: null, effortLevel: null, cleanupPeriodDays: null, optOutAiAttribution: false, disableAutoMemory: false, disableAgentView: false, modelDiscovery: false,
      },
      codex: { model: null, reasoningEffort: 'vendor-tier' },
      pi: { model: null, provider: 'floway', thinkingLevel: null, retry: { enabled: null, maxRetries: null } },
      omp: { model: null, provider: 'floway', retry: { enabled: null, maxRetries: null } },
    }).success).toBe(true);
  });

  test('accepts every Claude effort enum value', () => {
    for (const effortLevel of ['low', 'medium', 'high', 'xhigh'] as const) {
      expect(agentSetupConfigurationSchema.safeParse({
        ...fullConfiguration,
        claudeCode: { ...fullConfiguration.claudeCode, effortLevel },
      }).success).toBe(true);
    }
  });

  test('rejects an effort value outside the Claude enum', () => {
    expect(agentSetupConfigurationSchema.safeParse({
      ...fullConfiguration,
      claudeCode: { ...fullConfiguration.claudeCode, effortLevel: 'minimal' },
    }).success).toBe(false);
  });

  test('accepts only the offered Claude cleanup periods or null', () => {
    for (const cleanupPeriodDays of [180, 365, 99999, null] as const) {
      expect(agentSetupConfigurationSchema.safeParse({
        ...fullConfiguration,
        claudeCode: { ...fullConfiguration.claudeCode, cleanupPeriodDays },
      }).success).toBe(true);
    }
    expect(agentSetupConfigurationSchema.safeParse({
      ...fullConfiguration,
      claudeCode: { ...fullConfiguration.claudeCode, cleanupPeriodDays: 30 },
    }).success).toBe(false);
  });

  test('requires the Claude attribution opt-out flag to be boolean', () => {
    expect(agentSetupConfigurationSchema.safeParse({
      ...fullConfiguration,
      claudeCode: { ...fullConfiguration.claudeCode, optOutAiAttribution: false },
    }).success).toBe(true);
    expect(agentSetupConfigurationSchema.safeParse({
      ...fullConfiguration,
      claudeCode: { ...fullConfiguration.claudeCode, optOutAiAttribution: 'yes' },
    }).success).toBe(false);
  });

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

  test('rejects unknown keys in nested objects', () => {
    expect(agentSetupConfigurationSchema.safeParse({
      ...fullConfiguration,
      codex: { ...fullConfiguration.codex, unexpected: true },
    }).success).toBe(false);
    expect(agentSetupConfigurationSchema.safeParse({
      ...fullConfiguration,
      pi: { ...fullConfiguration.pi, unexpected: true },
    }).success).toBe(false);
  });

  test('rejects an unmigrated configuration without Pi preferences', () => {
    const { pi: _, ...withoutPi } = fullConfiguration;
    expect(agentSetupConfigurationSchema.safeParse(withoutPi).success).toBe(false);
  });

  test('accepts null or a non-empty string for the Pi model and rejects an empty or NUL string', () => {
    expect(agentSetupConfigurationSchema.safeParse({ ...fullConfiguration, pi: { model: null, provider: 'floway', thinkingLevel: null, retry: { enabled: null, maxRetries: null } } }).success).toBe(true);
    expect(agentSetupConfigurationSchema.safeParse({ ...fullConfiguration, pi: { model: 'floway-pi-model', provider: 'floway', thinkingLevel: null, retry: { enabled: null, maxRetries: null } } }).success).toBe(true);
    expect(agentSetupConfigurationSchema.safeParse({ ...fullConfiguration, pi: { model: '', provider: 'floway', thinkingLevel: null, retry: { enabled: null, maxRetries: null } } }).success).toBe(false);
    expect(agentSetupConfigurationSchema.safeParse({ ...fullConfiguration, pi: { model: 'bad\0model', provider: 'floway', thinkingLevel: null, retry: { enabled: null, maxRetries: null } } }).success).toBe(false);
  });
});

describe('defaultAgentSetupConfiguration', () => {
  test('sets the given key and defaults for all agents', () => {
    expect(defaultAgentSetupConfiguration('key-a')).toEqual({
      apiKeyId: 'key-a',
      claudeCode: {
        model: null, defaultFableModel: null, defaultOpusModel: null, defaultSonnetModel: null,
        defaultHaikuModel: null, effortLevel: null, cleanupPeriodDays: null, optOutAiAttribution: false, disableAutoMemory: false, disableAgentView: false, modelDiscovery: true,
      },
      codex: { model: null, reasoningEffort: null },
      pi: { model: null, provider: '', thinkingLevel: null, retry: { enabled: null, maxRetries: null } },
      omp: { model: null, provider: '', retry: { enabled: null, maxRetries: null } },
    });
  });

  test('produces a value the schema accepts', () => {
    const config = defaultAgentSetupConfiguration('key-a');
    expect(agentSetupConfigurationSchema.safeParse(config).success).toBe(true);
  });
});

test('requires OMP preferences and validates its nullable opaque model', () => {
  const { omp: _, ...withoutOmp } = fullConfiguration;
  expect(agentSetupConfigurationSchema.safeParse(withoutOmp).success).toBe(false);
  for (const model of [null, 'custom-omp-model']) expect(agentSetupConfigurationSchema.safeParse({ ...fullConfiguration, omp: { model, provider: 'floway', retry: { enabled: null, maxRetries: null } } }).success).toBe(true);
  for (const model of ['', 'bad\0model']) expect(agentSetupConfigurationSchema.safeParse({ ...fullConfiguration, omp: { model, provider: 'floway', retry: { enabled: null, maxRetries: null } } }).success).toBe(false);
  expect(agentSetupConfigurationSchema.safeParse({ ...fullConfiguration, omp: { model: null, unexpected: true, provider: 'floway', retry: { enabled: null, maxRetries: null } } }).success).toBe(false);
});

test('validates independent Pi and OMP provider names', () => {
  for (const agent of ['pi', 'omp'] as const) {
    for (const provider of ['', 'personal', 'work.api-2', 'a'.repeat(64)]) expect(agentSetupConfigurationSchema.safeParse({ ...fullConfiguration, [agent]: { ...fullConfiguration[agent], model: null, provider } }).success).toBe(true);
    for (const provider of ['UPPER', '../escape', 'with space', 'a'.repeat(65)]) expect(agentSetupConfigurationSchema.safeParse({ ...fullConfiguration, [agent]: { ...fullConfiguration[agent], model: null, provider } }).success).toBe(false);
  }
});

test('validates Pi thinking slots and independent nullable retry preferences', () => {
  for (const thinkingLevel of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', null]) {
    expect(agentSetupConfigurationSchema.safeParse({ ...fullConfiguration, pi: { ...fullConfiguration.pi, thinkingLevel } }).success).toBe(true);
  }
  expect(agentSetupConfigurationSchema.safeParse({ ...fullConfiguration, pi: { ...fullConfiguration.pi, thinkingLevel: 'vendor-effort' } }).success).toBe(false);
  for (const agent of ['pi', 'omp'] as const) {
    for (const retry of [{ enabled: null, maxRetries: null }, { enabled: false, maxRetries: 0 }, { enabled: true, maxRetries: 100 }]) {
      expect(agentSetupConfigurationSchema.safeParse({ ...fullConfiguration, [agent]: { ...fullConfiguration[agent], retry } }).success).toBe(true);
    }
    for (const retry of [{ enabled: true, maxRetries: -1 }, { enabled: false, maxRetries: 1.5 }, { enabled: true, maxRetries: null, unexpected: true }]) {
      expect(agentSetupConfigurationSchema.safeParse({ ...fullConfiguration, [agent]: { ...fullConfiguration[agent], retry } }).success).toBe(false);
    }
  }
});
