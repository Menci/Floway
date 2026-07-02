import { test } from 'vitest';

import { translateChatCompletionsToMessages } from './request.ts';
import type { RemoteImageLoader } from '../shared/via-messages/remote-images.ts';
import { assertEquals, assertExists, assertFalse, assertRejects } from '../test-assert.ts';
import type { ChatCompletionsMessage, ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import {
  MESSAGES_FALLBACK_MAX_TOKENS,
  type MessagesAssistantContentBlock,
  type MessagesClientTool,
  type MessagesPayload,
  type MessagesRedactedThinkingBlock,
  type MessagesTextBlock,
  type MessagesThinkingBlock,
  type MessagesToolResultBlock,
  type MessagesToolUseBlock,
  type MessagesUserContentBlock,
} from '@floway-dev/protocols/messages';

// ── Helpers ──

function mkPayload(
  overrides: Partial<ChatCompletionsPayload> & {
    messages: ChatCompletionsPayload['messages'];
  },
): ChatCompletionsPayload {
  return { model: 'claude-sonnet-4', ...overrides };
}

function assistantBlocks(result: MessagesPayload, msgIndex = 0): MessagesAssistantContentBlock[] {
  const msg = result.messages[msgIndex];
  assertEquals(msg.role, 'assistant');
  return msg.content as MessagesAssistantContentBlock[];
}

function userBlocks(result: MessagesPayload, msgIndex = 0): MessagesUserContentBlock[] {
  const msg = result.messages[msgIndex];
  assertEquals(msg.role, 'user');
  return Array.isArray(msg.content) ? (msg.content as MessagesUserContentBlock[]) : [{ type: 'text', text: msg.content as string }];
}

function stubRemoteImageLoader(result: Awaited<ReturnType<RemoteImageLoader>>): RemoteImageLoader {
  return () => Promise.resolve(result);
}

// ── service_tier → speed mapping ──

test('translateChatCompletionsToMessages maps service_tier:fast to speed:fast (no service_tier on target)', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [{ role: 'user', content: 'hi' }],
      service_tier: 'fast',
    }),
  );

  assertEquals(result.speed, 'fast');
  assertFalse('service_tier' in result);
});

test('translateChatCompletionsToMessages passes service_tier:priority through as service_tier (no speed override)', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [{ role: 'user', content: 'hi' }],
      service_tier: 'priority',
    }),
  );

  assertEquals(result.service_tier, 'priority');
  assertFalse('speed' in result);
});

test('translateChatCompletionsToMessages passes service_tier:auto through as service_tier', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [{ role: 'user', content: 'hi' }],
      service_tier: 'auto',
    }),
  );

  assertEquals(result.service_tier, 'auto');
  assertFalse('speed' in result);
});

test('translateChatCompletionsToMessages omits both speed and service_tier when service_tier is absent', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [{ role: 'user', content: 'hi' }],
    }),
  );

  assertFalse('speed' in result);
  assertFalse('service_tier' in result);
});

test('leading system message hoisted to top-level system field', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hi' },
      ],
    }),
  );
  assertEquals(result.system, [{ type: 'text', text: 'You are helpful.', cache_control: { type: 'ephemeral' } }]);
  assertEquals(result.messages.length, 1);
  assertEquals(result.messages[0].role, 'user');
});

test('leading developer message hoisted as system', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [
        { role: 'developer', content: 'Dev instructions' },
        { role: 'user', content: 'Hi' },
      ],
    }),
  );
  assertEquals(result.system, [{ type: 'text', text: 'Dev instructions', cache_control: { type: 'ephemeral' } }]);
  assertEquals(result.messages.length, 1);
});

test('non-leading system stays inline, leading is hoisted', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [
        { role: 'system', content: 'First' },
        { role: 'user', content: 'Hi' },
        { role: 'developer', content: 'Second' },
        { role: 'user', content: 'Bye' },
      ],
    }),
  );
  assertEquals(result.system, [{ type: 'text', text: 'First', cache_control: { type: 'ephemeral' } }]);
  assertEquals(result.messages.length, 3);
  assertEquals(result.messages[0].role, 'user');
  assertEquals(result.messages[1], { role: 'system', content: [{ type: 'text', text: 'Second' }] });
  assertEquals(result.messages[2].role, 'user');
});

