import { expect, test } from 'vitest';

import { readAnthropicMessagesRequest } from '../../../../src/protocols/anthropic-messages/as-source/input-to.ts';

test('reads document metadata and nested part attributes into the IR', () => {
  const citation = {
    type: 'char_location' as const, cited_text: 'caption', document_index: 0, document_title: null,
    start_char_index: 0, end_char_index: 7,
  };
  const reading = readAnthropicMessagesRequest({
    model: 'm', max_tokens: 32, messages: [{
      role: 'user',
      content: [{
        type: 'document', title: 'Report', context: 'USD', citations: { enabled: true },
        cache_control: { type: 'ephemeral', ttl: '1h' },
        source: {
          type: 'content', content: [
            { type: 'text', text: 'caption', citations: [citation], cache_control: null },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' }, transformations: { oversized_image: 'downsize' }, cache_control: { type: 'ephemeral' } },
          ],
        },
      }],
    }],
  });

  expect(reading.turns[0].toIRInputTurns()).toStrictEqual([{
    kind: 'client', items: [{
      type: 'message', role: 'user', content: [{
        type: 'document', document: {
          title: 'Report', context: 'USD', citations: { enabled: true }, cache_control: { type: 'ephemeral', ttl: '1h' },
          source: {
            source_kind: 'content', content: [
              { type: 'text', text: 'caption', citations: [citation], cache_control: null },
              { type: 'image', image: { source_kind: 'base64', media_type: 'image/png', data: 'AAAA' }, transformations: { oversized_image: 'downsize' }, cache_control: { type: 'ephemeral' } },
            ],
          },
        },
      }],
    }],
  }]);
});

test('distinguishes null document metadata from absent metadata', () => {
  const document = { type: 'document' as const, source: { type: 'text' as const, media_type: 'text/plain' as const, data: 'body' } };
  const reading = readAnthropicMessagesRequest({
    model: 'm', max_tokens: 32, messages: [{
      role: 'user', content: [
        document,
        { ...document, title: null, context: null, citations: null, cache_control: null },
        { ...document, citations: {} },
      ],
    }],
  });
  const [turn] = reading.turns[0].toIRInputTurns();
  if (turn.kind !== 'client' || turn.items[0].type !== 'message') throw new Error('Expected a user message');
  expect(turn.items[0].content).toStrictEqual([
    { type: 'document', document: { source: { source_kind: 'text', media_type: 'text/plain', text: 'body' } } },
    { type: 'document', document: { source: { source_kind: 'text', media_type: 'text/plain', text: 'body' }, title: null, context: null, citations: null, cache_control: null } },
    { type: 'document', document: { source: { source_kind: 'text', media_type: 'text/plain', text: 'body' }, citations: {} } },
  ]);
});
