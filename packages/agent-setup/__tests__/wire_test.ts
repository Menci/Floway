import { describe, expect, test } from 'vitest';

import type { AgentSetupConfiguration } from '../src/configuration.ts';
import { agentSetupHeartbeatBody, agentSetupUpdateBody } from '../src/wire.ts';

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
});