test('empty leading system content is not hoisted', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [
        { role: 'system', content: '' },
        { role: 'user', content: 'Hi' },
      ],
    }),
  );
  assertEquals(result.system, undefined);
  assertEquals(result.messages.length, 1);
});

test('leading empty system is skipped, leading non-empty is still hoisted', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [
        { role: 'system', content: '' },
        { role: 'developer', content: 'Be terse.' },
        { role: 'user', content: 'Hi' },
      ],
    }),
  );
  assertEquals(result.system, [{ type: 'text', text: 'Be terse.', cache_control: { type: 'ephemeral' } }]);
  assertEquals(result.messages.length, 1);
  assertEquals(result.messages[0].role, 'user');
});

test('leading system with ContentPart array preserves text parts as separate blocks', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [
        {
          role: 'system',
          content: [
            { type: 'text', text: 'A' },
            { type: 'text', text: 'B' },
          ],
        },
        { role: 'user', content: 'Hi' },
      ],
    }),
  );
  assertEquals(result.system, [
    { type: 'text', text: 'A' },
    { type: 'text', text: 'B', cache_control: { type: 'ephemeral' } },
  ]);
  assertEquals(result.messages.length, 1);
});

test('multiple consecutive leading system messages accumulate as separate blocks', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [
        { role: 'system', content: 'First' },
        { role: 'developer', content: 'Second' },
        { role: 'user', content: 'Hi' },
      ],
    }),
  );
  assertEquals(result.system, [
    { type: 'text', text: 'First' },
    { type: 'text', text: 'Second', cache_control: { type: 'ephemeral' } },
  ]);
  assertEquals(result.messages.length, 1);
});

test('image content part in leading system message throws', async () => {
  await assertRejects(
    () =>
      translateChatCompletionsToMessages(
        mkPayload({
          messages: [
            {
              role: 'system',
              content: [
                { type: 'text', text: 'You are helpful.' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
              ],
            },
            { role: 'user', content: 'Hi' },
          ],
        }),
      ),
    Error,
    "Invalid 'image_url' content part in system or developer message",
  );
});

test('image content part in non-leading system message throws', async () => {
  await assertRejects(
    () =>
      translateChatCompletionsToMessages(
        mkPayload({
          messages: [
            { role: 'user', content: 'Hi' },
            {
              role: 'system',
              content: [
                { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
              ],
            },
            { role: 'user', content: 'Bye' },
          ],
        }),
      ),
    Error,
    "Invalid 'image_url' content part in system or developer message",
  );
});

// ── Basic message mapping ──

test('simple user message → string content', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [{ role: 'user', content: 'Hello' }],
    }),
  );
  assertEquals(result.messages.length, 1);
  assertEquals(result.messages[0].role, 'user');
  // Last message of the request gets promoted to a single text block with a
  // cache breakpoint by applyLastMessageCacheBreakpoint.
  assertEquals(result.messages[0].content, [{ type: 'text', text: 'Hello', cache_control: { type: 'ephemeral' } }]);
});

test('simple assistant message → text block', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello!' },
      ],
    }),
  );
  const blocks = assistantBlocks(result, 1);
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0].type, 'text');
  assertEquals((blocks[0] as MessagesTextBlock).text, 'Hello!');
});

test('assistant with null content → empty text block', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: null },
      ],
    }),
  );
  const blocks = assistantBlocks(result, 1);
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0].type, 'text');
  assertEquals((blocks[0] as MessagesTextBlock).text, '');
});

test('user with null content → empty text block', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [{ role: 'user', content: null }],
    }),
  );
  const blocks = userBlocks(result, 0);
  assertEquals(blocks.length, 1);
  assertEquals((blocks[0] as MessagesTextBlock).text, '');
});

// ── User/user merge ──

test('consecutive user messages merged', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [
        { role: 'user', content: 'First' },
        { role: 'user', content: 'Second' },
      ],
    }),
  );
  assertEquals(result.messages.length, 1);
  assertEquals(result.messages[0].role, 'user');
  const blocks = userBlocks(result, 0);
  assertEquals(blocks.length, 2);
  assertEquals((blocks[0] as MessagesTextBlock).text, 'First');
  assertEquals((blocks[1] as MessagesTextBlock).text, 'Second');
});

