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
    `experimental_bearer_token = "floway-'key"`,
    'wire_api = "responses"',
    'http_headers = { "x-openai-actor-authorization" = "floway-client-tools" }',
    '',
    '[features]',
    'apps = false',
    'standalone_web_search = true',
  ].join('\n'));
});
