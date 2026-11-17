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
    disableArtifact: true,
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
      "SETUP_CLAUDE_DISABLE_ARTIFACT='1'",
      "SETUP_CLAUDE_MODEL_DISCOVERY='1'",
      '',
    ].join('\n'));
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

  test('renders $false and $null for disabled target-agent overrides', () => {
    const prefix = renderPowerShellPrefix({
      agent: 'claude',
      apiKey: 'sk-raw-key',
      apiKeyName: 'Primary key',
      configuration: { ...fullConfiguration, claudeCode: { ...fullConfiguration.claudeCode, model: null, cleanupPeriodDays: null, modelDiscovery: false } },
    });
    expect(prefix).toContain('$SetupClaudeModelDiscovery = $false');
    expect(prefix).toContain('$SetupClaudeModel = $null');
    expect(prefix).toContain('$SetupClaudeCleanupPeriodDays = $null');
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
  });
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
