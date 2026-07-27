import { test } from 'vitest';

import { multiAgentCallOutputText, multiAgentMessageContent } from '../../../src/shared/responses-via/multi-agent.ts';
import type { ResponsesInputAgentMessageItem } from '@floway-dev/protocols/responses';
import { assertEquals, assertFalse, assertThrows } from '@floway-dev/test-utils';

const agentMessage = (content: ResponsesInputAgentMessageItem['content']): ResponsesInputAgentMessageItem => ({
  type: 'agent_message',
  author: '/root/reviewer',
  recipient: '/root',
  content,
});

test('multiAgentMessageContent normalizes readable beta content into Responses input parts', () => {
  assertEquals(multiAgentMessageContent(agentMessage([
    { type: 'text', text: 'visible' },
    { type: 'summary_text', text: 'summary' },
    { type: 'reasoning_text', text: 'reasoning' },
    { type: 'refusal', refusal: 'refused' },
    { type: 'input_image', image_url: 'https://example.com/image.png', file_id: null, detail: 'high' },
    { type: 'computer_screenshot', image_url: null, file_id: 'file_screen', detail: 'original' },
    { type: 'input_file', file_id: 'file_doc' },
  ]), 'Messages'), [
    { type: 'input_text', text: 'Message Type: MESSAGE\nTask name: /root\nSender: /root/reviewer\nPayload:\n' },
    { type: 'input_text', text: 'visible' },
    { type: 'input_text', text: 'summary' },
    { type: 'input_text', text: 'reasoning' },
    { type: 'input_text', text: 'refused' },
    { type: 'input_image', image_url: 'https://example.com/image.png', file_id: null, detail: 'high' },
    { type: 'input_image', image_url: null, file_id: 'file_screen', detail: 'original' },
    { type: 'input_file', file_id: 'file_doc' },
  ]);
});

test('multiAgentMessageContent rejects encrypted content without reflecting it', () => {
  const error = assertThrows(
    () => multiAgentMessageContent(agentMessage([
      { type: 'encrypted_content', encrypted_content: 'opaque-secret' },
    ]), 'Chat Completions'),
    Error,
    'requires native Responses model execution',
  );
  assertFalse(error.message.includes('opaque-secret'));
});

test('multiAgentMessageContent rejects unknown beta content explicitly', () => {
  assertThrows(
    () => multiAgentMessageContent(agentMessage([{ type: 'future_agent_part', value: 1 }]), 'Messages'),
    Error,
    "content type 'future_agent_part'",
  );
});

test('multiAgentCallOutputText joins output fragments without inventing separators', () => {
  assertEquals(multiAgentCallOutputText({
    type: 'multi_agent_call_output',
    action: 'wait_agent',
    call_id: 'call_wait',
    output: [
      { type: 'output_text', text: 'agent_1: ' },
      { type: 'output_text', text: 'completed' },
    ],
  }), 'agent_1: completed');
});