test('three consecutive users all merged into one', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [
        { role: 'user', content: 'A' },
        { role: 'user', content: 'B' },
        { role: 'user', content: 'C' },
      ],
    }),
  );
  assertEquals(result.messages.length, 1);
  const blocks = userBlocks(result, 0);
  assertEquals(blocks.length, 3);
});

// ── Tool messages ──

test('tool message creates user with tool_result block', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [
        { role: 'user', content: 'Hi' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'tc1',
              type: 'function',
              function: { name: 'f', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', content: 'result', tool_call_id: 'tc1' },
      ],
    }),
  );
  assertEquals(result.messages.length, 3);
  assertEquals(result.messages[2].role, 'user');
  const blocks = result.messages[2].content as MessagesUserContentBlock[];
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0].type, 'tool_result');
  assertEquals((blocks[0] as MessagesToolResultBlock).tool_use_id, 'tc1');
  assertEquals((blocks[0] as MessagesToolResultBlock).content, 'result');
});

test('multiple tool messages after assistant merged into one user', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [
        { role: 'user', content: 'Hi' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'tc1',
              type: 'function',
              function: { name: 'f1', arguments: '{}' },
            },
            {
              id: 'tc2',
              type: 'function',
              function: { name: 'f2', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', content: 'r1', tool_call_id: 'tc1' },
        { role: 'tool', content: 'r2', tool_call_id: 'tc2' },
      ],
    }),
  );
  assertEquals(result.messages.length, 3);
  assertEquals(result.messages[2].role, 'user');
  const blocks = result.messages[2].content as MessagesUserContentBlock[];
  assertEquals(blocks.length, 2);
  assertEquals((blocks[0] as MessagesToolResultBlock).tool_use_id, 'tc1');
  assertEquals((blocks[1] as MessagesToolResultBlock).tool_use_id, 'tc2');
});

test('tool + user merged: tool_results + text in same user msg', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [
        { role: 'user', content: 'Hi' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'tc1',
              type: 'function',
              function: { name: 'f', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', content: 'result', tool_call_id: 'tc1' },
        { role: 'user', content: 'thanks' },
      ],
    }),
  );
  assertEquals(result.messages.length, 3);
  const blocks = result.messages[2].content as MessagesUserContentBlock[];
  assertEquals(blocks.length, 2);
  assertEquals(blocks[0].type, 'tool_result');
  assertEquals(blocks[1].type, 'text');
  assertEquals((blocks[1] as MessagesTextBlock).text, 'thanks');
});

test('tool message without tool_call_id is rejected', async () => {
  await assertRejects(
    () =>
      translateChatCompletionsToMessages(
        mkPayload({
          messages: [
            { role: 'user', content: 'Hi' },
            {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'tc1',
                  type: 'function',
                  function: { name: 'f', arguments: '{}' },
                },
              ],
            },
            { role: 'tool', content: 'result' },
          ],
        }),
      ),
    Error,
    'tool_call_id',
  );
});

// ── Assistant content block ordering ──

test('assistant blocks ordered: thinking → text → tool_use', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [
        { role: 'user', content: 'Hi' },
        {
          role: 'assistant',
          content: 'response text',
          reasoning_text: 'I think...',
          reasoning_opaque: 'sig123',
          tool_calls: [
            {
              id: 'tc1',
              type: 'function',
              function: { name: 'search', arguments: '{"q":"x"}' },
            },
          ],
        },
      ],
    }),
  );
  const blocks = assistantBlocks(result, 1);
  assertEquals(blocks.length, 3);
  assertEquals(blocks[0].type, 'thinking');
  assertEquals(blocks[1].type, 'text');
  assertEquals(blocks[2].type, 'tool_use');
});

test('assistant with only tool_calls, no content', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [
        { role: 'user', content: 'Hi' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'tc1',
              type: 'function',
              function: { name: 'f', arguments: '{"a":1}' },
            },
          ],
        },
      ],
    }),
  );
  const blocks = assistantBlocks(result, 1);
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0].type, 'tool_use');
  assertEquals((blocks[0] as MessagesToolUseBlock).name, 'f');
  assertEquals((blocks[0] as MessagesToolUseBlock).input, { a: 1 });
});

