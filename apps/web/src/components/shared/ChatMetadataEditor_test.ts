import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { nextTick } from 'vue';

import ChatMetadataEditor from './ChatMetadataEditor.vue';
import type { AnnouncedMetadata } from '../../api/types.ts';

const baseValue = (): AnnouncedMetadata => ({
  limits: { max_context_window_tokens: 100_000, max_output_tokens: 4096 },
  chat: { reasoning: { effort: { supported: ['low', 'medium', 'high'], default: 'medium' } } },
});

describe('ChatMetadataEditor', () => {
  it('renders nothing when kind="image"', () => {
    const w = mount(ChatMetadataEditor, {
      props: { modelValue: baseValue(), kind: 'image', mode: 'manual' },
    });
    expect(w.html().trim()).toBe('<!--v-if-->');
  });

  it('kind="embedding" renders only the Limits section — no Modalities, no Reasoning', () => {
    const w = mount(ChatMetadataEditor, {
      props: { modelValue: baseValue(), kind: 'embedding', mode: 'manual' },
    });
    expect(w.text()).toContain('Limits');
    expect(w.text()).not.toContain('Modalities');
    expect(w.text()).not.toContain('Reasoning');
  });

  it('kind="chat" renders Limits + Modalities + Reasoning', () => {
    const w = mount(ChatMetadataEditor, {
      props: { modelValue: baseValue(), kind: 'chat', mode: 'manual' },
    });
    const txt = w.text();
    expect(txt).toContain('Limits');
    expect(txt).toContain('Modalities');
    expect(txt).toContain('Reasoning');
    expect(txt).toContain('Effort levels');
  });

  it('mode="auto" renders the values, but Switches are disabled and Inputs are readonly', () => {
    const w = mount(ChatMetadataEditor, {
      props: { modelValue: baseValue(), kind: 'chat', mode: 'auto' },
    });
    // Operator can still read every limit value.
    const numberInputs = w.findAll('input[type="number"]');
    const limitValues = numberInputs.slice(0, 3).map(i => (i.element as HTMLInputElement).value);
    expect(limitValues).toContain('100000');
    expect(limitValues).toContain('4096');
    // Every limit input is readonly.
    for (const inp of numberInputs.slice(0, 3)) {
      expect((inp.element as HTMLInputElement).readOnly).toBe(true);
    }
    // Every Switch (Reka-UI renders as button[role="switch"]) is disabled.
    const switches = w.findAll('button[role="switch"]');
    expect(switches.length).toBeGreaterThan(0);
    for (const s of switches) {
      expect((s.element as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('mode="auto": clicking a Switch is a no-op (no update:modelValue emit)', async () => {
    const w = mount(ChatMetadataEditor, {
      props: { modelValue: { chat: {} } as AnnouncedMetadata, kind: 'chat', mode: 'auto' },
    });
    // The Modalities image-input Switch is the first Switch under the Modalities section.
    const switches = w.findAll('button[role="switch"]');
    expect(switches.length).toBeGreaterThan(0);
    await switches[0].trigger('click');
    await nextTick();
    expect(w.emitted('update:modelValue')).toBeUndefined();
  });

  it('mode="manual": editing a limit emits update:modelValue with the patched payload', async () => {
    const w = mount(ChatMetadataEditor, {
      props: { modelValue: undefined, kind: 'chat', mode: 'manual' },
    });
    const numberInputs = w.findAll('input[type="number"]');
    const contextInput = numberInputs[0]!.element as HTMLInputElement;
    contextInput.value = '64000';
    await numberInputs[0]!.trigger('input');
    await nextTick();
    const emitted = w.emitted('update:modelValue');
    expect(emitted).toBeDefined();
    const last = emitted![emitted!.length - 1]![0] as AnnouncedMetadata;
    expect(last.limits?.max_context_window_tokens).toBe(64_000);
  });

  it('mode="manual": toggling the Effort levels switch on emits a reasoning seed', async () => {
    const w = mount(ChatMetadataEditor, {
      props: { modelValue: undefined, kind: 'chat', mode: 'manual' },
    });
    // The Effort levels Switch is the second Switch (Modalities image is first).
    const switches = w.findAll('button[role="switch"]');
    // Find the one labelled "Effort levels".
    const labels = w.findAll('label');
    const effortLabel = labels.find(l => (l.text() ?? '').includes('Effort levels'))!;
    const effortSwitch = effortLabel.find('button[role="switch"]');
    expect(effortSwitch.exists()).toBe(true);
    expect((effortSwitch.element as HTMLButtonElement).disabled).toBe(false);
    expect(switches.length).toBeGreaterThan(1);

    await effortSwitch.trigger('click');
    await nextTick();
    const emitted = w.emitted('update:modelValue');
    expect(emitted).toBeDefined();
    const last = emitted![emitted!.length - 1]![0] as AnnouncedMetadata;
    expect(last.chat?.reasoning?.effort?.supported).toEqual(['low', 'medium', 'high']);
    expect(last.chat?.reasoning?.effort?.default).toBe('medium');
  });
});
