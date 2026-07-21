import { mount } from '@vue/test-utils';
import { expect, test } from 'vitest';
import { nextTick } from 'vue';

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
  const valid = model('valid', { entries: [{ rates: { input_tokens: '1' } }] });
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

  await wrapper.setProps({ modelValue: [valid, model('fixed', { entries: [{ rates: { input_tokens: '2' } }] })] });
  await nextTick();
  expect(wrapper.emitted('update:invalid')?.at(-1)).toEqual([false]);
});

test('ModelsPanel refuses malformed pricing from JSON mode', async () => {
  const wrapper = mount(ModelsPanel, {
    props: {
      modelValue: [],
      disabledIds: [],
      flags: [],
      upstreamFlagOverrides: {},
      providerFlagDefaults: {} as FlagDefaults,
      upstreamIdLabel: 'Upstream Model ID',
      'onUpdate:modelValue': () => {},
      'onUpdate:disabledIds': () => {},
    },
    global: { stubs: { ModelsGrid: true, ModelEditor: true } },
  });

  await wrapper.findAll('button').find(button => button.text() === 'Edit as JSON')!.trigger('click');
  await wrapper.get('textarea[aria-label="Models JSON"]').setValue(JSON.stringify([{
    upstreamModelId: 'broken',
    endpoints: { chatCompletions: {} },
    pricing: { entries: 'not-an-array' },
  }]));
  await wrapper.findAll('button').find(button => button.text() === 'Edit with UI')!.trigger('click');

  expect(wrapper.text()).toContain('Cannot leave JSON mode:');
  expect(wrapper.find('textarea[aria-label="Models JSON"]').exists()).toBe(true);
});