test('assistant with multiple tool_calls', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [
        { role: 'user', content: 'Hi' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'tc1',
              type: 'function',
              function: { name: 'f1', arguments: '{"x":1}' },
            },
            {
              id: 'tc2',
              type: 'function',
              function: { name: 'f2', arguments: '{"y":2}' },
            },
          ],
        },
      ],
    }),
  );
  const blocks = assistantBlocks(result, 1);
  assertEquals(blocks.length, 2);
  assertEquals(blocks[0].type, 'tool_use');
  assertEquals(blocks[1].type, 'tool_use');
  assertEquals((blocks[0] as MessagesToolUseBlock).id, 'tc1');
  assertEquals((blocks[1] as MessagesToolUseBlock).id, 'tc2');
});

test('assistant tool_calls with invalid JSON arguments → raw_arguments fallback', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [
        { role: 'user', content: 'Hi' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'tc1',
              type: 'function',
              function: { name: 'f', arguments: 'not json' },
            },
          ],
        },
      ],
    }),
  );
  const blocks = assistantBlocks(result, 1);
  assertEquals((blocks[0] as MessagesToolUseBlock).input, {
    raw_arguments: 'not json',
  });
});

// ── Thinking / Redacted thinking ──

test('reasoning_text + reasoning_opaque → thinking block with signature', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [
        { role: 'user', content: 'Hi' },
        {
          role: 'assistant',
          content: 'resp',
          reasoning_text: 'My thoughts',
          reasoning_opaque: 'sig',
        },
      ],
    }),
  );
  const blocks = assistantBlocks(result, 1);
  const thinking = blocks[0] as MessagesThinkingBlock;
  assertEquals(thinking.type, 'thinking');
  assertEquals(thinking.thinking, 'My thoughts');
  assertEquals(thinking.signature, 'sig');
});

test('reasoning_text only → thinking block without signature', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'resp', reasoning_text: 'My thoughts' },
      ],
    }),
  );
  const blocks = assistantBlocks(result, 1);
  const thinking = blocks[0] as MessagesThinkingBlock;
  assertEquals(thinking.type, 'thinking');
  assertEquals(thinking.thinking, 'My thoughts');
  assertEquals(thinking.signature, undefined);
});

test('reasoning_opaque only → redacted_thinking block', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'resp', reasoning_opaque: 'opaque_data' },
      ],
    }),
  );
  const blocks = assistantBlocks(result, 1);
  const redacted = blocks[0] as MessagesRedactedThinkingBlock;
  assertEquals(redacted.type, 'redacted_thinking');
  assertEquals(redacted.data, 'opaque_data');
});

test('no reasoning fields → no thinking block', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'resp' },
      ],
    }),
  );
  const blocks = assistantBlocks(result, 1);
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0].type, 'text');
});

test('null reasoning fields → no thinking block', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [
        { role: 'user', content: 'Hi' },
        {
          role: 'assistant',
          content: 'resp',
          reasoning_text: null,
          reasoning_opaque: null,
        },
      ],
    }),
  );
  const blocks = assistantBlocks(result, 1);
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0].type, 'text');
});

// ── Image handling ──

test('image_url with data URL → base64 image block', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' },
            },
          ],
        },
      ],
    }),
  );
  const blocks = userBlocks(result, 0);
  assertEquals(blocks.length, 2);
  assertEquals(blocks[0].type, 'text');
  assertEquals(blocks[1].type, 'image');
  const img = blocks[1] as {
    type: 'image';
    source: { type: string; media_type: string; data: string };
  };
  assertEquals(img.source.type, 'base64');
  assertEquals(img.source.media_type, 'image/png');
  assertEquals(img.source.data, 'iVBORw0KGgo=');
});

test('image_url with remote image loader → base64 image block', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            {
              type: 'image_url',
              image_url: { url: 'https://example.com/image.png' },
            },
          ],
        },
      ],
    }),
    {
      loadRemoteImage: stubRemoteImageLoader({
        mediaType: 'image/png',
        data: new Uint8Array([1, 2, 3]),
      }),
    },
  );
  const blocks = userBlocks(result, 0);
  assertEquals(blocks.length, 2);
  assertEquals(blocks[0].type, 'text');
  assertEquals(blocks[1].type, 'image');
  const img = blocks[1] as {
    type: 'image';
    source: { type: string; media_type: string; data: string };
  };
  assertEquals(img.source.type, 'base64');
  assertEquals(img.source.media_type, 'image/png');
  assertEquals(img.source.data, 'AQID');
});

