import { describe, expect, it } from 'vitest';

import { buildAgentClaudeSnippet, buildAgentCodexSnippet } from '../../../src/components/api-keys/agent-setup';

describe('Agent Setup snippets', () => {
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
      disableAutoMemory: false,
      disableAgentView: false,
      disableArtifact: false,
      modelDiscovery: true,
    } as const;

    expect(JSON.parse(buildAgentClaudeSnippet('https://floway.example', 'key', base)))
      .not.toHaveProperty('cleanupPeriodDays');
    expect(JSON.parse(buildAgentClaudeSnippet('https://floway.example', 'key', base)))
      .not.toHaveProperty('attribution');
    expect(JSON.parse(buildAgentClaudeSnippet('https://floway.example', 'key', base)))
      .not.toHaveProperty('enableArtifact');
    expect(JSON.parse(buildAgentClaudeSnippet('https://floway.example', 'key', base)))
      .not.toHaveProperty('disableArtifact');

    expect(JSON.parse(buildAgentClaudeSnippet('https://floway.example', 'key', {
      ...base,
      cleanupPeriodDays: 365,
      optOutAiAttribution: true,
      disableAutoMemory: false,
      disableAgentView: false,
      disableArtifact: true,
    }))).toMatchObject({
      cleanupPeriodDays: 365,
      attribution: { commit: '', pr: '', sessionUrl: false },
      enableArtifact: false,
      disableArtifact: true,
    });
  });
});
