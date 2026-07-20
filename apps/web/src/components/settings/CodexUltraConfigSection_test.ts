import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, expect, test, vi } from 'vitest';
import { nextTick } from 'vue';

const mocks = vi.hoisted(() => ({
  get: vi.fn(async () => Response.json({ enabled: true })),
  put: vi.fn(async ({ json }: { json: unknown }) => Response.json(json)),
  callApi: vi.fn(async (fn: () => Promise<Response>): Promise<{ data?: unknown; error?: { status: number; message: string } }> => {
    const response = await fn();
    return { data: await response.json() };
  }),
}));

vi.mock('../../api/client.ts', () => ({
  useApi: () => ({ api: { 'codex-ultra-config': { $get: mocks.get, $put: mocks.put } } }),
  callApi: mocks.callApi,
}));

beforeEach(() => {
  mocks.get.mockReset().mockImplementation(async () => Response.json({ enabled: true }));
  mocks.put.mockReset().mockImplementation(async ({ json }: { json: unknown }) => Response.json(json));
  mocks.callApi.mockReset().mockImplementation(async (fn: () => Promise<Response>): Promise<{ data?: unknown; error?: { status: number; message: string } }> => {
    const response = await fn();
    return { data: await response.json() };
  });
});

const { default: CodexUltraConfigSection } = await import('./CodexUltraConfigSection.vue');

test('Codex Ultra settings toggle and save the catalog switch', async () => {
  const wrapper = mount(CodexUltraConfigSection, {
    props: {
      initialConfig: { enabled: false },
      initialError: null,
    },
  });

  expect(wrapper.text()).toContain('Ultra');
  expect(wrapper.text()).toContain('max');
  expect(wrapper.text()).toContain('GPT models');

  await wrapper.find('button[role="switch"]').trigger('click');
  await nextTick();

  const save = wrapper.findAll('button').find(button => button.text().includes('Save Ultra Config'));
  expect(save).toBeDefined();
  await save!.trigger('click');

  expect(mocks.put).toHaveBeenCalledWith({
    json: { enabled: true },
  });
});

test('Codex Ultra settings block stale-default saves and retry the failed load', async () => {
  const wrapper = mount(CodexUltraConfigSection, {
    props: {
      initialConfig: { enabled: false },
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
  expect(wrapper.find('button[role="switch"]').attributes('aria-checked')).toBe('true');
});

test('Codex Ultra settings retain the draft and announce save failures', async () => {
  const wrapper = mount(CodexUltraConfigSection, {
    props: {
      initialConfig: { enabled: true },
      initialError: null,
    },
  });
  const toggle = wrapper.find('button[role="switch"]');
  await toggle.trigger('click');
  mocks.callApi.mockResolvedValueOnce({ error: { status: 500, message: 'save unavailable' } });

  const save = wrapper.findAll('button').find(button => button.text().includes('Save Ultra Config'));
  await save!.trigger('click');
  await flushPromises();

  expect(wrapper.get('[role="alert"]').text()).toContain('save unavailable');
  expect(toggle.attributes('aria-checked')).toBe('false');
});
