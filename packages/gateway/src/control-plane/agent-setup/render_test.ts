import { describe, expect, test } from 'vitest';

import {
  AgentSetupNoSelectableKeyError,
  agentSetupConfigurationSchema,
  defaultAgentSetupConfiguration,
  type AgentSetupConfiguration,
} from './configuration.ts';
import {
  powerShellLiteral,
  renderCodexIdentityToken,
  renderPowerShellPrefix,
  renderShellPrefix,
  shellLiteral,
} from './render.ts';
import { decodeBase64UrlJson } from '../../shared/base64url-json.ts';
import { agentSetupHeartbeatBody, agentSetupUpdateBody } from '../schemas.ts';

const fullConfiguration: AgentSetupConfiguration = {
  apiKeyId: 'key-a',
  claudeCode: {
    enabled: true,
    model: 'claude-opus-4-6[1m]',
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
        enabled: true, model: null, defaultSonnetModel: null,
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
    expect(defaultAgentSetupConfiguration([{ id: 'key-a' }, { id: 'key-b' }])).toEqual({
      apiKeyId: 'key-a',
      claudeCode: {
        enabled: true, model: null, defaultSonnetModel: null,
        defaultHaikuModel: null, effortLevel: null, modelDiscovery: true,
      },
      codex: { enabled: true, model: null, reasoningEffort: null },
    });
  });

  test('produces a value the schema accepts', () => {
    const config = defaultAgentSetupConfiguration([{ id: 'key-a' }]);
    expect(agentSetupConfigurationSchema.safeParse(config).success).toBe(true);
  });

  test('rejects an empty key list with a typed error', () => {
    expect(() => defaultAgentSetupConfiguration([])).toThrow(AgentSetupNoSelectableKeyError);
  });
});

describe('shellLiteral', () => {
  test('single-quotes and escapes embedded single quotes', () => {
    expect(shellLiteral("a'b")).toBe("'a'\\''b'");
  });

  test('wraps an empty string in bare quotes', () => {
    expect(shellLiteral('')).toBe("''");
  });

  test('preserves newlines, tabs, and Unicode inside the quotes', () => {
    expect(shellLiteral('a\nb\t€🚀')).toBe("'a\nb\t€🚀'");
  });

  test('rejects a NUL character', () => {
    expect(() => shellLiteral('a\0b')).toThrow();
  });
});

describe('powerShellLiteral', () => {
  test('single-quotes and doubles embedded single quotes', () => {
    expect(powerShellLiteral("a'b")).toBe("'a''b'");
  });

  test('wraps an empty string in bare quotes', () => {
    expect(powerShellLiteral('')).toBe("''");
  });

  test('preserves newlines, tabs, and Unicode inside the quotes', () => {
    expect(powerShellLiteral('a\nb\t€🚀')).toBe("'a\nb\t€🚀'");
  });

  test('rejects a NUL character', () => {
    expect(() => powerShellLiteral('a\0b')).toThrow();
  });
});

describe('renderCodexIdentityToken', () => {
  test('is deterministic for a given origin', () => {
    expect(renderCodexIdentityToken('https://floway.example'))
      .toBe(renderCodexIdentityToken('https://floway.example'));
  });

  test('emits a three-segment alg=none JWT with host-derived Floway claims', () => {
    const token = renderCodexIdentityToken('https://floway.example');
    const segments = token.split('.');
    expect(segments).toHaveLength(3);
    expect(segments[2]).toBe('c2ln');
    expect(decodeBase64UrlJson(segments[0]!)).toEqual({ alg: 'none', typ: 'JWT' });
    expect(decodeBase64UrlJson(segments[1]!)).toEqual({
      email: 'floway@floway.example',
      'https://api.openai.com/auth': {
        chatgpt_plan_type: 'pro_plus',
        chatgpt_user_id: 'user-floway',
        chatgpt_account_id: 'acct-floway',
      },
    });
  });

  test('keeps the port in the host-derived email', () => {
    const token = renderCodexIdentityToken('http://localhost:8788');
    const claims = decodeBase64UrlJson(token.split('.')[1]!) as { email: string };
    expect(claims.email).toBe('floway@localhost:8788');
  });
});

describe('renderShellPrefix', () => {
  test('renders every assignment through the encoder and ends with a newline', () => {
    const prefix = renderShellPrefix({
      apiKey: 'sk-raw-key',
      baseUrl: 'https://floway.example',
      configuration: fullConfiguration,
    });
    expect(prefix).toBe([
      'set +x',
      "FLOWAY_API_KEY='sk-raw-key'",
      "FLOWAY_BASE_URL='https://floway.example'",
      "FLOWAY_INSTALL_CLAUDE='1'",
      "FLOWAY_CLAUDE_MODEL='claude-opus-4-6[1m]'",
      "FLOWAY_CLAUDE_DEFAULT_SONNET_MODEL='claude-sonnet-4-5'",
      "FLOWAY_CLAUDE_DEFAULT_HAIKU_MODEL=''",
      "FLOWAY_CLAUDE_EFFORT_LEVEL='high'",
      "FLOWAY_CLAUDE_MODEL_DISCOVERY='1'",
      "FLOWAY_INSTALL_CODEX='1'",
      "FLOWAY_CODEX_MODEL='gpt-5.6-terra'",
      "FLOWAY_CODEX_REASONING_EFFORT='xhigh'",
      `FLOWAY_CODEX_ID_TOKEN=${shellLiteral(renderCodexIdentityToken('https://floway.example'))}`,
      '',
    ].join('\n'));
  });

  test('renders empty values for disabled agents and null overrides', () => {
    const prefix = renderShellPrefix({
      apiKey: 'sk-raw-key',
      baseUrl: 'https://floway.example',
      configuration: {
        apiKeyId: 'key-a',
        claudeCode: {
          enabled: false, model: null, defaultSonnetModel: null,
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
      baseUrl: 'https://floway.example',
      configuration: fullConfiguration,
    })).toThrow();
  });
});

describe('renderPowerShellPrefix', () => {
  test('renders booleans, single-quoted strings, and $null for absent overrides', () => {
    const prefix = renderPowerShellPrefix({
      apiKey: 'sk-raw-key',
      baseUrl: 'https://floway.example',
      configuration: fullConfiguration,
    });
    expect(prefix).toBe([
      'Set-PSDebug -Off',
      "$FlowayApiKey = 'sk-raw-key'",
      "$FlowayBaseUrl = 'https://floway.example'",
      '$FlowayInstallClaude = $true',
      "$FlowayClaudeModel = 'claude-opus-4-6[1m]'",
      "$FlowayClaudeDefaultSonnetModel = 'claude-sonnet-4-5'",
      '$FlowayClaudeDefaultHaikuModel = $null',
      "$FlowayClaudeEffortLevel = 'high'",
      '$FlowayClaudeModelDiscovery = $true',
      '$FlowayInstallCodex = $true',
      "$FlowayCodexModel = 'gpt-5.6-terra'",
      "$FlowayCodexReasoningEffort = 'xhigh'",
      `$FlowayCodexIdToken = ${powerShellLiteral(renderCodexIdentityToken('https://floway.example'))}`,
      '',
    ].join('\n'));
  });

  test('renders $false and $null for disabled agents and null overrides', () => {
    const prefix = renderPowerShellPrefix({
      apiKey: 'sk-raw-key',
      baseUrl: 'https://floway.example',
      configuration: {
        apiKeyId: 'key-a',
        claudeCode: {
          enabled: false, model: null, defaultSonnetModel: null,
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
