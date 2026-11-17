import { describe, expect, test } from 'vitest';

import { chatTargetPicker } from '../../../../src/data-plane/chat/shared/target-picker.ts';
import { assertEquals } from '@floway-dev/test-utils';

describe('chatTargetPicker', () => {

  test('pick honours the preference order even when later preferences are present', () => {
    const anthropicMessagesFirst = chatTargetPicker(['anthropicMessages', 'openaiResponses']);
    const openaiResponsesFirst = chatTargetPicker(['openaiResponses', 'anthropicMessages']);
    const endpoints = { anthropicMessages: {}, openaiResponses: {} };
    assertEquals(anthropicMessagesFirst.pick(endpoints), 'anthropicMessages');
    assertEquals(openaiResponsesFirst.pick(endpoints), 'openaiResponses');
  });

  test('pick throws on a candidate the picker rejects — serve must filter via canServe first', () => {
    const picker = chatTargetPicker(['anthropicMessages']);
    // The throw itself is the contract; the exact message text is not.
    expect(() => picker.pick({ openaiChatCompletions: {} })).toThrow(Error);
  });
});
