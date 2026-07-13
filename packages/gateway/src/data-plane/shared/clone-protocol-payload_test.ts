import { test } from 'vitest';

import { cloneProtocolPayload } from './clone-protocol-payload.ts';
import { assert, assertEquals } from '@floway-dev/test-utils';

test('cloneProtocolPayload isolates every mutable protocol container', () => {
  const source = {
    input: [{ content: [{ type: 'input_text', text: 'hello' }] }],
    metadata: { labels: ['one', 'two'] },
    optional: undefined,
  };

  const cloned = cloneProtocolPayload(source);

  assert(cloned !== source);
  assert(cloned.input !== source.input);
  assert(cloned.input[0] !== source.input[0]);
  assert(cloned.input[0].content !== source.input[0].content);
  assert(cloned.input[0].content[0] !== source.input[0].content[0]);
  assert(cloned.metadata !== source.metadata);
  assert(cloned.metadata.labels !== source.metadata.labels);

  cloned.input[0].content[0].text = 'changed';
  cloned.metadata.labels.push('three');

  assertEquals(source.input[0].content[0].text, 'hello');
  assertEquals(source.metadata.labels, ['one', 'two']);
  assertEquals(Object.hasOwn(cloned, 'optional'), true);
});
