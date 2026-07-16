import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';

import { buildRealModel } from '../../../api/test-fixtures.ts';
import type { ApiKey, ControlPlaneModel } from '../../../api/types.ts';
import KeysTable from '../../../components/keys/KeysTable.vue';

// The page renders behind a route data loader; the tests bypass navigation by
// stubbing defineBasicLoader so the composable hands back a ref the test owns.
const pageData = ref<{ keys: ApiKey[]; error: string | null }>({ keys: [], error: null });
vi.mock('unplugin-vue-router/data-loaders/basic', () => ({
  defineBasicLoader: () => () => ({ data: pageData }),
}));

const modelsRef = ref<ControlPlaneModel[]>([]);
const modelsLoading = ref(false);
const modelsError = ref<string | null>(null);
const addressableLoad = vi.fn(async () => {});
const limitedLoad = vi.fn(async () => {});

vi.mock('../../../composables/useModels.ts', () => ({
  useAddressableModelsStore: () => ({ models: modelsRef, loading: modelsLoading, error: modelsError, load: addressableLoad }),
  useModelsStore: () => ({ models: ref<ControlPlaneModel[]>([]), loading: ref(false), error: ref<string | null>(null), load: limitedLoad }),
}));
vi.mock('../../../composables/useUpstreamOptions.ts', () => ({
  useUpstreamOptionsStore: () => ({ options: ref([]), error: ref<string | null>(null), load: async () => {} }),
}));
vi.mock('../../../api/client.ts', () => ({
  useApi: () => ({ api: { keys: {} } }),
  callApi: async () => ({ data: [] as ApiKey[] }),
}));

// A recording stub for the card so the page test asserts the props flowing in
// without instantiating the real setup composable (which reaches Pinia + fetch).
let cardProps: Record<string, unknown> | null = null;
vi.mock('../../../components/keys/AgentSetupCard.vue', () => ({
  default: defineComponent({
    name: 'AgentSetupCard',
    props: { keys: { type: Array, default: () => [] }, models: { type: Array, default: () => [] }, loading: Boolean, error: { type: String, default: null } },
    setup(props) {
      cardProps = props;
      return () => h('div', { 'data-testid': 'agent-setup-card' });
    },
  }),
}));

const { default: KeysPage } = await import('./index.vue');

const mountPage = () => mount(KeysPage, {
  global: {
    stubs: {
      EditKeyDialog: true,
      Dialog: true,
    },
  },
});

const apiKey = (over: Partial<ApiKey> & { id: string; name: string }): ApiKey => ({
  key: 'sk-xxxx',
  created_at: '2026-01-01T00:00:00Z',
  last_used_at: null,
  upstream_ids: null,
  dump_retention_seconds: null,
  ...over,
});

beforeEach(() => {
  pageData.value = { keys: [], error: null };
  modelsRef.value = [buildRealModel({ id: 'claude-sonnet-4-5' }), buildRealModel({ id: 'gpt-5' })];
  cardProps = null;
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('KeysPage', () => {
  it('passes the account keys and addressable models into AgentSetupCard', () => {
    pageData.value = { keys: [apiKey({ id: 'k1', name: 'Primary' }), apiKey({ id: 'k2', name: 'CI' })], error: null };
    mountPage();

    expect(cardProps).not.toBeNull();
    expect((cardProps!.keys as ApiKey[]).map(k => k.id)).toEqual(['k1', 'k2']);
    expect((cardProps!.models as ControlPlaneModel[]).map(m => m.id)).toEqual(['claude-sonnet-4-5', 'gpt-5']);
  });

  it('drives the setup card off the addressable-models store, not the limited catalog', () => {
    mountPage();
    expect(addressableLoad).not.toBe(limitedLoad);
    // The card sees the addressable catalog the store exposes.
    expect((cardProps!.models as ControlPlaneModel[]).map(m => m.id)).toEqual(['claude-sonnet-4-5', 'gpt-5']);
  });

  it('renders the keys table without any snippet-era row-selection wiring', () => {
    pageData.value = { keys: [apiKey({ id: 'k1', name: 'Primary' })], error: null };
    const w = mountPage();
    const table = w.findComponent(KeysTable);
    expect(table.exists()).toBe(true);
    expect(table.props('keys')).toHaveLength(1);
    // Selection was a snippet-only affordance and is gone from the contract.
    expect(table.props()).not.toHaveProperty('selectedId');
  });
});
