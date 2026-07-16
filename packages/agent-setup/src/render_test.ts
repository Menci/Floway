import { describe, expect, test } from 'vitest';

import {
  AgentSetupNoSelectableKeyError,
  agentSetupConfigurationSchema,
  defaultAgentSetupConfiguration,
  type AgentSetupConfiguration,
} from './configuration.ts';
import { renderPowerShellPrefix, renderShellPrefix } from './render.ts';
import { agentSetupHeartbeatBody, agentSetupUpdateBody } from './wire.ts';

const fullConfiguration: AgentSetupConfiguration = {
  apiKeyId: 'key-a',
  claudeCode: {
    enabled: true,
    model: 'claude-opus-4-6[1m]',
    defaultOpusModel: 'claude-opus-4-5',
    defaultSonnetModel: 'claude-sonnet-4-5',
    defaultHaikuModel: null,
    effortLevel: 'high',
    modelDiscovery: true,
  },
  codex: {
    enabled: true,
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
        enabled: true, model: null, defaultOpusModel: null, defaultSonnetModel: null,
        defaultHaikuModel: null, effortLevel: null, modelDiscovery: false,
      },
      codex: { enabled: true, model: null, reasoningEffort: 'vendor-tier' },
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
  test('selects the first key, enables both agents, nulls overrides, enables discovery', () => {
    expect(defaultAgentSetupConfiguration(['key-a', 'key-b'])).toEqual({
      apiKeyId: 'key-a',
      claudeCode: {
        enabled: true, model: null, defaultOpusModel: null, defaultSonnetModel: null,
        defaultHaikuModel: null, effortLevel: null, modelDiscovery: true,
      },
      codex: { enabled: true, model: null, reasoningEffort: null },
    });
  });

  test('produces a value the schema accepts', () => {
    const config = defaultAgentSetupConfiguration(['key-a']);
    expect(agentSetupConfigurationSchema.safeParse(config).success).toBe(true);
  });

  test('rejects an empty key list with a typed error', () => {
    expect(() => defaultAgentSetupConfiguration([])).toThrow(AgentSetupNoSelectableKeyError);
  });
});

describe('renderShellPrefix', () => {
  test('renders every assignment through the encoder and ends with a newline', () => {
    const prefix = renderShellPrefix({
      apiKey: 'sk-raw-key',
      configuration: fullConfiguration,
    });
    expect(prefix).toBe([
      'set +x',
      "FLOWAY_API_KEY='sk-raw-key'",
      "FLOWAY_INSTALL_CLAUDE='1'",
      "FLOWAY_CLAUDE_MODEL='claude-opus-4-6[1m]'",
      "FLOWAY_CLAUDE_DEFAULT_OPUS_MODEL='claude-opus-4-5'",
      "FLOWAY_CLAUDE_DEFAULT_SONNET_MODEL='claude-sonnet-4-5'",
      "FLOWAY_CLAUDE_DEFAULT_HAIKU_MODEL=''",
      "FLOWAY_CLAUDE_EFFORT_LEVEL='high'",
      "FLOWAY_CLAUDE_MODEL_DISCOVERY='1'",
      "FLOWAY_INSTALL_CODEX='1'",
      "FLOWAY_CODEX_MODEL='gpt-5.6-terra'",
      "FLOWAY_CODEX_REASONING_EFFORT='xhigh'",
      '',
    ].join('\n'));
  });

  test('never emits the base URL or a Codex identity token — the gateway does not know its origin', () => {
    const prefix = renderShellPrefix({ apiKey: 'sk-raw-key', configuration: fullConfiguration });
    expect(prefix).not.toContain('FLOWAY_BASE_URL');
    expect(prefix).not.toContain('FLOWAY_CODEX_ID_TOKEN');
  });

  test('single-quotes each value, escaping embedded quotes and preserving newlines, tabs, and Unicode', () => {
    const prefix = renderShellPrefix({
      apiKey: "a'b",
      configuration: { ...fullConfiguration, codex: { ...fullConfiguration.codex, model: 'x\ny\t€🚀' } },
    });
    expect(prefix).toContain("FLOWAY_API_KEY='a'\\''b'");
    expect(prefix).toContain("FLOWAY_CODEX_MODEL='x\ny\t€🚀'");
  });

  test('renders empty values for disabled agents and null overrides', () => {
    const prefix = renderShellPrefix({
      apiKey: 'sk-raw-key',
      configuration: {
        apiKeyId: 'key-a',
        claudeCode: {
          enabled: false, model: null, defaultOpusModel: null, defaultSonnetModel: null,
          defaultHaikuModel: null, effortLevel: null, modelDiscovery: false,
        },
        codex: { enabled: false, model: null, reasoningEffort: null },
      },
    });
    expect(prefix).toContain("FLOWAY_INSTALL_CLAUDE=''");
    expect(prefix).toContain("FLOWAY_INSTALL_CODEX=''");
    expect(prefix).toContain("FLOWAY_CLAUDE_MODEL_DISCOVERY=''");
    expect(prefix).toContain("FLOWAY_CLAUDE_EFFORT_LEVEL=''");
    expect(prefix).toContain("FLOWAY_CODEX_REASONING_EFFORT=''");
  });

  test('propagates a NUL-rejecting failure from the API key', () => {
    expect(() => renderShellPrefix({
      apiKey: 'sk-\0-key',
      configuration: fullConfiguration,
    })).toThrow();
  });
});

