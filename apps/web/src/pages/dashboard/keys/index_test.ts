import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';

import { buildRealModel } from '../../../api/test-fixtures.ts';
import type { ApiKey, ControlPlaneModel } from '../../../api/types.ts';
import KeysTable from '../../../components/keys/KeysTable.vue';

// The page renders behind a route data loader; the tests bypass navigation by
// stubbing defineBasicLoader so the composable hands back a ref the test owns.
const pageData = ref<{ keys: ApiKey[]; error: string | null }>({ keys: [], error: null });
const persistedSelectedKeyId = ref('');
vi.mock('@vueuse/core', () => ({ useLocalStorage: () => persistedSelectedKeyId }));
vi.mock('unplugin-vue-router/data-loaders/basic', () => ({
  defineBasicLoader: () => () => ({ data: pageData }),
}));

const modelsRef = ref<ControlPlaneModel[]>([]);
const modelsLoading = ref(false);
const modelsError = ref<string | null>(null);
const addressableLoad = vi.fn(async () => {});
const limitedLoad = vi.fn(async () => {});
const loadedKeys = ref<ApiKey[]>([]);
const currentUser = {
  id: 1,
  username: 'admin',
  isAdmin: true,
  canViewGlobalTelemetry: true,
  upstreamIds: null as string[] | null,
};

vi.mock('../../../composables/useModels.ts', () => ({
  useAddressableModelsStore: () => ({ models: modelsRef, loading: modelsLoading, error: modelsError, load: addressableLoad }),
  useModelsStore: () => ({ models: ref<ControlPlaneModel[]>([]), loading: ref(false), error: ref<string | null>(null), load: limitedLoad }),
}));
vi.mock('../../../composables/useUpstreamOptions.ts', () => ({
  useUpstreamOptionsStore: () => ({ options: ref([]), error: ref<string | null>(null), load: async () => {} }),
}));
vi.mock('../../../stores/auth.ts', () => ({
  useAuthStore: () => ({ currentUser }),
}));
vi.mock('../../../api/client.ts', () => ({
  useApi: () => ({ api: { keys: {} } }),
  callApi: async () => ({ data: loadedKeys.value }),
}));

// A recording stub for the card so the page test asserts the props flowing in
// without instantiating the real setup composable (which reaches Pinia + fetch).
let cardProps: Record<string, unknown> | null = null;
let cardMounts = 0;
vi.mock('../../../components/keys/AgentSetupCard.vue', () => ({
  default: defineComponent({
    name: 'AgentSetupCard',
    props: { selectedKey: { type: Object, default: null }, models: { type: Array, default: () => [] }, loading: Boolean, error: { type: String, default: null } },
    setup(props) {
      cardMounts += 1;
      cardProps = props;
      return () => h('div', { 'data-testid': 'agent-setup-card' });
    },
  }),
}));

const { default: KeysPage } = await import('./index.vue');

const EditKeyDialogStub = defineComponent({
  name: 'EditKeyDialog',
  emits: ['saved'],
  template: '<div data-testid="edit-key-dialog" />',
});

const mountPage = () => mount(KeysPage, {
  global: {
    stubs: {
      EditKeyDialog: EditKeyDialogStub,
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
  loadedKeys.value = [];
  persistedSelectedKeyId.value = '';
  currentUser.upstreamIds = null;
  cardProps = null;
  cardMounts = 0;
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('KeysPage', () => {
  it('starts without a selected key and passes addressable models into AgentSetupCard', () => {
    pageData.value = { keys: [apiKey({ id: 'k1', name: 'Primary' }), apiKey({ id: 'k2', name: 'CI' })], error: null };
    mountPage();

    expect(cardProps).not.toBeNull();
    expect(cardProps!.selectedKey).toBeNull();
    expect((cardProps!.models as ControlPlaneModel[]).map(m => m.id)).toEqual(['claude-sonnet-4-5', 'gpt-5']);
  });

  it('drives the setup card off the addressable-models store, not the limited catalog', () => {
    mountPage();
    expect(addressableLoad).not.toBe(limitedLoad);
    // The card sees the addressable catalog the store exposes.
    expect((cardProps!.models as ControlPlaneModel[]).map(m => m.id)).toEqual(['claude-sonnet-4-5', 'gpt-5']);
  });

  it('uses the table selection as the selected key for agent configuration', async () => {
    pageData.value = { keys: [apiKey({ id: 'k1', name: 'Primary' }), apiKey({ id: 'k2', name: 'CI' })], error: null };
    const w = mountPage();
    const table = w.findComponent(KeysTable);
    expect(table.exists()).toBe(true);
    expect(table.props('selectedId')).toBe('');

    table.vm.$emit('select', 'k2');
    await nextTick();
    expect(table.props('selectedId')).toBe('k2');
    expect((cardProps!.selectedKey as ApiKey).id).toBe('k2');
    expect(cardMounts).toBe(1);
  });

  it('projects the addressable catalog through the selected key and user upstream caps', async () => {
    const binding = (id: string) => [{ id, name: id, kind: 'custom' as const, color: null }];
    modelsRef.value = [
      buildRealModel({ id: 'claude-allowed', upstreams: binding('u1') }),
      buildRealModel({ id: 'gpt-key-denied', upstreams: binding('u2') }),
      buildRealModel({ id: 'gpt-user-denied', upstreams: binding('u3') }),
    ];
    currentUser.upstreamIds = ['u1', 'u2'];
    pageData.value = {
      keys: [
        apiKey({ id: 'k1', name: 'Restricted', upstream_ids: ['u1'] }),
        apiKey({ id: 'k2', name: 'Broader', upstream_ids: ['u1', 'u2', 'u3'] }),
      ],
      error: null,
    };
    persistedSelectedKeyId.value = 'k1';
    const w = mountPage();

    expect((cardProps!.models as ControlPlaneModel[]).map(model => model.id)).toEqual(['claude-allowed']);

    w.getComponent(KeysTable).vm.$emit('select', 'k2');
    await nextTick();
    expect((cardProps!.models as ControlPlaneModel[]).map(model => model.id)).toEqual(['claude-allowed', 'gpt-key-denied']);
  });

  it('restores the previous table selection when that key still exists', () => {
    pageData.value = { keys: [apiKey({ id: 'k1', name: 'Primary' }), apiKey({ id: 'k2', name: 'CI' })], error: null };
    persistedSelectedKeyId.value = 'k2';
    const w = mountPage();
    expect(w.getComponent(KeysTable).props('selectedId')).toBe('k2');
    expect((cardProps!.selectedKey as ApiKey).id).toBe('k2');
  });

  it('clears a previous selection that no longer exists', () => {
    pageData.value = { keys: [apiKey({ id: 'k1', name: 'Primary' })], error: null };
    persistedSelectedKeyId.value = 'gone';
    const w = mountPage();
    expect(w.getComponent(KeysTable).props('selectedId')).toBe('');
    expect(cardProps!.selectedKey).toBeNull();
  });

  it('selects a newly created API key after reloading the table', async () => {
    const existing = apiKey({ id: 'k1', name: 'Primary' });
    const created = apiKey({ id: 'k2', name: 'New key' });
    pageData.value = { keys: [existing], error: null };
    loadedKeys.value = [existing, created];
    const w = mountPage();

    w.getComponent(EditKeyDialogStub).vm.$emit('saved', created);
    await flushPromises();
    expect(w.getComponent(KeysTable).props('selectedId')).toBe('k2');
    expect((cardProps!.selectedKey as ApiKey).id).toBe('k2');
  });
});
