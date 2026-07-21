import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { nextTick } from 'vue';

import ModelEditor from './ModelEditor.vue';
import type { Row } from './modelRows.ts';
import { divideDecimalString } from '@floway-dev/protocols/common';
import type { FlagDefaults } from '@floway-dev/provider/flags';

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
  },
  global: {
    stubs: {
      EndpointsField: true,
      ChatMetadataEditor: true,
      FlagOverridesEditor: true,
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
});
