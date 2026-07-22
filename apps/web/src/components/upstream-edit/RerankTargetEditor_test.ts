import { mount, type VueWrapper } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { nextTick } from 'vue';

import RerankTargetEditor from './RerankTargetEditor.vue';
import { Select } from '@floway-dev/ui';

const pathInput = (wrapper: ReturnType<typeof mount>) =>
  wrapper.findAll('label').find(label => label.text().includes('Path override'))!.get('input');

describe('RerankTargetEditor', () => {
  it('persists protocol and model-specific path updates', async () => {
    const wrapper = mount(RerankTargetEditor, {
      props: { modelValue: { protocol: 'cohere-v2' } },
    });

    (wrapper.getComponent(Select) as unknown as VueWrapper).vm.$emit('update:modelValue', 'dashscope-native');
    await nextTick();
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual({ protocol: 'dashscope-native' });

    await wrapper.setProps({ modelValue: { protocol: 'dashscope-native' } });
    await pathInput(wrapper).setValue('/workspace/rerank');
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual({
      protocol: 'dashscope-native',
      path: '/workspace/rerank',
    });
  });

  it('shows the selected protocol canonical path without persisting it', () => {
    const wrapper = mount(RerankTargetEditor, {
      props: { modelValue: { protocol: 'dashscope-compatible' } },
    });
    expect(pathInput(wrapper).attributes('placeholder')).toBe('/compatible-api/v1/reranks');
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  });
});
