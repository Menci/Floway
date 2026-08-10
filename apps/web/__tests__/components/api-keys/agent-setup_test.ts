import { describe, expect, it } from 'vitest';

import { buildAgentClaudeSnippet, buildAgentCodexSnippet, buildAgentVSCodeSnippet, zedWindowsCredentialSnippet } from '../../../src/components/api-keys/agent-setup';
import { ZED_CREDENTIAL_CSHARP } from '@floway-dev/agent-setup/zed-credential';

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
      disableAutoMemory: false,
      disableAgentView: false,
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
      disableAutoMemory: false,
      disableAgentView: false,
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
      disableAutoMemory: false,
      disableAgentView: false,
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
      disableAutoMemory: false,
      disableAgentView: false,
    }))).toMatchObject({
      cleanupPeriodDays: 365,
      attribution: { commit: '', pr: '', sessionUrl: false },
    });
  });
});

// The pasted snippet and the installer both define `FlowayZedCredential` and
// both guard on the type already being in the AppDomain, so in one console
// whichever ran first defines it for the other. Any difference between them is
// therefore a silent substitution rather than an error, and the installer would
// end up running the snippet's version.
describe('Zed Windows credential snippet', () => {
  it('emits the installer own C#, not a copy of it', () => {
    const snippet = zedWindowsCredentialSnippet('https://gateway.example', 'sk-test');
    expect(snippet).toContain(ZED_CREDENTIAL_CSHARP.trimEnd());
    // In a literal here-string, as the installer uses. `@"` would interpolate a
    // `$` or a backtick in the shared body, so the same type name would carry
    // two different programs depending on which ran first in the console.
    expect(snippet).toContain("Add-Type -TypeDefinition @'");
    expect(snippet).not.toContain('Add-Type -TypeDefinition @"');
  });

  // The scrubbing is in `finally`, so a CredWriteW that throws does not leave
  // the key sitting in the block the next line frees.
  it('zeroes the blob on the failure path too', () => {
    const finallyAt = ZED_CREDENTIAL_CSHARP.indexOf('} finally {');
    expect(finallyAt).toBeGreaterThan(-1);
    expect(ZED_CREDENTIAL_CSHARP.indexOf('Marshal.WriteByte(blob, i, 0)')).toBeGreaterThan(finallyAt);
  });

  it('doubles a single quote in the key and the target', () => {
    const snippet = zedWindowsCredentialSnippet("https://gateway.example/it's", "sk-it's");
    expect(snippet).toContain("'zed:url=https://gateway.example/it''s'");
    expect(snippet).toContain("GetBytes('sk-it''s')");
  });
});

// The pasted VS Code document is what an operator gets when they will not run
// the installer, so it has to carry the same envelope the installer writes:
// the vendor VS Code dispatches on, the group name it is keyed by, the API path
// the group declares, and the per-model url and Authorization header the
// installer's merge attaches.
describe('VS Code config snippet', () => {
  const models = [{
    id: 'claude-opus-4-6', name: 'Claude Opus 4.6', toolCalling: true, vision: true,
    maxOutputTokens: 64_000, contextWindow: 200_000,
  }];

  it('carries the envelope the installer writes', () => {
    const snippet = JSON.parse(buildAgentVSCodeSnippet('https://gateway.example', 'sk-test', { providerName: 'Floway prod', apiType: 'responses' }, models));
    expect(snippet).toHaveLength(1);
    expect(snippet[0].vendor).toBe('customendpoint');
    expect(snippet[0].name).toBe('Floway prod');
    expect(snippet[0].apiType).toBe('responses');
    expect(snippet[0].models[0].url).toBe('https://gateway.example/v1');
    expect(snippet[0].models[0].requestHeaders.authorization).toBe('Bearer sk-test');
    // The key is the group's own field only in the installer's `apiKey`
    // property, which VS Code reads as a secret-storage reference — the paste
    // must not put it there either.
    expect(snippet[0].apiKey).toBeUndefined();
  });
});
