import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';

import { buildRealModel } from '../../api/test-fixtures.ts';

vi.mock('@floway-dev/ui', () => ({
  Code: defineComponent({
    props: {
      code: { type: String, required: true },
      language: { type: String, required: false },
    },
    template: '<pre :data-language="language">{{ code }}</pre>',
  }),
}));

const { default: CliSnippet } = await import('./CliSnippet.vue');

describe('CliSnippet Codex config', () => {
  it('uses provider-scoped auth and enables client-owned search and image tools', () => {
    const wrapper = mount(CliSnippet, {
      props: {
        apiKey: "floway-'key",
        models: [buildRealModel({ id: 'gpt-5.5', endpoints: { responses: {} } })],
      },
    });

    const config = wrapper.find('pre[data-language="toml"]').text();
    expect(config).toBe([
      'model = "gpt-5.5"',
      'model_provider = "floway"',
      '',
      '[model_providers.floway]',
      'name = "Floway"',
      'base_url = "http://localhost:3000/azure-api.codex"',
      'auth = { command = "sh", args = ["-c", "cat \\"${CODEX_HOME:-$HOME/.codex}/floway-token\\""] } # Linux & macOS',
      `# auth = { command = "powershell", args = ["-NoProfile", "-Command", "$h = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }; [IO.File]::ReadAllText((Join-Path $h 'floway-token'))"] } # Windows: uncomment and remove the line above`,
      'wire_api = "responses"',
      'supports_websockets = true',
      'http_headers = { "x-openai-actor-authorization" = "1" }',
      '',
      '[features]',
      'apps = false',
      'standalone_web_search = true',
    ].join('\n'));

    const unixCredential = wrapper.findAll('pre[data-language="bash"]')
      .map(block => block.text())
      .find(code => code.includes('floway-token'));
    expect(unixCredential).toBe([
      'codex_home="${CODEX_HOME:-$HOME/.codex}"',
      'mkdir -p "$codex_home" && \\',
      `  printf '%s' 'floway-'"'"'key' > "$codex_home/floway-token" && \\`,
      '  chmod 600 "$codex_home/floway-token"',
    ].join('\n'));

    expect(wrapper.find('pre[data-language="text"]').text()).toBe([
      '$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }',
      'New-Item -ItemType Directory -Force -Path $codexHome | Out-Null',
      `[IO.File]::WriteAllText((Join-Path $codexHome "floway-token"), 'floway-''key', (New-Object Text.UTF8Encoding($false)))`,
    ].join('\n'));
  });
});
