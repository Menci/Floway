import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { expect, test } from 'vitest';

import ModelsPanel from './ModelsPanel.vue';
import type { UpstreamModelConfig } from '../../api/types.ts';
import type { FlagDefaults } from '@floway-dev/provider/flags';

const model = (upstreamModelId: string, pricing: UpstreamModelConfig['pricing']): UpstreamModelConfig => ({
  upstreamModelId,
  kind: 'chat',
  endpoints: { chatCompletions: {} },
  pricing,
});

test('ModelsPanel validates every manual row before it is selected', async () => {
  const valid = model('valid', { entries: [{ rates: { input: 1 } }] });
  const invalid = model('invalid', { entries: [] });
  const wrapper = mount(ModelsPanel, {
    props: {
      modelValue: [valid, invalid],
      disabledIds: [],
      flags: [],
      upstreamFlagOverrides: {},
      providerFlagDefaults: {} as FlagDefaults,
      upstreamIdLabel: 'Upstream Model ID',
      'onUpdate:modelValue': () => {},
      'onUpdate:disabledIds': () => {},
    },
    global: {
      stubs: {
        ModelsGrid: true,
        ModelEditor: true,
      },
    },
  });
  await nextTick();
  expect(wrapper.emitted('update:invalid')?.at(-1)).toEqual([true]);

  await wrapper.setProps({ modelValue: [valid, model('fixed', { entries: [{ rates: { input: 2 } }] })] });
  await nextTick();
  expect(wrapper.emitted('update:invalid')?.at(-1)).toEqual([false]);
});
