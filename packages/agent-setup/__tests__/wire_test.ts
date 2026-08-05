import { describe, expect, test } from 'vitest';
import type { ZodType } from 'zod';

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
  const token = 'a'.repeat(43);

  test('accepts a non-empty create key and a canonical heartbeat token', () => {
    expect(agentSetupCreateBody.safeParse({ apiKeyId: 'key-a' }).success).toBe(true);
    expect(agentSetupHeartbeatBody.safeParse({ token }).success).toBe(true);
  });

  test.each([0, 1, Number.MAX_SAFE_INTEGER])('accepts a complete update at revision %s', expectedRevision => {
    expect(agentSetupUpdateBody.safeParse({ token, configuration: fullConfiguration, expectedRevision }).success).toBe(true);
  });

  test.each([
    ['a missing create key id', agentSetupCreateBody, {}],
    ['an empty create key id', agentSetupCreateBody, { apiKeyId: '' }],
    ['a non-string create key id', agentSetupCreateBody, { apiKeyId: 7 }],
    ['an empty heartbeat token', agentSetupHeartbeatBody, { token: '' }],
    ['a short heartbeat token', agentSetupHeartbeatBody, { token: 'a'.repeat(42) }],
    ['a long heartbeat token', agentSetupHeartbeatBody, { token: 'a'.repeat(44) }],
    ['a non-base64url heartbeat token', agentSetupHeartbeatBody, { token: `${'a'.repeat(42)}=` }],
    ['a non-string heartbeat token', agentSetupHeartbeatBody, { token: 7 }],
    ['an empty update token', agentSetupUpdateBody, { token: '', configuration: fullConfiguration, expectedRevision: 1 }],
    ['a negative revision', agentSetupUpdateBody, { token, configuration: fullConfiguration, expectedRevision: -1 }],
    ['a fractional revision', agentSetupUpdateBody, { token, configuration: fullConfiguration, expectedRevision: 1.5 }],
    ['a non-finite revision', agentSetupUpdateBody, { token, configuration: fullConfiguration, expectedRevision: Number.POSITIVE_INFINITY }],
    ['an unsafe revision', agentSetupUpdateBody, { token, configuration: fullConfiguration, expectedRevision: Number.MAX_SAFE_INTEGER + 1 }],
    ['an invalid inner configuration', agentSetupUpdateBody, {
      token,
      configuration: { ...fullConfiguration, claudeCode: { ...fullConfiguration.claudeCode, model: '' } },
      expectedRevision: 1,
    }],
  ] satisfies readonly [name: string, schema: ZodType, value: unknown][])('rejects %s', (_name, schema, value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });
});
