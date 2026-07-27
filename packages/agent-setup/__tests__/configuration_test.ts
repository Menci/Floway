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
    modelDiscovery: true,
  },
  codex: {
    model: 'gpt-5.6-terra',
    reasoningEffort: 'xhigh',
  },
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
        defaultHaikuModel: null, effortLevel: null, cleanupPeriodDays: null, optOutAiAttribution: false, modelDiscovery: false,
      },
      codex: { model: null, reasoningEffort: 'vendor-tier' },
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
  });
});

describe('defaultAgentSetupConfiguration', () => {
  test('sets the given key, enables both agents, nulls overrides, enables discovery', () => {
    expect(defaultAgentSetupConfiguration('key-a')).toEqual({
      apiKeyId: 'key-a',
      claudeCode: {
        model: null, defaultFableModel: null, defaultOpusModel: null, defaultSonnetModel: null,
        defaultHaikuModel: null, effortLevel: null, cleanupPeriodDays: null, optOutAiAttribution: false, modelDiscovery: true,
      },
      codex: { model: null, reasoningEffort: null },
    });
  });

  test('produces a value the schema accepts', () => {
    const config = defaultAgentSetupConfiguration('key-a');
    expect(agentSetupConfigurationSchema.safeParse(config).success).toBe(true);
  });
});
