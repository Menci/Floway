import { mount } from '@vue/test-utils';
import { expect, test } from 'vitest';

import UpstreamPicker, { type UpstreamPickerValue } from '../../../src/components/upstreams/UpstreamPicker.vue';
import type { UpstreamOption } from '../../../src/composables/useUpstreamOptions.ts';

const option = (id: string, name: string): UpstreamOption => ({ id, name, kind: 'custom', enabled: true, color: null });

const mountPicker = (value: UpstreamPickerValue, available: UpstreamOption[]) => mount(UpstreamPicker, {
  props: {
    modelValue: value,
    available,
    title: 'Override Available Upstreams',
    inheritDescription: 'When off, this key inherits the global upstream order.',
  },
});

test('selected options lead, in the stored order, and the rest follow unselected', () => {
  const wrapper = mountPicker({ override: true, ids: ['up_b', 'up_a'] }, [option('up_a', 'Alpha'), option('up_b', 'Bravo')]);
  const rows = wrapper.findAll('li');
  expect(rows.map(row => row.find('code').text())).toEqual(['up_b', 'up_a']);
});

test('an id the caller does not offer contributes no row', () => {
  const wrapper = mountPicker({ override: true, ids: ['up_gone', 'up_a'] }, [option('up_a', 'Alpha')]);
  const rows = wrapper.findAll('li');
  expect(rows.map(row => row.find('code').text())).toEqual(['up_a']);
  expect(wrapper.text()).not.toContain('up_gone');
  expect(wrapper.text()).not.toContain('Unknown');
});

test('toggling a row rewrites the selection from the rendered rows', async () => {
  const wrapper = mountPicker({ override: true, ids: ['up_a'] }, [option('up_a', 'Alpha'), option('up_b', 'Bravo')]);
  // Switch 0 is the override itself; the row switches follow in render order.
  await wrapper.findAll('button[role="switch"]')[2]!.trigger('click');
  const emitted = wrapper.emitted('update:modelValue')!.at(-1)![0] as UpstreamPickerValue;
  expect(emitted.ids).toEqual(['up_a', 'up_b']);
});
