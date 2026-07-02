import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { nextTick } from 'vue';

import AliasTargetRow from './AliasTargetRow.vue';
import { buildRealModel } from '../../api/test-fixtures.ts';
import type { AliasTarget, ControlPlaneModel } from '../../api/types.ts';

const target = (over: Partial<AliasTarget> = {}): AliasTarget => ({
  target_model_id: 'gpt-5',
  rules: {},
  ...over,
});

const realModel = (id: string, chat?: ControlPlaneModel['chat']): ControlPlaneModel =>
  buildRealModel(chat ? { id, chat } : { id });

const mountRow = (props: Partial<InstanceType<typeof AliasTargetRow>['$props']>) => mount(AliasTargetRow, {
  props: {
    modelValue: target(),
    kind: 'chat',
    targetIdItems: ['gpt-5', 'claude-sonnet'],
    models: [realModel('gpt-5')],
    isFirst: false,
    isLast: false,
    isSole: false,
    ...props,
  },
});

describe('AliasTargetRow', () => {
  it('disables Move Up on the first row, Move Down on the last, and Remove when it is the sole row', () => {
    const first = mountRow({ isFirst: true });
    expect((first.find('button[aria-label="Move target up"]').element as HTMLButtonElement).disabled).toBe(true);
    expect((first.find('button[aria-label="Move target down"]').element as HTMLButtonElement).disabled).toBe(false);

    const last = mountRow({ isLast: true });
    expect((last.find('button[aria-label="Move target up"]').element as HTMLButtonElement).disabled).toBe(false);
    expect((last.find('button[aria-label="Move target down"]').element as HTMLButtonElement).disabled).toBe(true);

    const sole = mountRow({ isSole: true });
    expect((sole.find('button[aria-label="Remove target"]').element as HTMLButtonElement).disabled).toBe(true);
  });

  it('emits move-up / move-down / remove', async () => {
    const w = mountRow({});
    await w.find('button[aria-label="Move target up"]').trigger('click');
    await w.find('button[aria-label="Move target down"]').trigger('click');
    await w.find('button[aria-label="Remove target"]').trigger('click');
    expect(w.emitted('moveUp')).toHaveLength(1);
    expect(w.emitted('moveDown')).toHaveLength(1);
    expect(w.emitted('remove')).toHaveLength(1);
  });

  it('expands to the chat rule body when the kind is chat; the toggle is disabled for non-chat kinds', async () => {
    const chatRow = mountRow({});
    expect(chatRow.text()).not.toContain('Reasoning effort');
    await chatRow.find('button[aria-label="Toggle target row"]').trigger('click');
    expect(chatRow.text()).toContain('Reasoning effort');
    expect(chatRow.text()).toContain('Verbosity');

    // Non-chat aliases carry an empty rules record, so the row has nothing
    // to expand — the toggle is disabled and the body never renders.
    const embedRow = mountRow({ kind: 'embedding', modelValue: { target_model_id: 'e1', rules: {} } });
    const toggle = embedRow.find('button[aria-label="Toggle target row"]').element as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(embedRow.text()).not.toContain('Reasoning effort');
  });

  it('shows the model-level warning icon when the target id does not resolve to any catalog entry', () => {
    const known = mountRow({ modelValue: target({ target_model_id: 'gpt-5' }), models: [realModel('gpt-5')] });
    expect(known.find('span[aria-label="Model warning"]').exists()).toBe(false);

    const unknown = mountRow({ modelValue: target({ target_model_id: 'mystery' }), models: [realModel('gpt-5')] });
    expect(unknown.find('span[aria-label="Model warning"]').exists()).toBe(true);
  });

  it('renders a rule-level warning under reasoning.effort when the target does not advertise it', async () => {
    const w = mountRow({
      modelValue: { target_model_id: 'gpt-5', rules: { reasoning: { effort: 'xhigh' } } },
      models: [realModel('gpt-5', { reasoning: { effort: { supported: ['low', 'medium'], default: 'medium' } } })],
    });
    await w.find('button[aria-label="Toggle target row"]').trigger('click');
    await nextTick();
    const html = w.html();
    expect(html).toContain('text-amber-300');
    expect(html).toContain('low, medium');
  });
});
