import { describe, expect, test } from 'vitest';

import type { AgentSetupConfiguration } from '../src/configuration.ts';
import { agentSetupCreateBody, agentSetupHeartbeatBody, agentSetupUpdateBody } from '../src/wire.ts';

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

describe('agent setup request bodies', () => {
  test('agentSetupCreateBody accepts a non-empty API key id', () => {
    expect(agentSetupCreateBody.safeParse({ apiKeyId: 'key-a' }).success).toBe(true);
  });

  test('agentSetupUpdateBody accepts a token, configuration, and expected revision', () => {
    expect(agentSetupUpdateBody.safeParse({
      token: 'token-a',
      configuration: fullConfiguration,
      expectedRevision: 3,
    }).success).toBe(true);
  });

  test('agentSetupUpdateBody rejects an invalid inner configuration', () => {
    expect(agentSetupUpdateBody.safeParse({
      token: 'token-a',
      configuration: { ...fullConfiguration, claudeCode: { ...fullConfiguration.claudeCode, model: '' } },
      expectedRevision: 3,
    }).success).toBe(false);
  });

  test('agentSetupHeartbeatBody accepts a bare token', () => {
    expect(agentSetupHeartbeatBody.safeParse({ token: 'token-a' }).success).toBe(true);
  });

  test.each([
    { label: 'a missing create key', parse: () => agentSetupCreateBody.safeParse({}).success },
    { label: 'an empty create key', parse: () => agentSetupCreateBody.safeParse({ apiKeyId: '' }).success },
    { label: 'a non-string create key', parse: () => agentSetupCreateBody.safeParse({ apiKeyId: 7 }).success },
    { label: 'an empty update token', parse: () => agentSetupUpdateBody.safeParse({ token: '', configuration: fullConfiguration, expectedRevision: 0 }).success },
    { label: 'a negative revision', parse: () => agentSetupUpdateBody.safeParse({ token: 'token-a', configuration: fullConfiguration, expectedRevision: -1 }).success },
    { label: 'a fractional revision', parse: () => agentSetupUpdateBody.safeParse({ token: 'token-a', configuration: fullConfiguration, expectedRevision: 1.5 }).success },
    { label: 'a non-finite revision', parse: () => agentSetupUpdateBody.safeParse({ token: 'token-a', configuration: fullConfiguration, expectedRevision: Number.POSITIVE_INFINITY }).success },
    { label: 'an unsafe revision', parse: () => agentSetupUpdateBody.safeParse({ token: 'token-a', configuration: fullConfiguration, expectedRevision: Number.MAX_SAFE_INTEGER + 1 }).success },
    { label: 'an empty heartbeat token', parse: () => agentSetupHeartbeatBody.safeParse({ token: '' }).success },
    { label: 'a non-string heartbeat token', parse: () => agentSetupHeartbeatBody.safeParse({ token: 7 }).success },
  ])('rejects $label', ({ parse }) => {
    expect(parse()).toBe(false);
  });
});
