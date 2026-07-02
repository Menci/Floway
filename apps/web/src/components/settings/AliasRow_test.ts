import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import AliasRow from './AliasRow.vue';
import { buildAliasModel, buildRealModel } from '../../api/test-fixtures.ts';
import type { ControlPlaneModel, ModelAlias } from '../../api/types.ts';

const alias = (over: Partial<ModelAlias> & { name: string }): ModelAlias => ({
  kind: 'chat',
  selection: 'first-available',
  display_name: null,
  visible_in_models_list: true,
  targets: [{ target_model_id: 'gpt-5', rules: {} }],
  announced_metadata: null,
  sort_order: 0,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  ...over,
});

const realModel = (id: string, display?: string): ControlPlaneModel =>
  buildRealModel(display !== undefined ? { id, display_name: display } : { id });

const aliasModel = (id: string): ControlPlaneModel => buildAliasModel({ id });

describe('AliasRow', () => {
  it('renders display_name when set; otherwise falls back to the alias id', () => {
    const withDisplay = mount(AliasRow, { props: { alias: alias({ name: 'a', display_name: 'My Friendly Name' }), models: [] } });
    expect(withDisplay.find('h4').text()).toBe('My Friendly Name');

    // No operator-set display: title shows the alias id verbatim (same string
    // as the mono pill next to it — the chat-playground idiom).
    const single = mount(AliasRow, {
      props: {
        alias: alias({ name: 'a', display_name: null, targets: [{ target_model_id: 'gpt-5', rules: { reasoning: { effort: 'low' } } }] }),
        models: [],
      },
    });
    expect(single.find('h4').text()).toBe('a');

    const multi = mount(AliasRow, {
      props: {
        alias: alias({
          name: 'gizmo',
          display_name: null,
          targets: [
            { target_model_id: 'gpt-5', rules: {} },
            { target_model_id: 'claude', rules: {} },
          ],
        }),
        models: [],
      },
    });
    expect(multi.find('h4').text()).toBe('gizmo');
  });

  it('formats the caption: Kind · N targets · Selection (and optional hidden suffix); the alias id sits next to the title', () => {
    const w = mount(AliasRow, {
      props: {
        alias: alias({
          name: 'auto-review',
          selection: 'random',
          visible_in_models_list: false,
          targets: [
            { target_model_id: 'a', rules: {} },
            { target_model_id: 'b', rules: {} },
          ],
        }),
        models: [],
      },
    });
    expect(w.find('p').text()).toBe('Chat · 2 targets · Random · hidden from /v1/models');
    // The alias id stamp sits on the title row, in mono.
    expect(w.find('div.flex.items-baseline span').text()).toBe('auto-review');

    const sole = mount(AliasRow, {
      props: { alias: alias({ name: 'one' }), models: [] },
    });
    expect(sole.find('p').text()).toBe('Chat · 1 target · First available');
  });

  it('emits edit on the pencil button and delete on the trash button', async () => {
    const w = mount(AliasRow, { props: { alias: alias({ name: 'a' }), models: [] } });
    const edit = w.find('button[aria-label="Edit alias"]');
    const del = w.find('button[aria-label="Delete alias"]');
    await edit.trigger('click');
    await del.trigger('click');
    expect(w.emitted('edit')).toHaveLength(1);
    expect(w.emitted('delete')).toHaveLength(1);
  });

  it('renders the alias-level warning icon only when the shadow warning fires', () => {
    const catalog = [realModel('gpt-5'), realModel('plain')];

    const noShadow = mount(AliasRow, { props: { alias: alias({ name: 'unique', targets: [{ target_model_id: 'gpt-5', rules: {} }] }), models: catalog } });
    expect(noShadow.find('span[aria-label="Alias warning"]').exists()).toBe(false);

    const shadow = mount(AliasRow, { props: { alias: alias({ name: 'gpt-5', targets: [{ target_model_id: 'plain', rules: {} }] }), models: catalog } });
    expect(shadow.find('span[aria-label="Alias warning"]').exists()).toBe(true);

    // Seed pattern (target references shadowed id) suppresses the warning.
    const seeded = mount(AliasRow, {
      props: {
        alias: alias({ name: 'gpt-5', targets: [{ target_model_id: 'gpt-5', rules: {} }, { target_model_id: 'plain', rules: {} }] }),
        models: catalog,
      },
    });
    expect(seeded.find('span[aria-label="Alias warning"]').exists()).toBe(false);

    // An alias-name collision against another alias doesn't shadow (only real-model collisions do).
    const aliasCollision = mount(AliasRow, {
      props: {
        alias: alias({ name: 'auto-review', targets: [{ target_model_id: 'plain', rules: {} }] }),
        models: [aliasModel('auto-review'), realModel('plain')],
      },
    });
    expect(aliasCollision.find('span[aria-label="Alias warning"]').exists()).toBe(false);
  });
});
