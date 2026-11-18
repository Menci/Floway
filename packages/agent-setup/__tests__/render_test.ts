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
});

describe('renderPowerShellPrefix', () => {
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
});
