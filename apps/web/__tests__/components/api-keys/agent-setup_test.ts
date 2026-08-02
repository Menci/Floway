import { describe, expect, it } from 'vitest';

import type { ControlPlaneModel } from '../../../src/api/types';
import { buildAgentClaudeSnippet, buildAgentCodexSnippet, filterModelOptions, modelOptions } from '../../../src/components/api-keys/agent-setup-card';
import { agentSetupCommand } from '../../../src/components/api-keys/use-agent-setup';

const model = (id: string, context: number): ControlPlaneModel => ({
  id,
  object: 'model',
  type: 'model',
  display_name: id,
  kind: 'chat',
  limits: { max_context_window_tokens: context },
  endpoints: { responses: {} },
  upstreams: [],
});

describe('Agent Setup', () => {
  it('builds origin-scoped Unix and Windows commands', () => {
    expect(agentSetupCommand('https://floway.example', '/api/setup/token/claude.sh', 'unix'))
      .toBe("export SETUP_ENDPOINT='https://floway.example'; curl -fsSL \"$SETUP_ENDPOINT/api/setup/token/claude.sh\" | bash");
    expect(agentSetupCommand('https://floway.example', '/api/setup/token/codex.ps1', 'windows'))
      .toBe("$SetupEndpoint = 'https://floway.example'; irm \"$SetupEndpoint/api/setup/token/codex.ps1\" | iex");
  });

  it('offers the full chat catalog while ranking the requested family', () => {
    const options = modelOptions([
      model('gpt-5.6', 400_000),
      model('claude-opus-4.6', 1_000_000),
      model('other-chat', 100_000),
    ], 'claude', 'opus');
    expect(options.map(option => option.value)).toEqual([
      'claude-opus-4.6[1m]',
      'gpt-5.6',
      'other-chat',
    ]);
  });

  it('searches the label case-insensitively and the value the label does not spell', () => {
    const options = modelOptions([
      model('claude-opus-4.6', 1_000_000),
      model('gpt-5.6', 400_000),
    ], 'claude', 'default');

    expect(filterModelOptions(options, 'OPUS').map(option => option.label))
      .toEqual(['claude-opus-4.6']);
    // The label stays the public model id while the value carries the [1m]
    // context override, so a search for the override has only the value to
    // match against.
    expect(filterModelOptions(options, '[1m]').map(option => option.value))
      .toEqual(['claude-opus-4.6[1m]']);
    expect(filterModelOptions(options, 'sonnet')).toEqual([]);
  });

  it('renders selected Codex model and reasoning effort', () => {
    const snippet = buildAgentCodexSnippet('https://floway.example', { model: 'gpt-5.6', reasoningEffort: 'xhigh' });
    expect(snippet).toContain('model = "gpt-5.6"');
    expect(snippet).toContain('model_reasoning_effort = "xhigh"');
    expect(snippet).toContain('base_url = "https://floway.example/azure-api.codex"');
    expect(snippet).toContain('command = "powershell"');
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
