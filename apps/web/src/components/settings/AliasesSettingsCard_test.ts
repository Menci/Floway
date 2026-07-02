import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';

import { buildRealModel } from '../../api/test-fixtures.ts';
import type { ControlPlaneModel, ModelAlias } from '../../api/types.ts';

const aliasesRef = ref<ModelAlias[]>([]);
const modelsRef = ref<ControlPlaneModel[]>([]);
const aliasErrorRef = ref<string | null>(null);
const deleteSpy = vi.fn(async (_arg: unknown) => new Response(null, { status: 204 }));

vi.mock('../../composables/useModelAliases.ts', () => ({
  useModelAliases: () => ({ aliases: aliasesRef, loading: ref(false), error: aliasErrorRef, load: async () => {} }),
}));
vi.mock('../../composables/useModels.ts', () => ({
  useRawModelsStore: () => ({ models: modelsRef, loading: ref(false), error: ref<string | null>(null), load: async () => {} }),
}));
vi.mock('../../api/client.ts', () => ({
  useApi: () => ({
    api: {
      aliases: {
        ':name': { $delete: (arg: unknown) => deleteSpy(arg) },
      },
    },
  }),
  callApi: async <T>(fn: () => Promise<Response>) => {
    const res = await fn();
    if (!res.ok && res.status !== 204) return { error: { status: res.status, message: 'mock-error' } };
    return { data: undefined as T };
  },
  authFetch: vi.fn(),
}));

const { default: AliasesSettingsCard } = await import('./AliasesSettingsCard.vue');

const baseAlias = (over: Partial<ModelAlias> & { name: string }): ModelAlias => ({
  kind: 'chat',
  selection: 'first-available',
  display_name: null,
  visible_in_models_list: true,
  targets: [{ target_model_id: 'gpt-5', rules: {} }],
  announced_metadata: null,
  sort_order: 0,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  ...over,
});

beforeEach(() => {
  aliasesRef.value = [];
  // Seed the catalog with the alias fixtures' target ids so the
  // no-target alias-level warning stays quiet by default — every test
  // that wants the warning sets `modelsRef.value = []` itself.
  modelsRef.value = [
    buildRealModel({ id: 'gpt-5' }),
  ];
  aliasErrorRef.value = null;
  deleteSpy.mockClear();
  vi.restoreAllMocks();
  // happy-dom does not stub window.confirm / window.alert by default; install
  // a no-op pair every test overrides per-case via reassignment.
  window.confirm = () => true;
  window.alert = () => {};
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('AliasesSettingsCard', () => {
  it('renders the empty-state copy when no aliases are configured', () => {
    const w = mount(AliasesSettingsCard);
    expect(w.text()).toContain('No aliases configured');
  });

  it('renders one row per alias', () => {
    aliasesRef.value = [
      baseAlias({ name: 'a' }),
      baseAlias({ name: 'b' }),
    ];
    const w = mount(AliasesSettingsCard);
    expect(w.findAll('button[aria-label="Edit alias"]')).toHaveLength(2);
  });

  it('emits add when the "Add Alias" button is clicked', async () => {
    const w = mount(AliasesSettingsCard);
    const addBtn = w.findAll('button').find(b => b.text() === 'Add Alias')!;
    await addBtn.trigger('click');
    expect(w.emitted('add')).toHaveLength(1);
  });

  it('prompts confirm and calls DELETE, then emits changed when the trash button fires and the user confirms', async () => {
    aliasesRef.value = [baseAlias({ name: 'doomed' })];
    window.confirm = () => true;
    const w = mount(AliasesSettingsCard);
    await w.find('button[aria-label="Delete alias"]').trigger('click');
    await nextTick();
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(w.emitted('changed')).toHaveLength(1);
  });

  it('skips the DELETE call when the user cancels the confirm prompt', async () => {
    aliasesRef.value = [baseAlias({ name: 'doomed' })];
    window.confirm = () => false;
    const w = mount(AliasesSettingsCard);
    await w.find('button[aria-label="Delete alias"]').trigger('click');
    await nextTick();
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(w.emitted('changed')).toBeUndefined();
  });
});
