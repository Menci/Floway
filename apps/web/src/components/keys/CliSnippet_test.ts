import { mount } from '@vue/test-utils';
import { expect, test, vi } from 'vitest';
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

test('Codex setup uses API-key auth and client-owned search and image tools', () => {
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
    'auth = { command = "sh", args = ["-c", "cat \\"${CODEX_HOME:-$HOME/.codex}/floway-token\\""] }',
    'wire_api = "responses"',
    'http_headers = { "x-openai-actor-authorization" = "floway-client-tools" }',
    '',
    '[features]',
    'apps = false',
    'standalone_web_search = true',
  ].join('\n'));

  const credentialCommand = wrapper.findAll('pre[data-language="bash"]')
    .map(block => block.text())
    .find(code => code.includes('floway-token'));
  expect(credentialCommand).toBe([
    'codex_home="${CODEX_HOME:-$HOME/.codex}"',
    'mkdir -p "$codex_home" && \\',
    `  printf '%s' 'floway-'"'"'key' > "$codex_home/floway-token" && \\`,
    '  chmod 600 "$codex_home/floway-token"',
  ].join('\n'));
});