test('image_url with remote image loader failure → gracefully skipped', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What?' },
            {
              type: 'image_url',
              image_url: { url: 'https://example.com/nonexistent.png' },
            },
          ],
        },
      ],
    }),
    {
      loadRemoteImage: stubRemoteImageLoader(null),
    },
  );
  const blocks = userBlocks(result, 0);
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0].type, 'text');
});

test('image with jpeg media type', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: 'data:image/jpeg;base64,/9j/4AAQ=' },
            },
          ],
        },
      ],
    }),
  );
  const blocks = userBlocks(result, 0);
  assertEquals(blocks.length, 1);
  const img = blocks[0] as { type: 'image'; source: { media_type: string } };
  assertEquals(img.source.media_type, 'image/jpeg');
});

test('data URL with unsupported media type → skipped', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'data:image/bmp;base64,Qk0=' } }],
        },
      ],
    }),
  );
  const blocks = userBlocks(result, 0);
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0].type, 'text');
  assertEquals((blocks[0] as MessagesTextBlock).text, '');
});

test('content with only non-parseable image → empty text fallback', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'not-a-url-at-all' } }],
        },
      ],
    }),
  );
  const blocks = userBlocks(result, 0);
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0].type, 'text');
  assertEquals((blocks[0] as MessagesTextBlock).text, '');
});

// ── Field mapping ──

test('max_tokens defaults to MESSAGES_FALLBACK_MAX_TOKENS when neither payload nor fallbackMaxOutputTokens supply one', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [{ role: 'user', content: 'Hi' }],
    }),
  );
  assertEquals(result.max_tokens, MESSAGES_FALLBACK_MAX_TOKENS);
});

test('max_tokens uses fallbackMaxOutputTokens over the gateway const when the payload omits it', async () => {
  const result = await translateChatCompletionsToMessages(mkPayload({ messages: [{ role: 'user', content: 'Hi' }] }), { fallbackMaxOutputTokens: 6144 });
  assertEquals(result.max_tokens, 6144);
});

test('max_tokens passed through when provided, overriding fallbackMaxOutputTokens', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 1024,
    }),
    { fallbackMaxOutputTokens: 6144 },
  );
  assertEquals(result.max_tokens, 1024);
});

test('temperature mapped', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [{ role: 'user', content: 'Hi' }],
      temperature: 0.7,
    }),
  );
  assertEquals(result.temperature, 0.7);
});

test('temperature 0 is mapped (not treated as falsy)', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [{ role: 'user', content: 'Hi' }],
      temperature: 0,
    }),
  );
  assertEquals(result.temperature, 0);
});

test('top_p mapped', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [{ role: 'user', content: 'Hi' }],
      top_p: 0.9,
    }),
  );
  assertEquals(result.top_p, 0.9);
});

test('null temperature/top_p not included', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [{ role: 'user', content: 'Hi' }],
      temperature: null,
      top_p: null,
    }),
  );
  assertEquals(result.temperature, undefined);
  assertEquals(result.top_p, undefined);
});

test('stop string → stop_sequences array', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [{ role: 'user', content: 'Hi' }],
      stop: 'END',
    }),
  );
  assertEquals(result.stop_sequences, ['END']);
});

test('stop array → stop_sequences array', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [{ role: 'user', content: 'Hi' }],
      stop: ['END', 'STOP'],
    }),
  );
  assertEquals(result.stop_sequences, ['END', 'STOP']);
});

test('always emits stream: true regardless of source stream flag', async () => {
  // Translation assumes streaming upstream (provider forces stream=true);
  // source `respond.ts` collects SSE when client wants non-stream.
  const streamed = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    }),
  );
  assertEquals(streamed.stream, true);

  const nonStreamed = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [{ role: 'user', content: 'Hi' }],
      stream: false,
    }),
  );
  assertEquals(nonStreamed.stream, true);
});

// ── Tool choice mapping ──

test('tool_choice auto → { type: auto }', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [{ type: 'function', function: { name: 'f', parameters: {} } }],
      tool_choice: 'auto',
    }),
  );
  assertEquals(result.tool_choice, { type: 'auto' });
});

