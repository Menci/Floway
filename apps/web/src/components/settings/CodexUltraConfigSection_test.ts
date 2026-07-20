import { mount } from '@vue/test-utils';
import { expect, test, vi } from 'vitest';
import { nextTick } from 'vue';

const mocks = vi.hoisted(() => ({
  put: vi.fn(async ({ json }: { json: unknown }) => Response.json(json)),
}));

vi.mock('../../api/client.ts', () => ({
  useApi: () => ({ api: { 'codex-ultra-config': { $put: mocks.put } } }),
  callApi: async (fn: () => Promise<Response>) => {
    const response = await fn();
    return { data: await response.json() };
  },
}));

const { default: CodexUltraConfigSection } = await import('./CodexUltraConfigSection.vue');

test('Codex Ultra settings enable an open-string redirect target and save it', async () => {
  const wrapper = mount(CodexUltraConfigSection, {
    props: {
      initialConfig: { enabled: false, redirectEffort: 'max' },
      initialError: null,
    },
  });

  const input = wrapper.find('input[list="codex-ultra-effort-suggestions"]');
  expect(input.attributes('disabled')).toBeDefined();
  expect(wrapper.text()).toContain('Ultra');
  expect(wrapper.text()).toContain('max');

  await wrapper.find('button[role="switch"]').trigger('click');
  await nextTick();
  expect(input.attributes('disabled')).toBeUndefined();

  await input.setValue('future-tier');
  const save = wrapper.findAll('button').find(button => button.text().includes('Save Ultra Config'));
  expect(save).toBeDefined();
  await save!.trigger('click');

  expect(mocks.put).toHaveBeenCalledWith({
    json: { enabled: true, redirectEffort: 'future-tier' },
  });
  expect(wrapper.text()).toContain('future-tier');
});

test('Codex Ultra settings surface their initial load error', () => {
  const wrapper = mount(CodexUltraConfigSection, {
    props: {
      initialConfig: { enabled: false, redirectEffort: 'max' },
      initialError: 'config unavailable',
    },
  });
  expect(wrapper.text()).toContain('config unavailable');
});
