import { describe, expect, test } from 'vitest';

import type { AgentSetupConfiguration } from '../src/configuration.ts';
import { renderPowerShellPrefix, renderShellPrefix } from '../src/render.ts';

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
    model: 'floway-pi-model',
    provider: 'floway',
    thinkingLevel: null,
    retry: { enabled: null, maxRetries: null },
  },
  omp: { model: 'custom-omp-model', provider: 'floway', retry: { enabled: null, maxRetries: null } },
};

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
      "SETUP_CLAUDE_DEFAULT_FABLE_MODEL='claude-fable-5[1m]'",
      "SETUP_CLAUDE_DEFAULT_OPUS_MODEL='claude-opus-4-5'",
      "SETUP_CLAUDE_DEFAULT_SONNET_MODEL='claude-sonnet-4-5'",
      "SETUP_CLAUDE_DEFAULT_HAIKU_MODEL=''",
      "SETUP_CLAUDE_EFFORT_LEVEL='high'",
      "SETUP_CLAUDE_CLEANUP_PERIOD_DAYS='365'",
      "SETUP_CLAUDE_OPT_OUT_AI_ATTRIBUTION='1'",
      "SETUP_CLAUDE_DISABLE_AUTO_MEMORY='1'",
      "SETUP_CLAUDE_DISABLE_AGENT_VIEW='1'",
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
    const prefix = renderShellPrefix({ agent: 'claude', apiKey: 'key', apiKeyName: 'CI\n\x1b[2J', configuration: fullConfiguration });
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
          model: null, defaultFableModel: null, defaultOpusModel: null, defaultSonnetModel: null,
          defaultHaikuModel: null, effortLevel: null, cleanupPeriodDays: null, optOutAiAttribution: false, disableAutoMemory: false, disableAgentView: false, modelDiscovery: false,
        },
        codex: { model: null, reasoningEffort: null },
        pi: { model: null, provider: 'floway', thinkingLevel: null, retry: { enabled: null, maxRetries: null } },
        omp: { model: null, provider: 'floway', retry: { enabled: null, maxRetries: null } },
      },
    });
    expect(prefix).toContain("SETUP_CLAUDE_MODEL_DISCOVERY=''");
    expect(prefix).toContain("SETUP_CLAUDE_EFFORT_LEVEL=''");
    expect(prefix).toContain("SETUP_CLAUDE_CLEANUP_PERIOD_DAYS=''");
    expect(prefix).toContain("SETUP_CLAUDE_OPT_OUT_AI_ATTRIBUTION=''");
    expect(prefix).toContain("SETUP_CLAUDE_DISABLE_AUTO_MEMORY=''");
    expect(prefix).toContain("SETUP_CLAUDE_DISABLE_AGENT_VIEW=''");
    expect(prefix).not.toContain('SETUP_CODEX_');
    expect(prefix).not.toContain('SETUP_PI_');
  });

  test('renders pi prefix assignments for shell with quoting, the extension path, and null handling', () => {
    const withModel = renderShellPrefix({
      agent: 'pi',
      apiKey: "key'with'quote",
      apiKeyName: 'Key Label',
      configuration: fullConfiguration,
      extensionPath: '/api/setup/test-lease-token/pi.js',
    });
    expect(withModel).toBe([
      'set +x',
      "SETUP_API_KEY='key'\\''with'\\''quote'",
      "SETUP_API_KEY_NAME='Key Label'",
      "SETUP_PI_MODEL='floway-pi-model'",
      "SETUP_EXTENSION_PATH='/api/setup/test-lease-token/pi.js'",
      "SETUP_PI_PROVIDER='floway'",
      "SETUP_PI_RETRY_ENABLED=''",
      "SETUP_PI_MAX_RETRIES=''",
      "SETUP_PI_THINKING_LEVEL=''",
      '',
    ].join('\n'));

    const withoutModel = renderShellPrefix({
      agent: 'pi',
      apiKey: 'sk-raw-key',
      apiKeyName: 'Key Label',
      configuration: { ...fullConfiguration, pi: { model: null, provider: 'floway', thinkingLevel: null, retry: { enabled: null, maxRetries: null } } },
      extensionPath: '/custom/setup/pi.js',
    });
    expect(withoutModel).toContain("SETUP_PI_MODEL=''");
    expect(withoutModel).toContain("SETUP_EXTENSION_PATH='/custom/setup/pi.js'");
    expect(withoutModel).not.toContain('SETUP_CLAUDE_');
    expect(withoutModel).not.toContain('SETUP_CODEX_');
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
          model: null, defaultFableModel: null, defaultOpusModel: null, defaultSonnetModel: null,
          defaultHaikuModel: null, effortLevel: null, cleanupPeriodDays: null, optOutAiAttribution: false, disableAutoMemory: false, disableAgentView: false, modelDiscovery: false,
        },
        codex: { model: null, reasoningEffort: null },
        pi: { model: null, provider: 'floway', thinkingLevel: null, retry: { enabled: null, maxRetries: null } },
        omp: { model: null, provider: 'floway', retry: { enabled: null, maxRetries: null } },
      },
    });
    expect(prefix).toContain('$SetupClaudeModelDiscovery = $false');
    expect(prefix).toContain('$SetupClaudeModel = $null');
    expect(prefix).toContain('$SetupClaudeCleanupPeriodDays = $null');
    expect(prefix).toContain('$SetupClaudeOptOutAiAttribution = $false');
    expect(prefix).toContain('$SetupClaudeDisableAutoMemory = $false');
    expect(prefix).toContain('$SetupClaudeDisableAgentView = $false');
    expect(prefix).not.toContain('$SetupCodex');
    expect(prefix).not.toContain('$SetupPi');
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
    expect(prefix).toContain('$SetupClaudeDisableAutoMemory = $true');
    expect(prefix).toContain('$SetupClaudeDisableAgentView = $true');
  });

  test('renders pi prefix assignments for PowerShell with quoting, the extension path, and null handling', () => {
    const withModel = renderPowerShellPrefix({
      agent: 'pi',
      apiKey: "key'with'quote",
      apiKeyName: 'Key Label',
      configuration: fullConfiguration,
      extensionPath: '/api/setup/test-lease-token/pi.js',
    });
    expect(withModel).toBe([
      'Set-PSDebug -Off',
      "$SetupApiKey = 'key''with''quote'",
      "$SetupApiKeyName = 'Key Label'",
      "$SetupPiModel = 'floway-pi-model'",
      "$SetupExtensionPath = '/api/setup/test-lease-token/pi.js'",
      "$SetupPiProvider = 'floway'",
      '$SetupPiRetryEnabled = $null',
      '$SetupPiMaxRetries = $null',
      '$SetupPiThinkingLevel = $null',
      '',
    ].join('\n'));

    const withoutModel = renderPowerShellPrefix({
      agent: 'pi',
      apiKey: 'sk-raw-key',
      apiKeyName: 'Key Label',
      configuration: { ...fullConfiguration, pi: { model: null, provider: 'floway', thinkingLevel: null, retry: { enabled: null, maxRetries: null } } },
      extensionPath: '/custom/setup/pi.js',
    });
    expect(withoutModel).toContain('$SetupPiModel = $null');
    expect(withoutModel).toContain("$SetupExtensionPath = '/custom/setup/pi.js'");
    expect(withoutModel).not.toContain('$SetupClaude');
    expect(withoutModel).not.toContain('$SetupCodex');
  });
});