test('tool_choice none → { type: none }', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [{ role: 'user', content: 'Hi' }],
      tool_choice: 'none',
    }),
  );
  assertEquals(result.tool_choice, { type: 'none' });
});

test('tool_choice required → { type: any }', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [{ type: 'function', function: { name: 'f', parameters: {} } }],
      tool_choice: 'required',
    }),
  );
  assertEquals(result.tool_choice, { type: 'any' });
});

test('tool_choice specific function → { type: tool, name }', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [
        {
          type: 'function',
          function: { name: 'get_weather', parameters: {} },
        },
      ],
      tool_choice: { type: 'function', function: { name: 'get_weather' } },
    }),
  );
  assertEquals(result.tool_choice, { type: 'tool', name: 'get_weather' });
});

test('null tool_choice → not set', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [{ role: 'user', content: 'Hi' }],
      tool_choice: null,
    }),
  );
  assertEquals(result.tool_choice, undefined);
});

// ── Tools mapping ──

test('tools translated correctly', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get weather',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
            },
          },
        },
      ],
    }),
  );
  assertExists(result.tools);
  assertEquals(result.tools!.length, 1);
  const [tool] = result.tools!;
  if (!('input_schema' in tool)) {
    throw new Error('expected translated client tool');
  }
  assertEquals(tool.name, 'get_weather');
  assertEquals(tool.description, 'Get weather');
  assertEquals(tool.input_schema, {
    type: 'object',
    properties: { city: { type: 'string' } },
  });
});

test('tools preserve explicit strict values', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'strict_tool',
            parameters: { type: 'object' },
            strict: true,
          },
        },
        {
          type: 'function',
          function: {
            name: 'non_strict_tool',
            parameters: { type: 'object' },
            strict: false,
          },
        },
      ],
    }),
  );

  assertEquals(
    (result.tools as MessagesClientTool[] | undefined)?.map(tool => tool.strict),
    [true, false],
  );
});

test('tools omit strict when Chat omitted strict', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'default_tool',
            parameters: { type: 'object' },
          },
        },
      ],
    }),
  );

  const tool = result.tools?.[0] as MessagesClientTool | undefined;
  assertEquals(tool?.strict, undefined);
  assertEquals('strict' in result.tools![0], false);
});

test('empty tools array → not set', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [],
    }),
  );
  assertEquals(result.tools, undefined);
});

// ── Model passthrough ──

test('model name passed through', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      model: 'claude-opus-4',
      messages: [{ role: 'user', content: 'Hi' }],
    }),
  );
  assertEquals(result.model, 'claude-opus-4');
});

// ── Complex multi-turn conversations ──

test('full tool use round-trip conversation', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'What is the weather?' },
        {
          role: 'assistant',
          content: 'Let me check.',
          tool_calls: [
            {
              id: 'tc1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' },
            },
          ],
        },
        { role: 'tool', content: '{"temp":20}', tool_call_id: 'tc1' },
        { role: 'assistant', content: "It's 20 degrees in Tokyo." },
      ],
    }),
  );
  assertEquals(result.system, [{ type: 'text', text: 'You are helpful.', cache_control: { type: 'ephemeral' } }]);
  assertEquals(result.messages.length, 4);
  assertEquals(result.messages[0].role, 'user');
  assertEquals(result.messages[1].role, 'assistant');
  assertEquals(result.messages[2].role, 'user');
  assertEquals(result.messages[3].role, 'assistant');
  const trBlocks = result.messages[2].content as MessagesUserContentBlock[];
  assertEquals(trBlocks[0].type, 'tool_result');
});

// ── Cache breakpoints ──

test('attaches ephemeral cache breakpoints to last function tool and last message block', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Look up the weather.' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' } }],
        },
        { role: 'tool', content: '{"temp":20}', tool_call_id: 'tc1' },
      ],
      tools: [
        { type: 'function', function: { name: 'get_time', parameters: { type: 'object', properties: {} } } },
        { type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: {} } } },
      ],
    }),
  );

  assertEquals(result.system, [{ type: 'text', text: 'You are helpful.', cache_control: { type: 'ephemeral' } }]);

  const tools = result.tools as MessagesClientTool[];
  assertEquals(tools[0].cache_control, undefined);
  assertEquals(tools[1].cache_control, { type: 'ephemeral' });

  const lastMessage = result.messages[result.messages.length - 1];
  const lastBlock = (lastMessage.content as MessagesUserContentBlock[]).at(-1) as MessagesToolResultBlock;
  assertEquals(lastBlock.type, 'tool_result');
  assertEquals(lastBlock.cache_control, { type: 'ephemeral' });
});

