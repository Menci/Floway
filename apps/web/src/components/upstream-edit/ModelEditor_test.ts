import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { nextTick } from 'vue';

import ModelEditor from './ModelEditor.vue';
import type { Row } from './modelRows.ts';
import type { FlagDefaults } from '@floway-dev/provider/flags';

const row = (uiId: string, model: string, input: number, flagOverrides: Record<string, boolean> | undefined): Row => ({
  uiId,
  kind: 'manual',
  config: {
    upstreamModelId: model,
    kind: 'chat',
    endpoints: { chatCompletions: {} },
    cost: { cells: [{ rates: { input } }] },
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

const pricingInput = (wrapper: ReturnType<typeof mountEditor>, placeholder: string) =>
  wrapper.findAll('input').find(input => input.attributes('placeholder') === placeholder)!;

describe('ModelEditor row synchronization', () => {
  it('replaces pricing drafts and validity when the selected row changes without remounting', async () => {
    const first = row('first', 'model-first', 1, { 'flag-a': true });
    const second = row('second', 'model-second', 2, undefined);
    // An invalid second-row cell proves validity is recomputed from the new row,
    // rather than remaining true from the first row's valid draft.
    second.config.cost = { cells: [{ rates: {} }] };

    const wrapper = mountEditor(first);
    expect((pricingInput(wrapper, 'unpriced').element as HTMLInputElement).value).toBe('1');
    expect(wrapper.emitted('validity-change')?.at(-1)).toEqual([true]);

    await wrapper.setProps({ row: second });
    await nextTick();

    expect((pricingInput(wrapper, 'unpriced').element as HTMLInputElement).value).toBe('');
    expect(wrapper.emitted('validity-change')?.at(-1)).toEqual([false]);

    await pricingInput(wrapper, 'unpriced').setValue('7');
    const pricingPatch = wrapper.emitted('patch-config')?.at(-1)?.[0];
    expect(pricingPatch).toEqual({ cost: { cells: [{ rates: { input: 7 } }] } });
    expect(pricingPatch).not.toEqual({ cost: { cells: [{ rates: { input: 1 } }] } });
    expect(wrapper.emitted('validity-change')?.at(-1)).toEqual([true]);
  });

  it('resets drafts and validity when manual switches to its auto twin with the same uiId', async () => {
    const manual = row('shared', 'model-manual', 1, undefined);
    const auto: Row = {
      ...row('shared', 'model-auto', 9, undefined),
      kind: 'auto',
    };
    auto.config.cost = { cells: [{ rates: {} }] };

    const wrapper = mountEditor(manual);
    await pricingInput(wrapper, 'unpriced').setValue('7');
    expect(wrapper.emitted('validity-change')?.at(-1)).toEqual([true]);

    await wrapper.setProps({ row: auto });
    await nextTick();

    const autoPricing = pricingInput(wrapper, 'unpriced');
    expect((autoPricing.element as HTMLInputElement).value).toBe('');
    expect((autoPricing.element as HTMLInputElement).readOnly).toBe(true);
    expect(wrapper.emitted('validity-change')?.at(-1)).toEqual([false]);

    const patchCount = wrapper.emitted('patch-config')?.length ?? 0;
    await autoPricing.setValue('11');
    expect(wrapper.emitted('patch-config')?.length ?? 0).toBe(patchCount);
  });

  it('clears cached flag overrides when switching rows', async () => {
    const first = row('first', 'model-first', 1, { 'flag-a': true });
    const second = row('second', 'model-second', 2, undefined);
    const wrapper = mountEditor(first);

    // Disable on row one to populate lastFlagOverrides, then switch and enable
    // on row two. The row-one flag must not leak into the row-two patch.
    await wrapper.find('button[role="switch"]').trigger('click');
    await wrapper.setProps({ row: second });
    await nextTick();
    await wrapper.find('button[role="switch"]').trigger('click');

    expect(wrapper.emitted('patch-config')?.at(-1)?.[0]).toEqual({ flagOverrides: {} });
  });
});
