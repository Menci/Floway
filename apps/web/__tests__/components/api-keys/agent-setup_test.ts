import { describe, expect, it } from 'vitest';

import { buildAgentClaudeSnippet, buildAgentCodexSnippet } from '../../../src/components/api-keys/agent-setup';

describe('Agent Setup snippets', () => {
  it('renders selected Codex model and reasoning effort', () => {
    const snippet = buildAgentCodexSnippet('https://floway.example', { model: 'gpt-5.6', reasoningEffort: 'xhigh' }, 'unix');
    expect(snippet).toContain('model = "gpt-5.6"');
    expect(snippet).toContain('model_reasoning_effort = "xhigh"');
    expect(snippet).toContain('base_url = "https://floway.example/azure-api.codex"');
  });

  it('gives each platform its own auth command and no trace of the other', () => {
    const config = { model: null, reasoningEffort: null };
    const unix = buildAgentCodexSnippet('https://floway.example', config, 'unix');
    const windows = buildAgentCodexSnippet('https://floway.example', config, 'windows');
    expect(unix).toContain('command = "sh"');
    expect(unix).not.toContain('powershell');
    expect(windows).toContain('command = "powershell"');
    expect(windows).not.toContain('command = "sh"');
    expect(unix).not.toContain('#');
    expect(windows).not.toContain('#');
  });

  it('writes each Claude family model to its own environment variable', () => {
    const snippet = JSON.parse(buildAgentClaudeSnippet('https://floway.example', 'key', {
      model: 'chat',
      defaultFableModel: 'fable-5',
      defaultOpusModel: 'opus-5',
      defaultSonnetModel: 'sonnet-5',
      defaultHaikuModel: 'haiku-4-5',
      effortLevel: null,
      cleanupPeriodDays: null,
      optOutAiAttribution: false,
      modelDiscovery: false,
    })) as { env: Record<string, string> };

    expect(snippet.env).toMatchObject({
      ANTHROPIC_MODEL: 'chat',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'fable-5',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'opus-5',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'sonnet-5',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'haiku-4-5',
    });
  });

  it('omits a family variable when no model is selected for it', () => {
    const snippet = JSON.parse(buildAgentClaudeSnippet('https://floway.example', 'key', {
      model: null,
      defaultFableModel: null,
      defaultOpusModel: 'opus-5',
      defaultSonnetModel: null,
      defaultHaikuModel: null,
      effortLevel: null,
      cleanupPeriodDays: null,
      optOutAiAttribution: false,
      modelDiscovery: false,
    })) as { env: Record<string, string> };

    expect(snippet.env).not.toHaveProperty('ANTHROPIC_DEFAULT_FABLE_MODEL');
    expect(snippet.env).toHaveProperty('ANTHROPIC_DEFAULT_OPUS_MODEL', 'opus-5');
  });

  it('renders optional Claude cleanup and attribution preferences', () => {
    const base = {
      model: null,
      defaultFableModel: null,
      defaultOpusModel: null,
      defaultSonnetModel: null,
      defaultHaikuModel: null,
      effortLevel: null,
      cleanupPeriodDays: null,
      optOutAiAttribution: false,
      modelDiscovery: true,
    } as const;

    expect(JSON.parse(buildAgentClaudeSnippet('https://floway.example', 'key', base)))
      .not.toHaveProperty('cleanupPeriodDays');
    expect(JSON.parse(buildAgentClaudeSnippet('https://floway.example', 'key', base)))
      .not.toHaveProperty('attribution');

    expect(JSON.parse(buildAgentClaudeSnippet('https://floway.example', 'key', {
      ...base,
      cleanupPeriodDays: 365,
      optOutAiAttribution: true,
    }))).toMatchObject({
      cleanupPeriodDays: 365,
      attribution: { commit: '', pr: '', sessionUrl: false },
    });
  });
});
