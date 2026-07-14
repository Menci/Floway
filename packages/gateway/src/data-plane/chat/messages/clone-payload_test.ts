import { test } from 'vitest';

import { cloneMessagesPayload } from './clone-payload.ts';
import type { MessagesPayload } from '@floway-dev/protocols/messages';
import { assert, assertEquals } from '@floway-dev/test-utils';

test('cloneMessagesPayload isolates every mutable Messages container', () => {
  const source: MessagesPayload = {
    model: 'claude-test',
    max_tokens: 128,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    metadata: { user_id: 'user-1' },
  };

  const cloned = cloneMessagesPayload(source);
  const sourceContent = source.messages[0].content;
  const clonedContent = cloned.messages[0].content;
  if (!Array.isArray(sourceContent) || !Array.isArray(clonedContent)) throw new Error('expected array content');

  assert(cloned !== source);
  assert(cloned.messages !== source.messages);
  assert(cloned.messages[0] !== source.messages[0]);
  assert(clonedContent !== sourceContent);
  assert(clonedContent[0] !== sourceContent[0]);
  assert(cloned.metadata !== source.metadata);

  if (clonedContent[0].type !== 'text' || sourceContent[0].type !== 'text') throw new Error('expected text content');
  clonedContent[0].text = 'changed';

  assertEquals(sourceContent[0].text, 'hello');
  assertEquals(source.metadata?.user_id, 'user-1');
});
