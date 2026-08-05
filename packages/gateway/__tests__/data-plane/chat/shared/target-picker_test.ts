import { describe, expect, test } from 'vitest';

import { chatTargetPicker } from '../../../../src/data-plane/chat/shared/target-picker.ts';
import { assertEquals } from '@floway-dev/test-utils';

describe('chatTargetPicker', () => {
  test('canServe returns true when at least one preferred key matches the endpoint surface', () => {
    const picker = chatTargetPicker(['messages', 'responses']);
    assertEquals(picker.canServe({ messages: {} }), true);
    assertEquals(picker.canServe({ responses: {} }), true);
    assertEquals(picker.canServe({ messages: {}, responses: {} }), true);
  });

  test('canServe returns false when none of the preferred keys appear on the endpoint surface', () => {
    const picker = chatTargetPicker(['messages']);
    assertEquals(picker.canServe({ chatCompletions: {} }), false);
    assertEquals(picker.canServe({ responses: {} }), false);
    assertEquals(picker.canServe({}), false);
  });

  test('pick returns the first preferred key whose endpoint exists', () => {
    const picker = chatTargetPicker(['responses', 'messages', 'chat-completions']);
    assertEquals(picker.pick({ messages: {}, responses: {}, chatCompletions: {} }), 'responses');
    assertEquals(picker.pick({ messages: {}, chatCompletions: {} }), 'messages');
    assertEquals(picker.pick({ chatCompletions: {} }), 'chat-completions');
  });

  test('pick honours the preference order even when later preferences are present', () => {
    const messagesFirst = chatTargetPicker(['messages', 'responses']);
    const responsesFirst = chatTargetPicker(['responses', 'messages']);
    const endpoints = { messages: {}, responses: {} };
    assertEquals(messagesFirst.pick(endpoints), 'messages');
    assertEquals(responsesFirst.pick(endpoints), 'responses');
  });

  test('pick throws on a candidate the picker rejects — serve must filter via canServe first', () => {
    const picker = chatTargetPicker(['messages']);
    // The throw itself is the contract; the exact message text is not.
    expect(() => picker.pick({ chatCompletions: {} })).toThrow(Error);
  });
});
