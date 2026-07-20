import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';

import { buildRealModel } from '../../api/test-fixtures.ts';
import type { ControlPlaneModel, ModelAlias } from '../../api/types.ts';
import { Select } from '@floway-dev/ui';

// Mock the API client + composables so the dialog mounts without hitting the
// network. The composables expose `ref`-based state — return the same shape
// so the dialog reads the catalog and the alias list directly off these
// stubs.
const aliasesRef = ref<ModelAlias[]>([]);
const modelsRef = ref<ControlPlaneModel[]>([]);
const postSpy = vi.fn(async (_arg: unknown) => new Response(JSON.stringify({}), { status: 201 }));
const putSpy = vi.fn(async (_arg: unknown) => new Response(JSON.stringify({}), { status: 200 }));

vi.mock('../../composables/useModelAliases.ts', () => ({
  useModelAliases: () => ({ aliases: aliasesRef, loading: ref(false), error: ref<string | null>(null), load: async () => {} }),
}));
vi.mock('../../composables/useModels.ts', () => ({
  useRawModelsStore: () => ({ models: modelsRef, loading: ref(false), error: ref<string | null>(null), load: async () => {} }),
}));
vi.mock('../../api/client.ts', () => ({
  useApi: () => ({
    api: {
      aliases: {
        $post: (arg: unknown) => postSpy(arg),
        ':name': { $put: (arg: unknown) => putSpy(arg) },
      },
    },
  }),
  callApi: async <T>(fn: () => Promise<Response>) => {
    const res = await fn();
    if (!res.ok) return { error: { status: res.status, message: 'mock-error' } };
    return { data: (await res.json()) as T };
  },
  authFetch: vi.fn(),
}));

// Import after mocks are registered.
const { default: AliasEditDialog } = await import('./AliasEditDialog.vue');

const realModel = (id: string, display?: string): ControlPlaneModel =>
  buildRealModel(display !== undefined ? { id, display_name: display } : { id });

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

// Reka-UI's DialogPortal teleports content out of the wrapper. Read the
// portal-rooted DOM by scanning document.body directly.
const portalText = () => document.body.textContent ?? '';
const portalQuery = <T extends Element>(selector: string): T | null => document.body.querySelector<T>(selector);
const portalQueryAll = <T extends Element>(selector: string): T[] => Array.from(document.body.querySelectorAll<T>(selector));

beforeEach(() => {
  aliasesRef.value = [];
  modelsRef.value = [realModel('gpt-5', 'GPT 5'), realModel('claude')];
  postSpy.mockClear();
  putSpy.mockClear();
});

afterEach(() => {
  // Reka-UI portals append to document.body; clear them between tests so
  // subsequent assertions don't see stale content.
  document.body.innerHTML = '';
});

