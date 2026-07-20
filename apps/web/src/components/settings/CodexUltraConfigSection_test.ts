import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, expect, test, vi } from 'vitest';
import { nextTick } from 'vue';

const mocks = vi.hoisted(() => ({
  get: vi.fn(async () => Response.json({ enabled: true, redirectEffort: 'high' })),
  put: vi.fn(async ({ json }: { json: unknown }) => Response.json(json)),
  callApi: vi.fn(async (fn: () => Promise<Response>) => {
    const response = await fn();
    return { data: await response.json() };
  }),
}));

vi.mock('../../api/client.ts', () => ({
  useApi: () => ({ api: { 'codex-ultra-config': { $get: mocks.get, $put: mocks.put } } }),
  callApi: mocks.callApi,
}));

beforeEach(() => {
  mocks.get.mockReset().mockImplementation(async () => Response.json({ enabled: true, redirectEffort: 'high' }));
  mocks.put.mockReset().mockImplementation(async ({ json }: { json: unknown }) => Response.json(json));
  mocks.callApi.mockReset().mockImplementation(async (fn: () => Promise<Response>) => {
    const response = await fn();
    return { data: await response.json() };
  });
});

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

test('Codex Ultra settings block stale-default saves and retry the failed load', async () => {
  const wrapper = mount(CodexUltraConfigSection, {
    props: {
      initialConfig: { enabled: false, redirectEffort: 'max' },
      initialError: 'config unavailable',
    },
  });
  expect(wrapper.text()).toContain('config unavailable');
  expect(wrapper.find('button[role="switch"]').attributes('disabled')).toBeDefined();
  const save = wrapper.findAll('button').find(button => button.text().includes('Save Ultra Config'));
  expect(save?.attributes('disabled')).toBeDefined();

  const retry = wrapper.findAll('button').find(button => button.text().includes('Retry'));
  expect(retry).toBeDefined();
  await retry!.trigger('click');
  await flushPromises();
  await nextTick();

  expect(mocks.get).toHaveBeenCalledOnce();
  expect(wrapper.text()).not.toContain('config unavailable');
  expect(wrapper.find('button[role="switch"]').attributes('disabled')).toBeUndefined();
  expect(wrapper.find('label[for="codex-ultra-redirect-effort"]').exists()).toBe(true);
  expect(wrapper.find('#codex-ultra-redirect-effort').exists()).toBe(true);
});

test('Codex Ultra settings retain the draft and announce save failures', async () => {
  const wrapper = mount(CodexUltraConfigSection, {
    props: {
      initialConfig: { enabled: true, redirectEffort: 'max' },
      initialError: null,
    },
  });
  const input = wrapper.find('#codex-ultra-redirect-effort');
  await input.setValue('vendor-tier');
  mocks.callApi.mockResolvedValueOnce({ error: { status: 500, message: 'save unavailable' } });

  const save = wrapper.findAll('button').find(button => button.text().includes('Save Ultra Config'));
  await save!.trigger('click');
  await flushPromises();

  expect(wrapper.get('[role="alert"]').text()).toContain('save unavailable');
  expect((input.element as HTMLInputElement).value).toBe('vendor-tier');
});
