import { test } from 'vitest';

import { buildTargetPayloadFor, pairs } from '../../composition/helpers.ts';
import { createTestSidecarCodec } from '../../round-trip/sidecar-codec.ts';
import {
  ANTHROPIC_MESSAGES_FALLBACK_MAX_TOKENS,
  type AnthropicMessagesAssistantContentBlock,
  type AnthropicMessagesClientTool,
  type AnthropicMessagesPayload,
  type AnthropicMessagesTextBlock,
  type AnthropicMessagesToolResultBlock,
  type AnthropicMessagesToolUseBlock,
  type AnthropicMessagesUserContentBlock,
} from '@floway-dev/protocols/anthropic-messages';
import type { OpenAIChatCompletionsAssistantMessageEx, OpenAIChatCompletionsMessage, OpenAIChatCompletionsPayload, OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';
import { assertEquals, assertExists, assertFalse, assertRejects } from '@floway-dev/test-utils';

// ── Helpers ──

function mkPayload(
  overrides: Partial<OpenAIChatCompletionsPayload> & {
    messages: OpenAIChatCompletionsPayload['messages'];
  },
): OpenAIChatCompletionsPayload {
  return { model: 'claude-sonnet-4', stream: true, ...overrides };
}

function assistantBlocks(result: AnthropicMessagesPayload, msgIndex = 0): AnthropicMessagesAssistantContentBlock[] {
  const msg = result.messages[msgIndex];
  assertEquals(msg.role, 'assistant');
  return msg.content as AnthropicMessagesAssistantContentBlock[];
}

function userBlocks(result: AnthropicMessagesPayload, msgIndex = 0): AnthropicMessagesUserContentBlock[] {
  const msg = result.messages[msgIndex];
  assertEquals(msg.role, 'user');
  return Array.isArray(msg.content) ? (msg.content as AnthropicMessagesUserContentBlock[]) : [{ type: 'text', text: msg.content as string }];
}

const testBuildOptions: { fallbackMaxOutputTokens?: number } = {
  fallbackMaxOutputTokens: undefined,
};

const buildWithTestSidecar = (
  payload: OpenAIChatCompletionsPayloadEx,
  options: Partial<typeof testBuildOptions> = {},
) => buildTargetPayloadFor(pairs.chatToMessages[0], pairs.chatToMessages[1], payload, { sidecarCodec: createTestSidecarCodec(), ...testBuildOptions, ...options });

test('buildTargetPayload preserves scalar and content-part assistant refusals as history text', async () => {
  const result = await buildWithTestSidecar(mkPayload({
    messages: [
      { role: 'assistant', content: null, refusal: 'Scalar refusal.' },
      { role: 'assistant', content: [{ type: 'refusal', refusal: 'Part refusal.' }] },
    ],
  }));

  assertEquals(result.messages, [
    { role: 'assistant', content: [{ type: 'text', text: 'Scalar refusal.' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Part refusal.', cache_control: { type: 'ephemeral' } }] },
  ]);
});

// ── service_tier → speed mapping ──

// OpenAI renamed priority processing to Fast mode; both spellings ask for the
// same lane, so both map onto Anthropic's `speed`.
test.each(['fast', 'priority'])('buildTargetPayload maps service_tier:%s to speed:fast (no service_tier on target)', async serviceTier => {
  const result = await buildWithTestSidecar(
    mkPayload({
      messages: [{ role: 'user', content: 'hi' }],
      service_tier: serviceTier,
    }),
  );

  assertEquals(result.speed, 'fast');
  assertFalse('service_tier' in result);
});

test('buildTargetPayload passes service_tier:auto through as service_tier', async () => {
  const result = await buildWithTestSidecar(
    mkPayload({
      messages: [{ role: 'user', content: 'hi' }],
      service_tier: 'auto',
    }),
  );

  assertEquals(result.service_tier, 'auto');
  assertFalse('speed' in result);
});

test('buildTargetPayload omits both speed and service_tier when service_tier is absent', async () => {
  const result = await buildWithTestSidecar(
    mkPayload({
      messages: [{ role: 'user', content: 'hi' }],
    }),
  );

  assertFalse('speed' in result);
  assertFalse('service_tier' in result);
});

test('leading system message hoisted to top-level system field', async () => {
  const result = await buildWithTestSidecar(
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
  const result = await buildWithTestSidecar(
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
  const result = await buildWithTestSidecar(
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
  const result = await buildWithTestSidecar(
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
  const result = await buildWithTestSidecar(
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
  const result = await buildWithTestSidecar(
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
  const result = await buildWithTestSidecar(
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
      buildWithTestSidecar(
        mkPayload({
          messages: [
            {
              role: 'system',
              content: [
                { type: 'text', text: 'You are helpful.' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
              ],
            } as unknown as OpenAIChatCompletionsMessage,
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
      buildWithTestSidecar(
        mkPayload({
          messages: [
            { role: 'user', content: 'Hi' },
            {
              role: 'system',
              content: [
                { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
              ],
            } as unknown as OpenAIChatCompletionsMessage,
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
  const result = await buildWithTestSidecar(
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
  const result = await buildWithTestSidecar(
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
  assertEquals((blocks[0] as AnthropicMessagesTextBlock).text, 'Hello!');
});

test('assistant with null content → empty text block', async () => {
  const result = await buildWithTestSidecar(
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
  assertEquals((blocks[0] as AnthropicMessagesTextBlock).text, '');
});

test('user with null content → empty text block', async () => {
  const result = await buildWithTestSidecar(
    mkPayload({
      messages: [{ role: 'user', content: null } as unknown as OpenAIChatCompletionsMessage],
    }),
  );
  const blocks = userBlocks(result, 0);
  assertEquals(blocks.length, 1);
  assertEquals((blocks[0] as AnthropicMessagesTextBlock).text, '');
});

// ── User/user merge ──

test('consecutive user messages merged', async () => {
  const result = await buildWithTestSidecar(
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
  assertEquals((blocks[0] as AnthropicMessagesTextBlock).text, 'First');
  assertEquals((blocks[1] as AnthropicMessagesTextBlock).text, 'Second');
});

test('three consecutive users all merged into one', async () => {
  const result = await buildWithTestSidecar(
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
  const result = await buildWithTestSidecar(
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
  const blocks = result.messages[2].content as AnthropicMessagesUserContentBlock[];
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0].type, 'tool_result');
  assertEquals((blocks[0] as AnthropicMessagesToolResultBlock).tool_use_id, 'tc1');
  assertEquals((blocks[0] as AnthropicMessagesToolResultBlock).content, 'result');
});

test('multiple tool messages after assistant merged into one user', async () => {
  const result = await buildWithTestSidecar(
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
  const blocks = result.messages[2].content as AnthropicMessagesUserContentBlock[];
  assertEquals(blocks.length, 2);
  assertEquals((blocks[0] as AnthropicMessagesToolResultBlock).tool_use_id, 'tc1');
  assertEquals((blocks[1] as AnthropicMessagesToolResultBlock).tool_use_id, 'tc2');
});

test('tool + user merged: tool_results + text in same user msg', async () => {
  const result = await buildWithTestSidecar(
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
  const blocks = result.messages[2].content as AnthropicMessagesUserContentBlock[];
  assertEquals(blocks.length, 2);
  assertEquals(blocks[0].type, 'tool_result');
  assertEquals(blocks[1].type, 'text');
  assertEquals((blocks[1] as AnthropicMessagesTextBlock).text, 'thanks');
});

test('tool message without tool_call_id is rejected', async () => {
  await assertRejects(
    () =>
      buildWithTestSidecar(
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
            { role: 'tool', content: 'result' } as unknown as OpenAIChatCompletionsMessage,
          ],
        }),
      ),
    Error,
    'tool_call_id',
  );
});

// ── Assistant content block ordering ──

test('assistant text precedes tool use', async () => {
  const result = await buildWithTestSidecar(
    mkPayload({
      messages: [
        { role: 'user', content: 'Hi' },
        {
          role: 'assistant',
          content: 'response text',
          tool_calls: [
            {
              id: 'tc1',
              type: 'function',
              function: { name: 'search', arguments: '{"q":"x"}' },
            },
          ],
        } as OpenAIChatCompletionsAssistantMessageEx,
      ],
    }),
  );
  const blocks = assistantBlocks(result, 1);
  assertEquals(blocks.length, 2);
  assertEquals(blocks[0].type, 'text');
  assertEquals(blocks[1].type, 'tool_use');
});

test('assistant with only tool_calls, no content', async () => {
  const result = await buildWithTestSidecar(
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
  assertEquals((blocks[0] as AnthropicMessagesToolUseBlock).name, 'f');
  assertEquals((blocks[0] as AnthropicMessagesToolUseBlock).input, { a: 1 });
});

test('assistant with multiple tool_calls', async () => {
  const result = await buildWithTestSidecar(
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
  assertEquals((blocks[0] as AnthropicMessagesToolUseBlock).id, 'tc1');
  assertEquals((blocks[1] as AnthropicMessagesToolUseBlock).id, 'tc2');
});

test('assistant tool_calls with invalid JSON arguments → raw_arguments fallback', async () => {
  const result = await buildWithTestSidecar(
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
  assertEquals((blocks[0] as AnthropicMessagesToolUseBlock).input, {
    raw_arguments: 'not json',
  });
});

// ── Thinking / Redacted thinking ──

// ── Image handling ──

test('image_url with data URL → base64 image block', async () => {
  const result = await buildWithTestSidecar(
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

test.each(['http', 'https', 'HTTP', 'HTTPS', 'hTtP', 'hTtPs'])('preserves a remote image URL with %s scheme', async scheme => {
  const url = `${scheme}://example.com/image.png`;
  const result = await buildWithTestSidecar(mkPayload({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'What is this?' },
        { type: 'image_url', image_url: { url } },
      ],
    }],
  }));

  // Preserve remote image URLs; provider-specific fetching belongs at the gateway boundary.
  const blocks = userBlocks(result, 0);
  assertEquals(blocks.length, 2);
  assertEquals(blocks[1], { type: 'image', source: { type: 'url', url }, cache_control: { type: 'ephemeral' } });
});

test('image with jpeg media type', async () => {
  const result = await buildWithTestSidecar(
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

test('a data URL is stated with the media type it declares', async () => {
  const result = await buildWithTestSidecar(
    mkPayload({
      messages: [
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'data:image/bmp;base64,Qk0=' } }],
        },
      ],
    }),
  );
  // Preserve the caller's media type so the selected upstream decides whether it accepts the image.
  const blocks = userBlocks(result, 0);
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0], { type: 'image', source: { type: 'base64', media_type: 'image/bmp', data: 'Qk0=' }, cache_control: { type: 'ephemeral' } });
});

test('content with a value that is not a URL is rejected rather than written', async () => {
  await assertRejects(
    () => buildWithTestSidecar(mkPayload({
      messages: [{
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'not-a-url-at-all' } }],
      }],
    })),
    Error,
    'requires an http or https URL',
  );
});

// ── Field mapping ──

test('max_tokens defaults to ANTHROPIC_MESSAGES_FALLBACK_MAX_TOKENS when neither payload nor fallbackMaxOutputTokens supply one', async () => {
  const result = await buildWithTestSidecar(
    mkPayload({
      messages: [{ role: 'user', content: 'Hi' }],
    }),
  );
  assertEquals(result.max_tokens, ANTHROPIC_MESSAGES_FALLBACK_MAX_TOKENS);
});

test('max_tokens uses fallbackMaxOutputTokens over the gateway const when the payload omits it', async () => {
  const result = await buildWithTestSidecar(mkPayload({ messages: [{ role: 'user', content: 'Hi' }] }), { fallbackMaxOutputTokens: 6144 });
  assertEquals(result.max_tokens, 6144);
});

test('max_tokens passed through when provided, overriding fallbackMaxOutputTokens', async () => {
  const result = await buildWithTestSidecar(
    mkPayload({
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 1024,
    }),
    { fallbackMaxOutputTokens: 6144 },
  );
  assertEquals(result.max_tokens, 1024);
});

test('temperature mapped', async () => {
  const result = await buildWithTestSidecar(
    mkPayload({
      messages: [{ role: 'user', content: 'Hi' }],
      temperature: 0.7,
    }),
  );
  assertEquals(result.temperature, 0.7);
});

test('temperature 0 is mapped (not treated as falsy)', async () => {
  const result = await buildWithTestSidecar(
    mkPayload({
      messages: [{ role: 'user', content: 'Hi' }],
      temperature: 0,
    }),
  );
  assertEquals(result.temperature, 0);
});

test('top_p mapped', async () => {
  const result = await buildWithTestSidecar(
    mkPayload({
      messages: [{ role: 'user', content: 'Hi' }],
      top_p: 0.9,
    }),
  );
  assertEquals(result.top_p, 0.9);
});

test('null temperature/top_p not included', async () => {
  const result = await buildWithTestSidecar(
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
  const result = await buildWithTestSidecar(
    mkPayload({
      messages: [{ role: 'user', content: 'Hi' }],
      stop: 'END',
    }),
  );
  assertEquals(result.stop_sequences, ['END']);
});

test('stop array → stop_sequences array', async () => {
  const result = await buildWithTestSidecar(
    mkPayload({
      messages: [{ role: 'user', content: 'Hi' }],
      stop: ['END', 'STOP'],
    }),
  );
  assertEquals(result.stop_sequences, ['END', 'STOP']);
});

test('states the streaming flag the trip requires', async () => {
  const result = await buildWithTestSidecar(mkPayload({ messages: [{ role: 'user', content: 'Hi' }] }));
  assertEquals(result.stream, true);
});

test('rejects a request the trip cannot carry because it states no stream', () => {
  // A trip's answer arrives as a stream, so an IR that says otherwise has no
  // translation. The boundary above a trip guarantees streaming, so this is a
  // broken contract rather than an unsupported request.
  return assertRejects(
    () => buildWithTestSidecar(mkPayload({ messages: [{ role: 'user', content: 'Hi' }], stream: false })),
    Error,
    'streaming',
  );
});

// ── Tool choice mapping ──

test.each([
  ['auto', { type: 'auto' }],
  ['none', { type: 'none' }],
  ['required', { type: 'any' }],
] as const)('tool_choice %s maps onto the Messages tool_choice', async (choice, expected) => {
  const result = await buildWithTestSidecar(
    mkPayload({
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }],
      tool_choice: choice,
    }),
  );
  assertEquals(result.tool_choice, expected);
});

test('tool_choice specific function → { type: tool, name }', async () => {
  const result = await buildWithTestSidecar(
    mkPayload({
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [
        {
          type: 'function',
          function: { name: 'get_weather', parameters: { type: 'object' } },
        },
      ],
      tool_choice: { type: 'function', function: { name: 'get_weather' } },
    }),
  );
  assertEquals(result.tool_choice, { type: 'tool', name: 'get_weather' });
});

test('null tool_choice → not set', async () => {
  const result = await buildWithTestSidecar(
    mkPayload({
      messages: [{ role: 'user', content: 'Hi' }],
      tool_choice: null as unknown as OpenAIChatCompletionsPayload['tool_choice'],
    }),
  );
  assertEquals(result.tool_choice, undefined);
});

// ── Tools mapping ──

test('tools translated correctly', async () => {
  const result = await buildWithTestSidecar(
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
  const result = await buildWithTestSidecar(
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
    (result.tools as AnthropicMessagesClientTool[] | undefined)?.map(tool => tool.strict),
    [true, false],
  );
});

test('tools omit strict when OpenAI Chat Completions omitted strict', async () => {
  const result = await buildWithTestSidecar(
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

  const tool = result.tools?.[0] as AnthropicMessagesClientTool | undefined;
  assertEquals(tool?.strict, undefined);
  assertEquals('strict' in result.tools![0], false);
});

test('empty tools array → not set', async () => {
  const result = await buildWithTestSidecar(
    mkPayload({
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [],
    }),
  );
  assertEquals(result.tools, undefined);
});

// ── Model passthrough ──

test('model name passed through', async () => {
  const result = await buildWithTestSidecar(
    mkPayload({
      model: 'claude-opus-4',
      messages: [{ role: 'user', content: 'Hi' }],
    }),
  );
  assertEquals(result.model, 'claude-opus-4');
});

// ── Complex multi-turn conversations ──

test('full tool use round-trip conversation', async () => {
  const result = await buildWithTestSidecar(
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
  const trBlocks = result.messages[2].content as AnthropicMessagesUserContentBlock[];
  assertEquals(trBlocks[0].type, 'tool_result');
});

// ── Cache breakpoints ──

test('attaches ephemeral cache breakpoints to last function tool and last message block', async () => {
  const result = await buildWithTestSidecar(
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

  const tools = result.tools as AnthropicMessagesClientTool[];
  assertEquals(tools[0].cache_control, undefined);
  assertEquals(tools[1].cache_control, { type: 'ephemeral' });

  const lastMessage = result.messages[result.messages.length - 1];
  const lastBlock = (lastMessage.content as AnthropicMessagesUserContentBlock[]).at(-1) as AnthropicMessagesToolResultBlock;
  assertEquals(lastBlock.type, 'tool_result');
  assertEquals(lastBlock.cache_control, { type: 'ephemeral' });
});

test('attaches ephemeral cache breakpoint to the promoted text block when last message is assistant with string content', async () => {
  // Promotion path: assistant.content === string → wrapped into a single
  // text block carrying the breakpoint. Mirrors the user-string case but
  // exercises the assistant branch of the message-content union.
  const result = await buildWithTestSidecar(
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

test('interleaved tool and text turns preserve chronology', async () => {
  const result = await buildWithTestSidecar(
    mkPayload({
      messages: [
        { role: 'user', content: 'Solve this.' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'tc1',
              type: 'function',
              function: { name: 'calc', arguments: '{"x":1}' },
            },
          ],
        } as OpenAIChatCompletionsAssistantMessageEx,
        { role: 'tool', content: '42', tool_call_id: 'tc1' },
        {
          role: 'assistant',
          content: 'The answer is 42.',
        } as OpenAIChatCompletionsAssistantMessageEx,
      ],
    }),
  );
  assertEquals(result.messages.length, 4);

  const a1 = assistantBlocks(result, 1);
  assertEquals(a1.length, 1);
  assertEquals(a1[0].type, 'tool_use');

  const a2 = assistantBlocks(result, 3);
  assertEquals(a2.length, 1);
  assertEquals(a2[0].type, 'text');
});

test('buildTargetPayload extracts nested response_format json_schema into output_config.format', async () => {
  const schema = { type: 'object', properties: { x: { type: 'string' } }, required: ['x'], additionalProperties: false };
  const result = await buildWithTestSidecar(
    mkPayload({
      messages: [{ role: 'user', content: 'Hi' }],
      response_format: { type: 'json_schema', json_schema: { name: 'whatever', strict: true, schema } },
    }),
  );

  assertEquals(result.output_config, { format: { type: 'json_schema', schema } });
});

test('buildTargetPayload merges reasoning_effort with structured-output format on a single output_config', async () => {
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
  const result = await buildWithTestSidecar(
    mkPayload({
      messages: [{ role: 'user', content: 'Hi' }],
      reasoning_effort: 'high',
      response_format: { type: 'json_schema', json_schema: { name: 'shape', schema } },
    }),
  );

  assertEquals(result.output_config, { effort: 'high', format: { type: 'json_schema', schema } });
});

test('buildTargetPayload forwards empty reasoning_effort verbatim', async () => {
  const result = await buildWithTestSidecar(
    mkPayload({
      messages: [{ role: 'user', content: 'Hi' }],
      reasoning_effort: '',
    }),
  );

  assertEquals(result.output_config, { effort: '' });
});

test('buildTargetPayload drops response_format json_object (no Anthropic equivalent)', async () => {
  const result = await buildWithTestSidecar(
    mkPayload({
      messages: [{ role: 'user', content: 'Hi' }],
      response_format: { type: 'json_object' },
    }),
  );

  assertEquals(result.output_config, undefined);
});

test('buildTargetPayload rejects an unknown message role', async () => {
  await assertRejects(
    () =>
      buildWithTestSidecar({
        model: 'claude-test',
        messages: [{ role: 'critic', content: 'hi' } as unknown as OpenAIChatCompletionsMessage],
      }),
    Error,
    "Invalid role 'critic'",
  );
});

test('buildTargetPayload rejects an unknown user content part type', async () => {
  await assertRejects(
    () =>
      buildWithTestSidecar({
        model: 'claude-test',
        messages: [{ role: 'user', content: [{ type: 'video_url' }] } as unknown as OpenAIChatCompletionsMessage],
      }),
    Error,
    "Invalid 'video_url' content part",
  );
});

// ── service_tier forwarding ──

test('buildTargetPayload forwards a non-accelerated service_tier verbatim', async () => {
  const result = await buildWithTestSidecar(
    mkPayload({
      messages: [{ role: 'user', content: 'hi' }],
      service_tier: 'flex',
    }),
  );

  assertEquals(result.service_tier, 'flex');
});

test('buildTargetPayload maps reasoning_effort none to thinking.disabled', async () => {
  const result = await buildWithTestSidecar(
    mkPayload({
      messages: [{ role: 'user', content: 'Hi' }],
      reasoning_effort: 'none',
    }),
  );

  assertEquals(result.thinking, { type: 'disabled' });
  assertFalse('output_config' in result);
});

test('buildTargetPayload keeps a structured-output format alongside thinking.disabled', async () => {
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
  const result = await buildWithTestSidecar(
    mkPayload({
      messages: [{ role: 'user', content: 'Hi' }],
      reasoning_effort: 'none',
      response_format: { type: 'json_schema', json_schema: { name: 'shape', schema } },
    }),
  );

  assertEquals(result.thinking, { type: 'disabled' });
  assertEquals(result.output_config, { format: { type: 'json_schema', schema } });
});

test('buildTargetPayload leaves thinking absent when reasoning_effort is not none', async () => {
  const result = await buildWithTestSidecar(
    mkPayload({
      messages: [{ role: 'user', content: 'Hi' }],
      reasoning_effort: 'high',
    }),
  );

  assertFalse('thinking' in result);
  assertEquals(result.output_config, { effort: 'high' });
});

test('allowed_tools required selects one Messages tool without changing declarations', async () => {
  const result = await buildWithTestSidecar({
    model: 'claude-test', stream: true, messages: [{ role: 'user', content: 'hello' }], tools: [
      { type: 'function', function: { name: 'allowed' } }, { type: 'function', function: { name: 'excluded' } },
    ], tool_choice: { type: 'allowed_tools', allowed_tools: { mode: 'required', tools: [{ type: 'function', function: { name: 'allowed' } }] } },
  });
  assertEquals(result.tools?.map(tool => 'name' in tool ? tool.name : undefined), ['allowed', 'excluded']);
  assertEquals(result.tool_choice, { type: 'tool', name: 'allowed' });
});

test('translates a PDF data URL into a typed Messages document', async () => {
  const result = await buildWithTestSidecar({
    model: 'model', stream: true, messages: [{
      role: 'user', content: [{
        type: 'file', file: { filename: 'test.pdf', file_data: 'data:application/pdf;base64,JVBERi0xLjQ=' },
      }],
    }],
  });
  assertEquals(userBlocks(result)[0], {
    type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0xLjQ=' },
  });
});

test('translates legacy declarations and forced choice into Messages tooling', async () => {
  const result = await buildWithTestSidecar({
    model: 'model', stream: true, messages: [], functions: [{ name: 'lookup', parameters: { type: 'object', properties: {} } }],
    function_call: { name: 'lookup' },
  });
  assertEquals(result.tools?.map(tool => 'name' in tool ? tool.name : undefined), ['lookup']);
  assertEquals(result.tool_choice, { type: 'tool', name: 'lookup' });
});

test('preserves required tool choice without declarations', async () => {
  const result = await buildWithTestSidecar({ model: 'model', stream: true, messages: [], tool_choice: 'required' });
  assertEquals(result.tool_choice, { type: 'any' });
});

test.each([true, false])('maps parallel_tool_calls %s into Messages tool choice', async parallel => {
  for (const tool_choice of [undefined, 'auto', 'required', 'none'] as const) {
    const result = await buildWithTestSidecar(mkPayload({ messages: [], tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: {} } } }], tool_choice, parallel_tool_calls: parallel }));
    assertEquals(result.tool_choice, tool_choice === 'none' ? { type: 'none' } : { type: tool_choice === 'required' ? 'any' : 'auto', disable_parallel_tool_use: !parallel });
  }
});
