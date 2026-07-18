import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';

import type { ApiKey } from '../../api/types.ts';
import type { AgentSetupConfiguration } from '../../composables/useAgentSetup.ts';

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

const configuration = (): AgentSetupConfiguration => ({
  apiKeyId: 'key-1',
  claudeCode: {
    model: 'claude-sonnet-4-5[1m]',
    defaultOpusModel: 'claude-opus-4-8',
    defaultSonnetModel: 'claude-sonnet-4-5[1m]',
    defaultHaikuModel: 'claude-haiku-4-5',
    effortLevel: 'high',
    modelDiscovery: true,
  },
  codex: { model: 'gpt-5.6-sol', reasoningEffort: 'xhigh' },
});

describe('AgentConfigSnippets', () => {
  it('renders the shared Claude configuration as a settings JSON edit without duplicate controls', () => {
    const wrapper = mount(AgentConfigSnippets, {
      props: { agent: 'claude', apiKey: key('key-1', 'Primary', 'floway-key'), configuration: configuration() },
    });
    const json = wrapper.find('pre[data-language="json"]').text();

    expect(wrapper.text()).toContain('Edit ~/.claude/settings.json and merge this JSON object');
    expect(wrapper.text()).toContain('Do not export these values as shell environment variables');
    expect(wrapper.find('select').exists()).toBe(false);
    expect(json).toContain('"ANTHROPIC_AUTH_TOKEN": "floway-key"');
    expect(json).toContain('"ANTHROPIC_MODEL": "claude-sonnet-4-5[1m]"');
    expect(json).toContain('"ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4-5"');
    expect(json).toContain('"CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1"');
    expect(json).toContain('"effortLevel": "high"');
    expect(json).not.toContain('export ');
  });

  it('switches every credential snippet when the selected API key changes', async () => {
    const wrapper = mount(AgentConfigSnippets, {
      props: { agent: 'codex', apiKey: key('key-1', 'Primary', 'first-key'), configuration: configuration() },
    });
    await wrapper.setProps({ apiKey: key('key-2', 'CI', "floway-'key") });

    const unixCredential = wrapper.findAll('pre[data-language="bash"]')
      .map(block => block.text())
      .find(code => code.includes('floway-token'));
    expect(unixCredential).toContain(`printf '%s' 'floway-'"'"'key'`);
    expect(wrapper.find('pre[data-language="powershell"]').text()).toContain("'floway-''key'");
  });

  it('uses the shared Codex choices with provider-scoped auth and client-owned tools', () => {
    const wrapper = mount(AgentConfigSnippets, {
      props: { agent: 'codex', apiKey: key('key-1', 'Primary', 'floway-key'), configuration: configuration() },
    });
    const config = wrapper.find('pre[data-language="toml"]').text();

    expect(wrapper.find('select').exists()).toBe(false);
    expect(config).toContain('model = "gpt-5.6-sol"');
    expect(config).toContain('model_reasoning_effort = "xhigh"');
    expect(config).toContain('/azure-api.codex');
    expect(config).toContain('floway-token');
    expect(config).toContain('supports_websockets = true');
    expect(config).toContain('"x-openai-actor-authorization" = "1"');
    expect(config).toContain('standalone_web_search = true');
    expect(config).toContain('suppress_unstable_features_warning = true');
  });
});
