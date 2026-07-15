import { mount } from '@vue/test-utils';
import { expect, test, vi } from 'vitest';
import { nextTick } from 'vue';

import { buildRealModel } from '../../api/test-fixtures.ts';
import type { SearchConfig, UpstreamProviderKind, UpstreamRecord } from '../../api/types.ts';

vi.mock('../../stores/auth.ts', () => ({ useAuthStore: () => ({ authToken: 'session' }) }));
vi.mock('../../api/client.ts', () => ({
  useApi: () => ({ api: {} }),
  callApi: vi.fn(),
}));

const { default: SearchConfigSection } = await import('./SearchConfigSection.vue');

const config: SearchConfig = {
  provider: 'tavily',
  tavily: { apiKey: 'key' },
  microsoftGrounding: { apiKey: '' },
  jina: { apiKey: '' },
  passthroughOpenAiSearch: { enabled: false, upstreamId: '', model: '' },
};

const upstream = (id: string, name: string, kind: UpstreamProviderKind): Pick<UpstreamRecord, 'id' | 'name' | 'kind' | 'enabled'> => ({
  id,
  name,
  kind,
  enabled: true,
});

test('OpenAI search passthrough exposes only Codex and Custom upstream models', async () => {
  const wrapper = mount(SearchConfigSection, {
    props: {
      initialConfig: config,
      upstreams: [
        upstream('up_codex', 'Codex Search', 'codex'),
        upstream('up_custom', 'Custom Search', 'custom'),
        upstream('up_azure', 'Azure Search', 'azure'),
      ],
      models: [
        buildRealModel({ id: 'gpt-codex', upstreams: [{ id: 'up_codex', name: 'Codex Search', kind: 'codex', color: null }] }),
        buildRealModel({ id: 'gpt-custom', upstreams: [{ id: 'up_custom', name: 'Custom Search', kind: 'custom', color: null }] }),
        buildRealModel({ id: 'gpt-azure', upstreams: [{ id: 'up_azure', name: 'Azure Search', kind: 'azure', color: null }] }),
      ],
    },
  });

  const toggle = wrapper.find('button[role="switch"]');
  expect(toggle.exists()).toBe(true);
  await toggle.trigger('click');
  await nextTick();

  expect(wrapper.text()).toContain('Search Upstream');
  expect(wrapper.text()).toContain('Search Model');
  expect(wrapper.text()).not.toContain('Azure Search');
});