test('attaches ephemeral cache breakpoint to the promoted text block when last message is assistant with string content', async () => {
  // Promotion path: assistant.content === string → wrapped into a single
  // text block carrying the breakpoint. Mirrors the user-string case but
  // exercises the assistant branch of the message-content union.
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello!' },
      ],
    }),
  );

  const lastMessage = result.messages[result.messages.length - 1];
  assertEquals(lastMessage.role, 'assistant');
  assertEquals(lastMessage.content, [{ type: 'text', text: 'Hello!', cache_control: { type: 'ephemeral' } }]);
});

test('interleaved thinking round-trip', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [
        { role: 'user', content: 'Solve this.' },
        {
          role: 'assistant',
          content: null,
          reasoning_text: 'thinking1',
          reasoning_opaque: 'sig1',
          tool_calls: [
            {
              id: 'tc1',
              type: 'function',
              function: { name: 'calc', arguments: '{"x":1}' },
            },
          ],
        },
        { role: 'tool', content: '42', tool_call_id: 'tc1' },
        {
          role: 'assistant',
          content: 'The answer is 42.',
          reasoning_text: 'thinking2',
          reasoning_opaque: 'sig2',
        },
      ],
    }),
  );
  assertEquals(result.messages.length, 4);

  const a1 = assistantBlocks(result, 1);
  assertEquals(a1[0].type, 'thinking');
  assertEquals(a1[1].type, 'tool_use');

  const a2 = assistantBlocks(result, 3);
  assertEquals(a2[0].type, 'thinking');
  assertEquals(a2[1].type, 'text');
});

test('translateChatCompletionsToMessages extracts nested response_format json_schema into output_config.format', async () => {
  const schema = { type: 'object', properties: { x: { type: 'string' } }, required: ['x'], additionalProperties: false };
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [{ role: 'user', content: 'Hi' }],
      response_format: { type: 'json_schema', json_schema: { name: 'whatever', strict: true, schema } },
    }),
  );

  assertEquals(result.output_config, { format: { type: 'json_schema', schema } });
});

test('translateChatCompletionsToMessages merges reasoning_effort with structured-output format on a single output_config', async () => {
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [{ role: 'user', content: 'Hi' }],
      reasoning_effort: 'high',
      response_format: { type: 'json_schema', json_schema: { schema } },
    }),
  );

  assertEquals(result.output_config, { effort: 'high', format: { type: 'json_schema', schema } });
});

test('translateChatCompletionsToMessages drops response_format json_object (no Anthropic equivalent)', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [{ role: 'user', content: 'Hi' }],
      response_format: { type: 'json_object' },
    }),
  );

  assertEquals(result.output_config, undefined);
});

test('translateChatCompletionsToMessages rejects an unknown message role', async () => {
  await assertRejects(
    () =>
      translateChatCompletionsToMessages({
        model: 'claude-test',
        messages: [{ role: 'function', content: 'hi' } as unknown as ChatCompletionsMessage],
      }),
    Error,
    "Invalid role 'function'",
  );
});

test('translateChatCompletionsToMessages rejects an unknown user content part type', async () => {
  await assertRejects(
    () =>
      translateChatCompletionsToMessages({
        model: 'claude-test',
        messages: [{ role: 'user', content: [{ type: 'video_url' }] } as unknown as ChatCompletionsMessage],
      }),
    Error,
    "Invalid 'video_url' content part",
  );
});

// ── service_tier forwarding ──

test('translateChatCompletionsToMessages forwards service_tier verbatim', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [{ role: 'user', content: 'hi' }],
      service_tier: 'priority',
    }),
  );

  assertEquals(result.service_tier, 'priority');
});

test('translateChatCompletionsToMessages does not emit thinking or fast-mode fields for a bare payload', async () => {
  const result = await translateChatCompletionsToMessages(
    mkPayload({
      messages: [{ role: 'user', content: 'hi' }],
    }),
  );

  assertEquals(result.thinking, undefined);
  assertEquals(result.speed, undefined);
  assertEquals(result.service_tier, undefined);
});
