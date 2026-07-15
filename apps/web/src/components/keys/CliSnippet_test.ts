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
    'chatgpt_base_url = "http://localhost:3000/azure-api.codex"',
    '',
    '[model_providers.floway]',
    'name = "Floway"',
    'base_url = "http://localhost:3000/azure-api.codex"',
    'wire_api = "responses"',
    'http_headers = { "x-openai-actor-authorization" = "floway-client-tools" }',
    '',
    '[features]',
    'apps = false',
    'standalone_web_search = true',
  ].join('\n'));

  const authCommand = wrapper.findAll('pre[data-language="bash"]')
    .map(block => block.text())
    .find(code => code.includes('auth.json'));
  if (authCommand === undefined) throw new Error('Codex auth command was not rendered');
  expect(authCommand).toContain('cp ~/.codex/auth.json ~/.codex/auth.json.bak.$(date +%s)');
  const auth = JSON.parse(authCommand.split('\n')[3]) as {
    auth_mode: string;
    tokens: { id_token: string; access_token: string; refresh_token: string };
  };
  expect(auth.auth_mode).toBe('chatgpt');
  expect(auth.tokens.access_token).toBe("floway-'key");
  expect(auth.tokens.refresh_token).toBe('noop');
  expect(auth.tokens.id_token.split('.')).toHaveLength(3);
});
