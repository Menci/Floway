import { describe, expect, test } from 'vitest';

import {
  agentSetupConfigurationSchema,
  defaultAgentSetupConfiguration,
  type AgentSetupConfiguration,
} from './configuration.ts';
import { renderPowerShellPrefix, renderShellPrefix } from './render.ts';
import { agentSetupHeartbeatBody, agentSetupUpdateBody } from './wire.ts';

const fullConfiguration: AgentSetupConfiguration = {
  apiKeyId: 'key-a',
  claudeCode: {
    model: 'claude-opus-4-6[1m]',
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
        model: null, defaultOpusModel: null, defaultSonnetModel: null,
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
        model: null, defaultOpusModel: null, defaultSonnetModel: null,
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

describe('renderShellPrefix', () => {
  test('renders every assignment through the encoder and ends with a newline', () => {
    const prefix = renderShellPrefix({
      agent: 'claude',
      apiKey: 'sk-raw-key',
      apiKeyName: 'Primary key',
      configuration: fullConfiguration,
    });
    expect(prefix).toBe([
      'set +x',
      "SETUP_API_KEY='sk-raw-key'",
      "SETUP_API_KEY_NAME='Primary key'",
      "SETUP_CLAUDE_MODEL='claude-opus-4-6[1m]'",
      "SETUP_CLAUDE_DEFAULT_OPUS_MODEL='claude-opus-4-5'",
      "SETUP_CLAUDE_DEFAULT_SONNET_MODEL='claude-sonnet-4-5'",
      "SETUP_CLAUDE_DEFAULT_HAIKU_MODEL=''",
      "SETUP_CLAUDE_EFFORT_LEVEL='high'",
      "SETUP_CLAUDE_CLEANUP_PERIOD_DAYS='365'",
      "SETUP_CLAUDE_OPT_OUT_AI_ATTRIBUTION='1'",
      "SETUP_CLAUDE_MODEL_DISCOVERY='1'",
      '',
    ].join('\n'));
  });

  test('never emits the endpoint — the gateway does not know its origin', () => {
    const prefix = renderShellPrefix({ agent: 'claude', apiKey: 'sk-raw-key', apiKeyName: 'Primary key', configuration: fullConfiguration });
    expect(prefix).not.toContain('SETUP_ENDPOINT');
  });

  test('single-quotes each value, escaping embedded quotes and preserving newlines, tabs, and Unicode', () => {
    const prefix = renderShellPrefix({
      agent: 'codex',
      apiKey: "a'b",
      apiKeyName: 'Primary key',
      configuration: { ...fullConfiguration, codex: { ...fullConfiguration.codex, model: 'x\ny\t€🚀' } },
    });
    expect(prefix).toContain("SETUP_API_KEY='a'\\''b'");
    expect(prefix).toContain("SETUP_CODEX_MODEL='x\ny\t€🚀'");
  });

  test('flattens control characters in the API key label before it reaches terminal metadata', () => {
    const prefix = renderShellPrefix({ agent: 'claude', apiKey: 'key', apiKeyName: 'CI\n\u001b[2J', configuration: fullConfiguration });
    expect(prefix).toContain("SETUP_API_KEY_NAME='CI  [2J'");
  });

  test('renders empty values for disabled target-agent overrides', () => {
    const prefix = renderShellPrefix({
      agent: 'claude',
      apiKey: 'sk-raw-key',
      apiKeyName: 'Primary key',
      configuration: {
        apiKeyId: 'key-a',
        claudeCode: {
          model: null, defaultOpusModel: null, defaultSonnetModel: null,
          defaultHaikuModel: null, effortLevel: null, cleanupPeriodDays: null, optOutAiAttribution: false, modelDiscovery: false,
        },
        codex: { model: null, reasoningEffort: null },
      },
    });
    expect(prefix).toContain("SETUP_CLAUDE_MODEL_DISCOVERY=''");
    expect(prefix).toContain("SETUP_CLAUDE_EFFORT_LEVEL=''");
    expect(prefix).toContain("SETUP_CLAUDE_CLEANUP_PERIOD_DAYS=''");
    expect(prefix).toContain("SETUP_CLAUDE_OPT_OUT_AI_ATTRIBUTION=''");
    expect(prefix).not.toContain('SETUP_CODEX_');
  });

  test('propagates a NUL-rejecting failure from the API key', () => {
    expect(() => renderShellPrefix({
      agent: 'claude',
      apiKey: 'sk-\0-key',
      apiKeyName: 'Primary key',
      configuration: fullConfiguration,
    })).toThrow();
  });
});

describe('renderPowerShellPrefix', () => {
  test('renders booleans, single-quoted strings, and $null for absent overrides', () => {
    const prefix = renderPowerShellPrefix({
      agent: 'codex',
      apiKey: 'sk-raw-key',
      apiKeyName: 'Primary key',
      configuration: fullConfiguration,
    });
    expect(prefix).toBe([
      'Set-PSDebug -Off',
      "$SetupApiKey = 'sk-raw-key'",
      "$SetupApiKeyName = 'Primary key'",
      "$SetupCodexModel = 'gpt-5.6-terra'",
      "$SetupCodexReasoningEffort = 'xhigh'",
      '',
    ].join('\n'));
  });

  test('never emits the base URL — the gateway does not know its origin', () => {
    const prefix = renderPowerShellPrefix({ agent: 'claude', apiKey: 'sk-raw-key', apiKeyName: 'Primary key', configuration: fullConfiguration });
    expect(prefix).not.toContain('$SetupEndpoint');
  });

  test('single-quotes each string, doubling embedded quotes and preserving newlines, tabs, and Unicode', () => {
    const prefix = renderPowerShellPrefix({
      agent: 'codex',
      apiKey: "a'b",
      apiKeyName: 'Primary key',
      configuration: { ...fullConfiguration, codex: { ...fullConfiguration.codex, model: 'x\ny\t€🚀' } },
    });
    expect(prefix).toContain("$SetupApiKey = 'a''b'");
    expect(prefix).toContain("$SetupCodexModel = 'x\ny\t€🚀'");
  });

  test('propagates a NUL-rejecting failure from the API key', () => {
    expect(() => renderPowerShellPrefix({ agent: 'claude', apiKey: 'sk-\0-key', apiKeyName: 'Primary key', configuration: fullConfiguration })).toThrow();
  });

  test('renders $false and $null for disabled target-agent overrides', () => {
    const prefix = renderPowerShellPrefix({
      agent: 'claude',
      apiKey: 'sk-raw-key',
      apiKeyName: 'Primary key',
      configuration: {
        apiKeyId: 'key-a',
        claudeCode: {
          model: null, defaultOpusModel: null, defaultSonnetModel: null,
          defaultHaikuModel: null, effortLevel: null, cleanupPeriodDays: null, optOutAiAttribution: false, modelDiscovery: false,
        },
        codex: { model: null, reasoningEffort: null },
      },
    });
    expect(prefix).toContain('$SetupClaudeModelDiscovery = $false');
    expect(prefix).toContain('$SetupClaudeModel = $null');
    expect(prefix).toContain('$SetupClaudeCleanupPeriodDays = $null');
    expect(prefix).toContain('$SetupClaudeOptOutAiAttribution = $false');
    expect(prefix).not.toContain('$SetupCodex');
  });

  test('renders a selected Claude cleanup period as a PowerShell number', () => {
    const prefix = renderPowerShellPrefix({
      agent: 'claude',
      apiKey: 'sk-raw-key',
      apiKeyName: 'Primary key',
      configuration: fullConfiguration,
    });
    expect(prefix).toContain('$SetupClaudeCleanupPeriodDays = 365');
    expect(prefix).toContain('$SetupClaudeOptOutAiAttribution = $true');
  });
});

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