test('renders independent OMP model settings and its leased extension in both shells', () => {
  const input = { agent: 'omp' as const, apiKey: "key'quoted", apiKeyName: 'Primary', configuration: fullConfiguration, extensionPath: '/custom/setup/omp.js' };
  expect(renderShellPrefix(input)).toContain("SETUP_OMP_MODEL='custom-omp-model'");
  expect(renderShellPrefix(input)).toContain("SETUP_EXTENSION_PATH='/custom/setup/omp.js'");
  expect(renderShellPrefix(input)).not.toContain('SETUP_PI_MODEL');
  expect(renderPowerShellPrefix(input)).toContain("$SetupOmpModel = 'custom-omp-model'");
  expect(renderPowerShellPrefix(input)).toContain("$SetupExtensionPath = '/custom/setup/omp.js'");
  const configuration = { ...fullConfiguration, omp: { model: null, provider: 'floway', retry: { enabled: null, maxRetries: null } } };
  expect(renderShellPrefix({ ...input, configuration })).toContain("SETUP_OMP_MODEL=''");
  expect(renderPowerShellPrefix({ ...input, configuration })).toContain('$SetupOmpModel = $null');
});

test('renders explicit native Pi thinking and retry values while retaining zero and disabled semantics', () => {
  const configuration = { ...fullConfiguration, pi: { ...fullConfiguration.pi, thinkingLevel: 'high' as const, retry: { enabled: false, maxRetries: 0 } }, omp: { ...fullConfiguration.omp, retry: { enabled: true, maxRetries: 8 } } };
  const input = { apiKey: 'key', apiKeyName: 'Label', configuration, extensionPath: '/custom/extension.js' };
  expect(renderShellPrefix({ ...input, agent: 'pi' })).toContain("SETUP_PI_THINKING_LEVEL='high'");
  expect(renderShellPrefix({ ...input, agent: 'pi' })).toContain("SETUP_PI_RETRY_ENABLED='false'");
  expect(renderShellPrefix({ ...input, agent: 'pi' })).toContain("SETUP_PI_MAX_RETRIES='0'");
  expect(renderPowerShellPrefix({ ...input, agent: 'pi' })).toContain('$SetupPiRetryEnabled = $false');
  expect(renderPowerShellPrefix({ ...input, agent: 'pi' })).toContain('$SetupPiMaxRetries = 0');
  expect(renderShellPrefix({ ...input, agent: 'omp' })).toContain("SETUP_OMP_RETRY_ENABLED='true'");
  expect(renderPowerShellPrefix({ ...input, agent: 'omp' })).toContain('$SetupOmpMaxRetries = 8');
});

test('blank provider IDs resolve consistently in scripts', () => {
  for (const agent of ['pi', 'omp'] as const) {
    const configuration = { ...fullConfiguration, [agent]: { ...fullConfiguration[agent], provider: '' } };
    const input = { agent, extensionPath: '/extension.js', apiKey: 'key', apiKeyName: 'key', configuration };
    expect(renderShellPrefix(input)).toContain(`SETUP_${agent.toUpperCase()}_PROVIDER='floway'`);
    expect(renderPowerShellPrefix(input)).toContain(`$Setup${agent === 'pi' ? 'Pi' : 'Omp'}Provider = 'floway'`);
  }
});
