import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { nextTick } from 'vue';

import PricingEditor from './PricingEditor.vue';
import { perMillionTokenRates, type ModelKind, type ModelPricing } from '@floway-dev/protocols/common';

const tokenPricing = ({ entries }: Pick<ModelPricing, 'entries'>): ModelPricing => ({
  entries: entries.map(entry => ({ ...entry, rates: perMillionTokenRates(entry.rates) })),
});

const mountEditor = (
  modelValue: Pick<ModelPricing, 'entries'> | undefined,
  options: { editable?: boolean; kind?: ModelKind } = {},
) => mount(PricingEditor, {
  props: {
    modelValue: modelValue === undefined ? undefined : tokenPricing(modelValue),
    editable: options.editable ?? true,
    kind: options.kind ?? 'chat',
  },
});

const pricingInput = (wrapper: ReturnType<typeof mountEditor>, placeholder: string) =>
  wrapper.findAll('input').find(input => input.attributes('placeholder') === placeholder)!;

describe('PricingEditor', () => {
  it('distinguishes absent pricing from a present empty catalog', () => {
    const wrapper = mountEditor(undefined);
    expect(wrapper.find('[aria-label="Pricing validation errors"]').exists()).toBe(false);
    const invalid = mountEditor({ entries: [] });
    expect(invalid.get('[aria-label="Pricing validation errors"]').text()).toBe('model pricing must declare at least one entry');
  });

  it('does not update read-only pricing', async () => {
    const wrapper = mountEditor({ entries: [{ rates: {} }] }, { editable: false });
    const autoPricing = pricingInput(wrapper, 'unpriced');
    expect((autoPricing.element as HTMLInputElement).value).toBe('');
    expect((autoPricing.element as HTMLInputElement).readOnly).toBe(true);

    const updateCount = wrapper.emitted('update:modelValue')?.length ?? 0;
    await autoPricing.setValue('11');
    expect(wrapper.emitted('update:modelValue')?.length ?? 0).toBe(updateCount);
  });

  it('refreshes read-only drafts when an auto catalog snapshot changes', async () => {
    const wrapper = mountEditor({ entries: [{ rates: { input_tokens: '1' } }] }, { editable: false });
    expect((pricingInput(wrapper, 'unpriced').element as HTMLInputElement).value).toBe('1');

    await wrapper.setProps({ modelValue: tokenPricing({ entries: [{ rates: { input_tokens: '2' } }] }) });
    await nextTick();
    expect((pricingInput(wrapper, 'unpriced').element as HTMLInputElement).value).toBe('2');
  });

  it('persists the fixed token unit with its rate', async () => {
    const wrapper = mountEditor({ entries: [{ rates: {} }] });
    await pricingInput(wrapper, 'unpriced').setValue('2');
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual({
      entries: [{ rates: { input_tokens: '0.000002' } }],
    });
  });

  it('displays a base-unit price through its fixed MTok field', async () => {
    const wrapper = mount(PricingEditor, {
      props: {
        modelValue: { entries: [{ rates: { input_tokens: '0.000001' } }] },
        editable: true,
        kind: 'chat',
      },
    });

    expect((pricingInput(wrapper, 'unpriced').element as HTMLInputElement).value).toBe('1');

    await pricingInput(wrapper, 'unpriced').setValue('2');
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual({
      entries: [{ rates: { input_tokens: '0.000002' } }],
    });
  });

  it('clears a threshold value while preserving operator-only updates', async () => {
    const wrapper = mountEditor({
      entries: [{ selector: { inputTokens: { operator: 'gte', value: 100 } }, rates: { input_tokens: '1' } }],
    });
    const threshold = pricingInput(wrapper, 'base');
    expect((threshold.element as HTMLInputElement).value).toBe('100');

    await threshold.setValue('');
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual(tokenPricing({ entries: [{ rates: { input_tokens: '1' } }] }));
  });

  it('navigates pricing entries from the left while rendering one editor on the right', async () => {
    const wrapper = mountEditor({
      entries: [
        { rates: { input_tokens: '1' } },
        { selector: { serviceTier: 'priority' }, rates: { input_tokens: '2' } },
      ],
    });
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
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual(tokenPricing({
      entries: [
        { selector: { serviceTier: 'priority' }, rates: { input_tokens: '2' } },
        { rates: { input_tokens: '1' } },
      ],
    }));
    expect((pricingInput(wrapper, 'unpriced').element as HTMLInputElement).value).toBe('2');
  });

  it('shows Base metrics outside the kind defaults and clones Base rates into new entries', async () => {
    const baseRates = { input_tokens: '1', input_image_tokens: '2', output_tokens: '3', output_image_tokens: '4' };
    const wrapper = mountEditor({ entries: [{ rates: baseRates }] }, { kind: 'chat' });

    expect(wrapper.text()).toContain('Image Input ($/MTok)');
    expect(wrapper.text()).toContain('Image Output ($/MTok)');
    await wrapper.findAll('button').find(button => button.text().includes('Add Entry'))!.trigger('click');

    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual(tokenPricing({
      entries: [
        { rates: baseRates },
        { rates: baseRates },
      ],
    }));
  });

  it('keeps out-of-kind metrics editable while a catalog has no Base', () => {
    const wrapper = mountEditor({
      entries: [{ selector: { serviceTier: 'priority' }, rates: { input_image_tokens: '2' } }],
    }, { kind: 'chat' });
    expect(wrapper.text()).toContain('Image Input ($/MTok)');
  });

  it('toggles the compact threshold operator before a value is entered', async () => {
    const wrapper = mountEditor({ entries: [{ rates: { input_tokens: '1' } }] });
    const operator = wrapper.get('button[aria-label="Input Tokens operator >; click to toggle"]');

    expect(operator.text()).toBe('>');
    await operator.trigger('click');
    expect(wrapper.get('button[aria-label="Input Tokens operator >=; click to toggle"]').text()).toBe('>=');

    await pricingInput(wrapper, 'base').setValue('100');
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual(tokenPricing({
      entries: [{ selector: { inputTokens: { operator: 'gte', value: 100 } }, rates: { input_tokens: '1' } }],
    }));
  });

  it('separates combined pricing coordinates with commas', () => {
    const wrapper = mountEditor({
      entries: [
        { rates: { input_tokens: '1' } },
        {
          selector: { serviceTier: 'priority', inputTokens: { operator: 'gt', value: 512_000 } },
          rates: { input_tokens: '2' },
        },
      ],
    });

    expect(wrapper.get('button[aria-label="Edit pricing entry 2: priority, > 512000 tokens"]').text()).toBe(
      'priority, > 512000 tokens',
    );
  });

  it('requires every pricing entry to set the same rate fields', async () => {
    const wrapper = mountEditor({
      entries: [
        { rates: { input_tokens: '1', output_tokens: '4' } },
        { selector: { serviceTier: 'priority' }, rates: { input_tokens: '2' } },
      ],
    });

    expect(wrapper.text()).toContain('All pricing entries must set the same rate fields: entry 2 ("priority") is missing Output.');

    await wrapper.get('button[aria-label="Edit pricing entry 2: priority"]').trigger('click');
    const output = wrapper.findAll('label').find(label => label.text().includes('Output ($/MTok)'))!.get('input');
    await output.setValue('8');

    expect(wrapper.text()).not.toContain('All pricing entries must set the same rate fields:');
  });

  it('groups every pricing validation error below the form', () => {
    const wrapper = mountEditor({
      entries: [
        { selector: { serviceTier: '' }, rates: {} },
        { rates: { input_tokens: '1' } },
        { selector: { serviceTier: 'priority' }, rates: { input_tokens: '2' } },
        { selector: { serviceTier: 'priority' }, rates: { input_tokens: '3' } },
      ],
    });
    const form = wrapper.get('[aria-label="Pricing entry form"]');
    const errors = wrapper.get('[aria-label="Pricing validation errors"]');

    expect(errors.findAll('p').map(error => error.text())).toEqual([
      'Selector values are invalid: entry 1.',
      'Duplicate selector coordinate: entries 3 and 4 use "priority".',
      'All pricing entries must set the same rate fields: entry 1 ("Base") is missing Input.',
    ]);
    expect(form.element.compareDocumentPosition(errors.element) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it('requires exactly one Base entry before comparing rate fields', () => {
    const wrapper = mountEditor({
      entries: [{ selector: { serviceTier: 'priority' }, rates: { input_tokens: '2' } }],
    });
    expect(wrapper.get('[aria-label="Pricing validation errors"]').text()).toBe(
      'Pricing must contain exactly one Base entry: none is configured.',
    );

    const duplicate = mountEditor({ entries: [{ rates: { input_tokens: '1' } }, { selector: {}, rates: { input_tokens: '2' } }] });
    expect(duplicate.get('[aria-label="Pricing validation errors"]').text()).toBe(
      'Pricing must contain exactly one Base entry: entries 1 and 2 are Base.',
    );
  });

  it.each(['default', ' Standard ', '  '])('rejects Base-equivalent service tier %j', serviceTier => {
    const wrapper = mountEditor({
      entries: [
        { rates: { input_tokens: '1' } },
        { selector: { serviceTier }, rates: { input_tokens: '2' } },
      ],
    });
    expect(wrapper.get('[aria-label="Pricing validation errors"]').text()).toBe('Selector values are invalid: entry 2.');
  });

  it('shows the empty-rate error when every pricing entry has the same empty rate shape', () => {
    const wrapper = mountEditor({
      entries: [
        { rates: {} },
        { selector: { serviceTier: 'priority' }, rates: {} },
      ],
    });

    expect(wrapper.get('[aria-label="Pricing validation errors"]').findAll('p').map(error => error.text())).toEqual([
      'Set at least one rate: entry 1 ("Base") and entry 2 ("priority") have no rates.',
    ]);
  });

  it.each(['0', '1.5'])('shows validation instead of throwing for threshold %s', async value => {
    const wrapper = mountEditor({
      entries: [{ rates: { input_tokens: '1' } }, { selector: { serviceTier: 'priority' }, rates: { input_tokens: '2' } }],
    });
    await pricingInput(wrapper, 'base').setValue(value);
    expect(wrapper.text()).toContain('Selector values are invalid: entry 1.');
    expect(wrapper.findAll('p').filter(node => node.text() === 'Selector values are invalid: entry 1.')).toHaveLength(1);
  });
});