describe('renderPowerShellPrefix', () => {
  test('renders booleans, single-quoted strings, and $null for absent overrides', () => {
    const prefix = renderPowerShellPrefix({
      apiKey: 'sk-raw-key',
      configuration: fullConfiguration,
    });
    expect(prefix).toBe([
      'Set-PSDebug -Off',
      "$FlowayApiKey = 'sk-raw-key'",
      '$FlowayInstallClaude = $true',
      "$FlowayClaudeModel = 'claude-opus-4-6[1m]'",
      "$FlowayClaudeDefaultOpusModel = 'claude-opus-4-5'",
      "$FlowayClaudeDefaultSonnetModel = 'claude-sonnet-4-5'",
      '$FlowayClaudeDefaultHaikuModel = $null',
      "$FlowayClaudeEffortLevel = 'high'",
      '$FlowayClaudeModelDiscovery = $true',
      '$FlowayInstallCodex = $true',
      "$FlowayCodexModel = 'gpt-5.6-terra'",
      "$FlowayCodexReasoningEffort = 'xhigh'",
      '',
    ].join('\n'));
  });

  test('never emits the base URL — the gateway does not know its origin', () => {
    const prefix = renderPowerShellPrefix({ apiKey: 'sk-raw-key', configuration: fullConfiguration });
    expect(prefix).not.toContain('$FlowayBaseUrl');
  });

  test('single-quotes each string, doubling embedded quotes and preserving newlines, tabs, and Unicode', () => {
    const prefix = renderPowerShellPrefix({
      apiKey: "a'b",
      configuration: { ...fullConfiguration, codex: { ...fullConfiguration.codex, model: 'x\ny\t€🚀' } },
    });
    expect(prefix).toContain("$FlowayApiKey = 'a''b'");
    expect(prefix).toContain("$FlowayCodexModel = 'x\ny\t€🚀'");
  });

  test('propagates a NUL-rejecting failure from the API key', () => {
    expect(() => renderPowerShellPrefix({ apiKey: 'sk-\0-key', configuration: fullConfiguration })).toThrow();
  });

  test('renders $false and $null for disabled agents and null overrides', () => {
    const prefix = renderPowerShellPrefix({
      apiKey: 'sk-raw-key',
      configuration: {
        apiKeyId: 'key-a',
        claudeCode: {
          enabled: false, model: null, defaultOpusModel: null, defaultSonnetModel: null,
          defaultHaikuModel: null, effortLevel: null, modelDiscovery: false,
        },
        codex: { enabled: false, model: null, reasoningEffort: null },
      },
    });
    expect(prefix).toContain('$FlowayInstallClaude = $false');
    expect(prefix).toContain('$FlowayInstallCodex = $false');
    expect(prefix).toContain('$FlowayClaudeModelDiscovery = $false');
    expect(prefix).toContain('$FlowayClaudeModel = $null');
    expect(prefix).toContain('$FlowayCodexReasoningEffort = $null');
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