describe('AliasEditDialog', () => {
  it('starts create mode with one blank target row and seeds the form fields', async () => {
    const w = mount(AliasEditDialog, { props: { open: true, record: null }, attachTo: document.body });
    await nextTick();
    expect(portalQueryAll('[aria-label="Toggle target row"]')).toHaveLength(1);
    const inputs = portalQueryAll<HTMLInputElement>('input[type="text"]');
    expect(inputs[0].value).toBe('');
    w.unmount();
  });

  it('"Add target" appends a row', async () => {
    const w = mount(AliasEditDialog, { props: { open: true, record: null }, attachTo: document.body });
    await nextTick();
    expect(portalQueryAll('[aria-label="Toggle target row"]')).toHaveLength(1);
    const addBtn = portalQueryAll<HTMLButtonElement>('button').find(b => b.textContent?.trim() === 'Add target')!;
    addBtn.click();
    await nextTick();
    expect(portalQueryAll('[aria-label="Toggle target row"]')).toHaveLength(2);
    w.unmount();
  });

  it('expands the chat rule body for chat aliases; the row toggle is disabled for non-chat aliases', async () => {
    const chat = mount(AliasEditDialog, {
      props: { open: true, record: baseAlias({ name: 'a', targets: [{ target_model_id: 'gpt-5', rules: { reasoning: { effort: 'low' } } }] }) },
      attachTo: document.body,
    });
    await nextTick();
    portalQuery<HTMLButtonElement>('button[aria-label="Toggle target row"]')!.click();
    await nextTick();
    expect(portalText()).toContain('Reasoning effort');
    chat.unmount();
    document.body.innerHTML = '';

    const embed = mount(AliasEditDialog, {
      props: { open: true, record: baseAlias({ name: 'e', kind: 'embedding', targets: [{ target_model_id: 'embed-1', rules: {} as never }] }) },
      attachTo: document.body,
    });
    await nextTick();
    const toggle = portalQuery<HTMLButtonElement>('button[aria-label="Toggle target row"]')!;
    expect(toggle.disabled).toBe(true);
    expect(portalText()).not.toContain('Reasoning effort');
    embed.unmount();
  });

  it('Save is disabled on empty name and on collision with another alias; enabled once the name is unique', async () => {
    aliasesRef.value = [baseAlias({ name: 'existing' })];
    // Seed the edit dialog with a valid target so the only validation knob
    // under test is the alias name (the borderless combobox in the target
    // row doesn't surface a plain HTMLInput we can drive from the test).
    const w = mount(AliasEditDialog, {
      props: {
        open: true,
        record: baseAlias({ name: '', targets: [{ target_model_id: 'gpt-5', rules: {} }] }),
      },
      attachTo: document.body,
    });
    await nextTick();

    const saveBtn = portalQueryAll<HTMLButtonElement>('button').find(b => b.textContent?.trim() === 'Save')!;
    expect(saveBtn.disabled).toBe(true);

    const nameInput = portalQueryAll<HTMLInputElement>('input[type="text"]')[0];
    nameInput.value = 'existing';
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    expect(saveBtn.disabled).toBe(true);

    nameInput.value = 'fresh';
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    expect(saveBtn.disabled).toBe(false);

    w.unmount();
  });

  it('renders the shadow warning card when the alias name collides with a real model and no target references it', async () => {
    const w = mount(AliasEditDialog, { props: { open: true, record: null }, attachTo: document.body });
    await nextTick();

    const nameInput = portalQueryAll<HTMLInputElement>('input[type="text"]')[0];
    nameInput.value = 'gpt-5';
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();

    expect(portalText()).toContain('shadows a real model id');
    expect(document.body.innerHTML).toContain('<strong class="font-semibold">GPT 5</strong>');
    w.unmount();
  });

  // ── Announced metadata section ────────────────────────────────────────

  // The section header always renders for chat/embedding; the body only
  // renders the editor when the "Manual" switch is on. Image and rerank
  // aliases never see the section.

  const expandAnnouncedSection = async () => {
    const header = portalQueryAll<HTMLButtonElement>('button').find(b => (b.textContent ?? '').includes('Announced metadata'))!;
    header.click();
    await nextTick();
  };

  const announcedSwitch = (): HTMLButtonElement => {
    // The override switch sits at the right end of the section header
    // row. Reka-UI renders Switch as a <button role="switch">, so scan
    // by role + the surrounding "Manual" label.
    const label = Array.from(document.body.querySelectorAll<HTMLLabelElement>('label')).find(l => (l.textContent ?? '').includes('Manual'))!;
    return label.querySelector<HTMLButtonElement>('button[role="switch"]')!;
  };

  // Locate the "Effort levels" toggle inside the ChatMetadataEditor by
  // scanning labels in the portal-rooted DOM. Reka-UI renders Switch as
  // a `<button role="switch">`, sitting next to its caption.
  const effortSwitch = (): HTMLButtonElement | null => {
    const label = Array.from(document.body.querySelectorAll<HTMLLabelElement>('label'))
      .find(l => (l.textContent ?? '').trim().startsWith('Effort levels'));
    return label?.querySelector<HTMLButtonElement>('button[role="switch"]') ?? null;
  };

  it('announced metadata: override off → editor renders in auto (read-only) mode', async () => {
    const w = mount(AliasEditDialog, {
      props: { open: true, record: baseAlias({ name: 'a', targets: [{ target_model_id: 'gpt-5', rules: {} }] }) },
      attachTo: document.body,
    });
    await nextTick();
    await expandAnnouncedSection();

    // The override switch is present but off.
    expect(announcedSwitch().getAttribute('aria-checked')).toBe('false');
    // The shared editor mounts and renders the Reasoning toggles, but
    // every Switch in there is disabled because mode='auto'.
    const sw = effortSwitch();
    expect(sw).not.toBeNull();
    expect(sw!.disabled).toBe(true);
    w.unmount();
  });

  it('announced metadata: toggling override on switches the editor into manual (enabled) mode and seeds it from the computed view', async () => {
    modelsRef.value = [
      buildRealModel({
        id: 'gpt-5',
        display_name: 'GPT 5',
        chat: { reasoning: { effort: { supported: ['low', 'medium'], default: 'medium' } } },
      }),
    ];
    const w = mount(AliasEditDialog, {
      props: { open: true, record: baseAlias({ name: 'a', targets: [{ target_model_id: 'gpt-5', rules: {} }] }) },
      attachTo: document.body,
    });
    await nextTick();
    await expandAnnouncedSection();

    announcedSwitch().click();
    await nextTick();

    // The editor now accepts input.
    const sw = effortSwitch();
    expect(sw).not.toBeNull();
    expect(sw!.disabled).toBe(false);
    // The frozen seed includes the computed `medium` default, so the
    // editor's pinned-default tag for `medium` is part of the visible DOM.
    expect(portalText()).toContain('medium');
    w.unmount();
  });

  it('announced metadata: toggling override off restores auto (read-only) mode', async () => {
    const w = mount(AliasEditDialog, {
      props: { open: true, record: baseAlias({ name: 'a', targets: [{ target_model_id: 'gpt-5', rules: {} }] }) },
      attachTo: document.body,
    });
    await nextTick();
    await expandAnnouncedSection();

    const sw = announcedSwitch();
    sw.click(); await nextTick();
    expect(effortSwitch()!.disabled).toBe(false);
    sw.click(); await nextTick();
    // Auto mode: effort switch disabled again.
    expect(effortSwitch()!.disabled).toBe(true);
    w.unmount();
  });

  it('announced metadata: image-kind aliases never see the section', async () => {
    const w = mount(AliasEditDialog, {
      props: { open: true, record: baseAlias({ name: 'img', kind: 'image', targets: [{ target_model_id: 'dalle', rules: {} as never }] }) },
      attachTo: document.body,
    });
    await nextTick();
    expect(portalText()).not.toContain('Announced metadata');
    w.unmount();
  });

  it('switching a chat alias with announced chat metadata to rerank clears the override', async () => {
    const wrapper = mount(AliasEditDialog, {
      props: {
        open: true,
        record: baseAlias({
          name: 'reranker',
          announced_metadata: { chat: { reasoning: { mandatory: true } } },
        }),
      },
      attachTo: document.body,
    });
    await nextTick();

    (wrapper.findAllComponents(Select)[0] as unknown as VueWrapper).vm.$emit('update:modelValue', 'rerank');
    await nextTick();
    expect(portalText()).not.toContain('Announced metadata');

    const save = portalQueryAll<HTMLButtonElement>('button').find(button => button.textContent?.trim() === 'Save')!;
    save.click();
    await nextTick();
    expect(putSpy.mock.calls.at(-1)?.[0]).toMatchObject({ json: { kind: 'rerank', announced_metadata: null } });
    wrapper.unmount();
  });
});
