import { test } from 'vitest';

import { recordToWire, wireToRecord } from '../../../src/control-plane/model-aliases/serialize.ts';
import type { ModelAliasRecord } from '../../../src/repo/types.ts';
import { assertEquals } from '@floway-dev/test-utils';

const record: ModelAliasRecord = {
  id: 'alias_0123456789abcdef01234567',
  name: 'codex-auto-review',
  kind: 'chat',
  selection: 'first-available',
  displayName: 'Codex Auto Review',
  visibleInModelsList: true,
  targets: [
    { target_model_id: 'codex-auto-review', rules: {} },
    { target_model_id: 'gpt-5.4', rules: { reasoning: { effort: 'low' } } },
  ],
  announcedMetadata: null,
  sortOrder: 3,
  createdAt: '2026-06-26T00:00:00.000Z',
  updatedAt: '2026-06-26T12:00:00.000Z',
};

test('recordToWire flips camelCase fields to snake_case', () => {
  const wire = recordToWire(record);
  assertEquals(wire.id, 'alias_0123456789abcdef01234567');
  assertEquals(wire.name, 'codex-auto-review');
  assertEquals(wire.kind, 'chat');
  assertEquals(wire.selection, 'first-available');
  assertEquals(wire.display_name, 'Codex Auto Review');
  assertEquals(wire.visible_in_models_list, true);
  assertEquals(wire.sort_order, 3);
  assertEquals(wire.created_at, '2026-06-26T00:00:00.000Z');
  assertEquals(wire.updated_at, '2026-06-26T12:00:00.000Z');
  assertEquals(wire.targets, record.targets);
});

test('wireToRecord roundtrips back to the original record', () => {
  const wire = recordToWire(record);
  const roundTripped = wireToRecord(wire, {
    id: wire.id,
    sortOrder: wire.sort_order,
    createdAt: wire.created_at,
    updatedAt: wire.updated_at,
  });
  assertEquals(roundTripped, record);
});

test('wireToRecord uses meta sortOrder when the wire payload omits it', () => {
  const { sort_order: _drop, ...partial } = recordToWire(record);
  const built = wireToRecord(partial, {
    id: record.id,
    sortOrder: 7,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-06-26T12:00:00.000Z',
  });
  assertEquals(built.sortOrder, 7);
  assertEquals(built.createdAt, '2026-01-01T00:00:00.000Z');
});

test('wireToRecord preserves a null display_name', () => {
  const built = wireToRecord(
    { ...recordToWire(record), display_name: null },
    { id: record.id, sortOrder: 0, createdAt: 'x', updatedAt: 'y' },
  );
  assertEquals(built.displayName, null);
});

test('announced_metadata round-trips a populated override', () => {
  const withOverride: ModelAliasRecord = {
    ...record,
    announcedMetadata: {
      limits: { max_output_tokens: 8192 },
      chat: { modalities: { input: ['text'], output: ['text'] } },
    },
  };
  const wire = recordToWire(withOverride);
  assertEquals(wire.announced_metadata, {
    limits: { max_output_tokens: 8192 },
    chat: { modalities: { input: ['text'], output: ['text'] } },
  });
  const roundTripped = wireToRecord(wire, {
    id: wire.id,
    sortOrder: wire.sort_order,
    createdAt: wire.created_at,
    updatedAt: wire.updated_at,
  });
  assertEquals(roundTripped, withOverride);
});
