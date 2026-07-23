import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { nextTick } from 'vue';

import RetentionField from './RetentionField.vue';

const mountField = (
  modelValue: number | null | 'invalid',
  offValue: 0 | null = 0,
  customInputUnit: 'duration' | 'days' = 'duration',
) => mount(RetentionField, {
  props: {
    modelValue,
    label: 'State retention',
    description: 'Description',
    offValue,
    offLabel: 'Off',
    presets: [
      { seconds: 7 * 86400, label: '7 days' },
      { seconds: 30 * 86400, label: '30 days' },
    ],
    customInputUnit,
    ...(customInputUnit === 'days' ? { minimumSeconds: 86400 } : {}),
  },
  global: {
    stubs: {
      Select: {
        props: ['modelValue', 'options'],
        emits: ['update:modelValue'],
        template: '<select :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value)"><option v-for="option in options" :key="option.value" :value="option.value">{{ option.label }}</option></select>',
      },
      Input: {
        props: ['modelValue', 'placeholder', 'type'],
        emits: ['update:modelValue'],
        template: '<input :type="type" :value="modelValue" :placeholder="placeholder" @input="$emit(\'update:modelValue\', $event.target.value)">',
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
    expect(wrapper.get('input').attributes('aria-invalid')).toBe('true');
    expect(wrapper.text()).toContain('Enter an integer number of seconds');

    await select.setValue('off');
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toBe(0);

    const nullOff = mountField(7 * 86400, null);
    await nullOff.get('select').setValue('off');
    expect(nullOff.emitted('update:modelValue')?.at(-1)?.[0]).toBeNull();
  });

  it('puts the field label and description on the real Select trigger', () => {
    const wrapper = mount(RetentionField, {
      props: {
        modelValue: 0,
        label: 'State retention',
        description: 'Description',
        offValue: 0,
        offLabel: 'Off',
        presets: [{ seconds: 7 * 86400, label: '7 days' }],
      },
    });
    const trigger = wrapper.get('button');
    const label = wrapper.get('label');
    const description = wrapper.get('p');
    expect(trigger.attributes('aria-labelledby')).toBe(label.attributes('id'));
    expect(trigger.attributes('aria-describedby')).toBe(description.attributes('id'));
  });

  it('only suggests custom durations accepted by the configured minimum', async () => {
    const wrapper = mountField(0);
    await wrapper.setProps({ minimumSeconds: 3600 });
    await wrapper.get('select').setValue('custom');
    expect(wrapper.get('input').attributes('placeholder')).not.toContain('30m');
    expect(wrapper.text()).not.toContain('30m');
  });

  it('renders an external custom value using the shortest exact unit', async () => {
    const wrapper = mountField(0);
    await wrapper.setProps({ modelValue: 14 * 86400 });
    await nextTick();

    expect((wrapper.get('select').element as HTMLSelectElement).value).toBe('custom');
    expect((wrapper.get('input').element as HTMLInputElement).value).toBe('14d');
  });

  it('accepts custom Stateful Responses retention as whole days', async () => {
    const wrapper = mountField(0, 0, 'days');
    await wrapper.get('select').setValue('custom');

    const input = wrapper.get('input');
    expect(input.attributes('type')).toBe('number');
    expect(input.attributes('placeholder')).toBe('e.g. 14');
    expect(wrapper.text()).toContain('days');

    await input.setValue('14');
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toBe(14 * 86400);

    await input.setValue('0');
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toBe('invalid');
    expect(wrapper.text()).toContain('Enter a whole number of days, at least 1.');
  });

  it('renders an external day-based value as a day count', async () => {
    const wrapper = mountField(0, 0, 'days');
    await wrapper.setProps({ modelValue: 14 * 86400 });
    await nextTick();

    expect((wrapper.get('select').element as HTMLSelectElement).value).toBe('custom');
    expect((wrapper.get('input').element as HTMLInputElement).value).toBe('14');
  });

  it('preserves each raw custom keystroke through a real parent v-model loop', async () => {
    const wrapper = mountField(0);
    await wrapper.get('select').setValue('custom');
    for (const draft of ['4', '45', '45d']) {
      await wrapper.get('input').setValue(draft);
      await wrapper.setProps({ modelValue: wrapper.emitted('update:modelValue')?.at(-1)?.[0] as number | 'invalid' });
      await nextTick();
      expect((wrapper.get('input').element as HTMLInputElement).value).toBe(draft);
    }
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toBe(45 * 86400);
  });
});
