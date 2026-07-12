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
  it('keeps the Floway provider identity and namespaced base URL', () => {
    const wrapper = mount(CliSnippet, {
      props: {
        apiKey: 'sk-test',
        models: [buildRealModel({ id: 'gpt-5.5', endpoints: { responses: {} } })],
      },
    });

    const toml = wrapper.find('pre[data-language="toml"]').text();
    expect(toml).toContain('model_provider = "floway"');
    expect(toml).toContain('[model_providers.floway]');
    expect(toml).toContain('name = "Floway"');
    expect(toml).toContain('base_url = "http://localhost:3000/azure-api.codex"');
    expect(toml).toContain('[features]\napps = false');
    expect(toml).not.toContain('http_headers');
    expect(toml).not.toContain('image_generation');
    expect(toml).not.toContain('name = "OpenAI"');
  });
});
