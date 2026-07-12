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
    pricing: { entries: [{ rates: { input } }] },
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
    // An invalid second-row entry proves validity is recomputed from the new row,
    // rather than remaining true from the first row's valid draft.
    second.config.pricing = { entries: [{ rates: {} }] };

    const wrapper = mountEditor(first);
    expect((pricingInput(wrapper, 'unpriced').element as HTMLInputElement).value).toBe('1');
    expect(wrapper.emitted('validity-change')?.at(-1)).toEqual([true]);

    await wrapper.setProps({ row: second });
    await nextTick();

    expect((pricingInput(wrapper, 'unpriced').element as HTMLInputElement).value).toBe('');
    expect(wrapper.emitted('validity-change')?.at(-1)).toEqual([false]);

    await pricingInput(wrapper, 'unpriced').setValue('7');
    const pricingPatch = wrapper.emitted('patch-config')?.at(-1)?.[0];
    expect(pricingPatch).toEqual({ pricing: { entries: [{ rates: { input: 7 } }] } });
    expect(pricingPatch).not.toEqual({ pricing: { entries: [{ rates: { input: 1 } }] } });
    expect(wrapper.emitted('validity-change')?.at(-1)).toEqual([true]);
  });

  it('resets drafts and validity when manual switches to its auto twin with the same uiId', async () => {
    const manual = row('shared', 'model-manual', 1, undefined);
    const auto: Row = {
      ...row('shared', 'model-auto', 9, undefined),
      kind: 'auto',
    };
    auto.config.pricing = { entries: [{ rates: {} }] };

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

  it('clears a threshold value while preserving operator-only updates', async () => {
    const selected = row('threshold', 'model-threshold', 1, undefined);
    selected.config.pricing = { entries: [{ selector: { inputTokens: { operator: 'gte', value: 100 } }, rates: { input: 1 } }] };
    const wrapper = mountEditor(selected);
    const threshold = pricingInput(wrapper, 'base');
    expect((threshold.element as HTMLInputElement).value).toBe('100');

    await threshold.setValue('');
    expect(wrapper.emitted('patch-config')?.at(-1)?.[0]).toEqual({ pricing: { entries: [{ rates: { input: 1 } }] } });
  });

  it('navigates pricing entries from the left while rendering one editor on the right', async () => {
    const selected = row('entries', 'model-entries', 1, undefined);
    selected.config.pricing = {
      entries: [
        { rates: { input: 1 } },
        { selector: { serviceTier: 'priority' }, rates: { input: 2 } },
      ],
    };
    const wrapper = mountEditor(selected);
    const navigation = wrapper.get('[aria-label="Pricing entry navigation"]');

    expect(wrapper.text()).not.toContain('explicit service-tier');
    expect(navigation.text()).toContain('Add Entry');
    expect(navigation.findAll('li')).toHaveLength(2);
    expect(wrapper.findAll('input[placeholder="unpriced"]')).toHaveLength(5);
    expect((pricingInput(wrapper, 'unpriced').element as HTMLInputElement).value).toBe('1');
    expect(wrapper.text()).toContain('Service Tier');
    expect(wrapper.text()).toContain('Input Tokens');

    await wrapper.get('button[aria-label="Edit pricing entry 2: priority"]').trigger('click');
    expect((pricingInput(wrapper, 'unpriced').element as HTMLInputElement).value).toBe('2');

    await navigation.get('button[aria-label="Move pricing entry 2 up"]').trigger('click');
    expect(wrapper.emitted('patch-config')?.at(-1)?.[0]).toEqual({
      pricing: {
        entries: [
          { selector: { serviceTier: 'priority' }, rates: { input: 2 } },
          { rates: { input: 1 } },
        ],
      },
    });
    expect((pricingInput(wrapper, 'unpriced').element as HTMLInputElement).value).toBe('2');
  });

  it('toggles the compact threshold operator before a value is entered', async () => {
    const selected = row('operator', 'model-operator', 1, undefined);
    const wrapper = mountEditor(selected);
    const operator = wrapper.get('button[aria-label="Input Tokens operator >; click to toggle"]');

    expect(operator.text()).toBe('>');
    await operator.trigger('click');
    expect(wrapper.get('button[aria-label="Input Tokens operator >=; click to toggle"]').text()).toBe('>=');

    await pricingInput(wrapper, 'base').setValue('100');
    expect(wrapper.emitted('patch-config')?.at(-1)?.[0]).toEqual({
      pricing: { entries: [{ selector: { inputTokens: { operator: 'gte', value: 100 } }, rates: { input: 1 } }] },
    });
  });

  it('requires every pricing entry to set the same rate fields', async () => {
    const selected = row('rate-shape', 'model-rate-shape', 1, undefined);
    selected.config.pricing = {
      entries: [
        { rates: { input: 1, output: 4 } },
        { selector: { serviceTier: 'priority' }, rates: { input: 2 } },
      ],
    };
    const wrapper = mountEditor(selected);

    expect(wrapper.text()).toContain('All pricing entries must set the same rate fields.');
    expect(wrapper.emitted('validity-change')?.at(-1)).toEqual([false]);

    await wrapper.get('button[aria-label="Edit pricing entry 2: priority"]').trigger('click');
    const output = wrapper.findAll('label').find(label => label.text().includes('Output ($/MTok)'))!.get('input');
    await output.setValue('8');

    expect(wrapper.text()).not.toContain('All pricing entries must set the same rate fields.');
    expect(wrapper.emitted('validity-change')?.at(-1)).toEqual([true]);
  });

  it('groups every pricing validation error below the form', () => {
    const selected = row('errors', 'model-errors', 1, undefined);
    selected.config.pricing = {
      entries: [
        { selector: { serviceTier: '' }, rates: {} },
        { rates: { input: 1 } },
        { selector: {}, rates: { input: 2 } },
      ],
    };
    const wrapper = mountEditor(selected);
    const form = wrapper.get('[aria-label="Pricing entry form"]');
    const errors = wrapper.get('[aria-label="Pricing validation errors"]');

    expect(errors.findAll('p').map(error => error.text())).toEqual([
      'Set at least one rate.',
      'Selector values are invalid.',
      'Duplicate selector coordinate.',
      'All pricing entries must set the same rate fields.',
    ]);
    expect(form.element.compareDocumentPosition(errors.element) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(wrapper.emitted('validity-change')?.at(-1)).toEqual([false]);
  });

  it.each(['0', '1.5'])('shows validation instead of throwing for threshold %s', async value => {
    const selected = row('invalid-threshold', 'model-invalid', 1, undefined);
    selected.config.pricing = { entries: [{ rates: { input: 1 } }, { selector: { serviceTier: 'priority' }, rates: { input: 2 } }] };
    const wrapper = mountEditor(selected);
    await pricingInput(wrapper, 'base').setValue(value);
    expect(wrapper.text()).toContain('Selector values are invalid.');
    expect(wrapper.findAll('p').filter(node => node.text() === 'Selector values are invalid.')).toHaveLength(1);
    expect(wrapper.emitted('validity-change')?.at(-1)).toEqual([false]);
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
