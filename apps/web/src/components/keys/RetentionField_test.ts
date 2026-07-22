import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { nextTick } from 'vue';

import RetentionField from './RetentionField.vue';

const mountField = (modelValue: number | null | 'invalid') => mount(RetentionField, {
  props: {
    modelValue,
    label: 'State retention',
    description: 'Description',
    offValue: 0,
    offLabel: 'Off',
    presets: [
      { seconds: 7 * 86400, label: '7 days' },
      { seconds: 30 * 86400, label: '30 days' },
    ],
  },
  global: {
    stubs: {
      Select: {
        props: ['modelValue', 'options'],
        emits: ['update:modelValue'],
        template: '<select :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value)"><option v-for="option in options" :key="option.value" :value="option.value">{{ option.label }}</option></select>',
      },
      Input: {
        props: ['modelValue', 'placeholder'],
        emits: ['update:modelValue'],
        template: '<input :value="modelValue" :placeholder="placeholder" @input="$emit(\'update:modelValue\', $event.target.value)">',
      },
    },
  },
});

describe('RetentionField', () => {
  it('emits off, preset, custom, and invalid values without conflating zero and null', async () => {
    const wrapper = mountField(0);
    const select = wrapper.get('select');

    await select.setValue(`seconds:${7 * 86400}`);
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toBe(7 * 86400);

    await select.setValue('custom');
    await wrapper.get('input').setValue('45d');
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toBe(45 * 86400);

    await wrapper.get('input').setValue('not-a-duration');
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toBe('invalid');

    await select.setValue('off');
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toBe(0);
  });

  it('renders an external custom value using the shortest exact unit', async () => {
    const wrapper = mountField(0);
    await wrapper.setProps({ modelValue: 14 * 86400 });
    await nextTick();

    expect((wrapper.get('select').element as HTMLSelectElement).value).toBe('custom');
    expect((wrapper.get('input').element as HTMLInputElement).value).toBe('14d');
  });
});
