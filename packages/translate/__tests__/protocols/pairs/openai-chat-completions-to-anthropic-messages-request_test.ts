import { test } from 'vitest';

import { buildTargetPayloadFor, pairs } from '../../composition/helpers.ts';
import { createTestSidecarCodec } from '../../round-trip/sidecar-codec.ts';
import {
  type AnthropicMessagesAssistantContentBlock,
  type AnthropicMessagesClientTool,
  type AnthropicMessagesPayload,
  type AnthropicMessagesTextBlock,
  type AnthropicMessagesToolResultBlock,
  type AnthropicMessagesToolUseBlock,
  type AnthropicMessagesUserContentBlock,
} from '@floway-dev/protocols/anthropic-messages';
import type { OpenAIChatCompletionsMessage, OpenAIChatCompletionsPayload, OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';
import { assertEquals, assertExists, assertFalse, assertRejects } from '@floway-dev/test-utils';

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

test.each(['https', 'hTtP'])('preserves a remote image URL with %s scheme', async scheme => {
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

test.each([true, false])('maps parallel_tool_calls %s into Messages tool choice', async parallel => {
  for (const tool_choice of [undefined, 'auto', 'required', 'none'] as const) {
    const result = await buildWithTestSidecar(mkPayload({ messages: [], tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: {} } } }], tool_choice, parallel_tool_calls: parallel }));
    assertEquals(result.tool_choice, tool_choice === 'none' ? { type: 'none' } : { type: tool_choice === 'required' ? 'any' : 'auto', disable_parallel_tool_use: !parallel });
  }
});
