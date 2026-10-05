import { test } from 'vitest';

import { createAnthropicMessagesToolProjection } from '../../src/openai-responses-via-anthropic-messages/tool-projection.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('keeps source callable kind separate from the selected target representation', () => {
  const projection = createAnthropicMessagesToolProjection();
  projection.sourceCallables.set('function:tool', { kind: 'root-schema-envelope' });
  projection.targetCallables.set('tool', { kind: 'custom-tool' });

  assertEquals(projection.sourceCallables, new Map([['function:tool', { kind: 'root-schema-envelope' }]]));
  assertEquals(projection.targetCallables, new Map([['tool', { kind: 'custom-tool' }]]));
});

test('creates independent empty namespace restoration state', () => {
  const first = createAnthropicMessagesToolProjection();
  const second = createAnthropicMessagesToolProjection();
  first.namespaces.sourceToTarget.set('files.read', 'files_read');

  assertEquals(second.namespaces.sourceToTarget, new Map());
  assertEquals(second.namespaces.targetToSource, new Map());
});
