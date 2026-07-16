import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';

import { buildRealModel } from '../../api/test-fixtures.ts';
import type { ApiKey } from '../../api/types.ts';

vi.mock('@floway-dev/ui', () => ({
  Code: defineComponent({
    props: {
      code: { type: String, required: true },
      language: { type: String, required: false },
    },
    template: '<pre :data-language="language">{{ code }}</pre>',
  }),
}));

const { default: AgentConfigSnippets } = await import('./AgentConfigSnippets.vue');

const key = (id: string, name: string, raw: string): ApiKey => ({
  id,
  name,
  key: raw,
  created_at: '2026-01-01T00:00:00Z',
  last_used_at: null,
  upstream_ids: null,
  dump_retention_seconds: null,
});

const models = [
  buildRealModel({ id: 'claude-sonnet-4-5', endpoints: { messages: {} }, limits: { max_context_window_tokens: 1_000_000 } }),
  buildRealModel({ id: 'claude-haiku-4-5', endpoints: { messages: {} } }),
  buildRealModel({ id: 'gpt-5.5', endpoints: { responses: {} } }),
];

describe('AgentConfigSnippets', () => {
  it('renders Claude configuration as settings JSON rather than shell exports', () => {
    const wrapper = mount(AgentConfigSnippets, { props: { keys: [key('key-1', 'Primary', 'floway-key')], models } });
    const json = wrapper.find('pre[data-language="json"]').text();

    expect(wrapper.text()).toContain('Edit ~/.claude/settings.json and merge this JSON object');
    expect(wrapper.text()).toContain('Do not export these values as shell environment variables');
    expect(json).toContain('"ANTHROPIC_AUTH_TOKEN": "floway-key"');
    expect(json).toContain('"ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4-5[1m]"');
    expect(json).not.toContain('export ');
  });

  it('switches every credential snippet to the selected API key', async () => {
    const wrapper = mount(AgentConfigSnippets, {
      props: { keys: [key('key-1', 'Primary', 'first-key'), key('key-2', 'CI', "floway-'key")], models },
    });
    await wrapper.get('select').setValue('key-2');

    expect(wrapper.find('pre[data-language="json"]').text()).toContain("floway-'key");
    const unixCredential = wrapper.findAll('pre[data-language="bash"]')
      .map(block => block.text())
      .find(code => code.includes('floway-token'));
    expect(unixCredential).toContain(`printf '%s' 'floway-'"'"'key'`);
    expect(wrapper.find('pre[data-language="text"]').text()).toContain("'floway-''key'");
  });

  it('uses provider-scoped Codex auth and enables the client-owned tools', () => {
    const wrapper = mount(AgentConfigSnippets, { props: { keys: [key('key-1', 'Primary', 'floway-key')], models } });
    const config = wrapper.find('pre[data-language="toml"]').text();

    expect(config).toContain('model = "gpt-5.5"');
    expect(config).toContain('/azure-api.codex');
    expect(config).toContain('floway-token');
    expect(config).toContain('supports_websockets = true');
    expect(config).toContain('"x-openai-actor-authorization" = "1"');
    expect(config).toContain('standalone_web_search = true');
  });
});
