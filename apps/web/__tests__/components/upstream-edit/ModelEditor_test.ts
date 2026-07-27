import { mount, type VueWrapper } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { nextTick } from 'vue';

import ModelEditor from '../../../src/components/upstream-edit/ModelEditor.vue';
import type { Row } from '../../../src/components/upstream-edit/modelRows.ts';
import { divideDecimalString } from '@floway-dev/protocols/common';
import type { FlagDefaults } from '@floway-dev/provider/flags';
import { Select } from '@floway-dev/ui';

const row = (uiId: string, model: string, inputPerMillion: string, flagOverrides: Record<string, boolean> | undefined): Row => ({
  uiId,
  kind: 'manual',
  config: {
    upstreamModelId: model,
    kind: 'chat',
    endpoints: { chatCompletions: {} },
    pricing: { entries: [{ rates: { input_tokens: divideDecimalString(inputPerMillion, '1000000') } }] },
    flagOverrides,
  },
});

const mountEditor = (selected: Row) => mount(ModelEditor, {
  props: {
    row: selected,
    flags: [],
    upstreamFlagOverrides: {},
    providerFlagDefaults: {} as FlagDefaults,
    upstreamIdLabel: 'Upstream Model ID',
    isUpstreamIdLocked: false,
    hasAutoCounterpart: false,
    modeSwitchable: false,
    allowRerank: true,
  },
  global: {
    stubs: {
      EndpointsField: true,
      ChatMetadataEditor: true,
      FlagOverridesEditor: true,
      Select: {
        props: ['modelValue', 'options'],
        emits: ['update:modelValue'],
        template: '<select :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value)"><option v-for="option in options" :key="option.value" :value="option.value">{{ option.label }}</option></select>',
      },
    },
  },
});

const pricingInput = (wrapper: ReturnType<typeof mountEditor>) =>
  wrapper.findAll('input').find(input => input.attributes('placeholder') === 'unpriced')!;

describe('ModelEditor', () => {
  it('resets its pricing child on row changes and forwards pricing updates', async () => {
    const first = row('first', 'model-first', '1', undefined);
    const second = row('second', 'model-second', '2', undefined);
    second.config.pricing = { entries: [{ rates: {} }] };

    const wrapper = mountEditor(first);
    expect((pricingInput(wrapper).element as HTMLInputElement).value).toBe('1');

    await wrapper.setProps({ row: second });
    await nextTick();
    expect((pricingInput(wrapper).element as HTMLInputElement).value).toBe('');

    await pricingInput(wrapper).setValue('7');
    expect(wrapper.emitted('patch-config')?.at(-1)?.[0]).toEqual({ pricing: { entries: [{ rates: { input_tokens: '0.000007' } }] } });
  });

  it('clears cached flag overrides when switching rows', async () => {
    const first = row('first', 'model-first', '1', { 'flag-a': true });
    const second = row('second', 'model-second', '2', undefined);
    const wrapper = mountEditor(first);

    await wrapper.find('button[role="switch"]').trigger('click');
    await wrapper.setProps({ row: second });
    await nextTick();
    await wrapper.find('button[role="switch"]').trigger('click');

    expect(wrapper.emitted('patch-config')?.at(-1)?.[0]).toEqual({ flagOverrides: {} });
  });

  it('clears chat metadata when switching a chat model to transcription', async () => {
    const selected = row('transcription', 'gpt-4o-transcribe', '1', undefined);
    selected.config.chat = { modalities: { input: ['text'], output: ['text'] } };
    const wrapper = mountEditor(selected);

    const kindSelect = wrapper.findAll('select').find(select => select.text().includes('Transcription'))!;
    await kindSelect.setValue('transcription');

    expect(wrapper.emitted('patch-config')?.at(-1)?.[0]).toEqual({
      kind: 'transcription',
      endpoints: { audioTranscriptions: {} },
      chat: undefined,
      rerankTarget: undefined,
    });
  });

  it('persists an explicit Cohere v2 target when switching into rerank', async () => {
    const wrapper = mountEditor(row('reranker', 'reranker', '1', undefined));
    (wrapper.findAllComponents(Select)[0] as unknown as VueWrapper).vm.$emit('update:modelValue', 'rerank');
    await nextTick();

    expect(wrapper.emitted('patch-config')?.at(-1)?.[0]).toEqual({
      kind: 'rerank',
      endpoints: { rerank: {} },
      chat: undefined,
      rerankTarget: { protocol: 'cohere-v2' },
    });
  });
});
