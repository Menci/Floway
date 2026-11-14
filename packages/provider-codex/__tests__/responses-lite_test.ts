import { describe, expect, test } from 'vitest';

import { encodeCodexResponsesLiteRequest, type CodexResponsesBody } from '../src/responses-lite.ts';
import type { OpenAIResponsesInputAdditionalToolsItem, CanonicalOpenAIResponsesInputItem, OpenAIResponsesTool } from '@floway-dev/protocols/openai-responses';

const requestBody = (overrides: Partial<CodexResponsesBody> = {}): CodexResponsesBody => ({
  input: [{ type: 'message', role: 'user', content: 'hello' }],
  ...overrides,
});
const functionTool = (name: string): Extract<OpenAIResponsesTool, { type: 'function' }> => ({
  type: 'function', name, parameters: { type: 'object' },
});
const customTool = (name: string): Extract<OpenAIResponsesTool, { type: 'custom' }> => ({ type: 'custom', name });
const additionalTools = (id: string, tools: OpenAIResponsesTool[]): OpenAIResponsesInputAdditionalToolsItem => ({
  type: 'additional_tools', role: 'developer', id, tools,
});
const itemId = (item: CanonicalOpenAIResponsesInputItem | undefined): string | null | undefined =>
  item !== undefined && 'id' in item ? item.id : undefined;

describe('Codex Responses Lite request encoding', () => {
  test('encodes only top-level tools and instructions into a new prefix', () => {
    const originalCarrier = additionalTools('at_caller', [customTool('later')]);
    const body = requestBody({
      tools: [functionTool('read'), customTool('shell'), { type: 'namespace', name: 'database', description: 'Database tools', tools: [customTool('query')] }],
      instructions: 'Base instructions',
      input: [
        { type: 'message', role: 'user', content: 'Read a file.' },
        originalCarrier,
        { type: 'message', role: 'user', content: 'Now use the later tool.' },
      ],
      parallel_tool_calls: true,
      reasoning: { effort: 'high' },
    });
    const original = structuredClone(body);
    const encoded = encodeCodexResponsesLiteRequest(body, 'thread');

    expect(encoded.body).not.toHaveProperty('tools');
    expect(encoded.body).not.toHaveProperty('instructions');
    expect(encoded.body.input[0]).toMatchObject({
      type: 'additional_tools', role: 'developer', id: expect.stringMatching(/^at_[0-9a-f-]{36}$/),
      tools: [
        { type: 'namespace', name: 'functions', description: '', tools: [functionTool('read'), customTool('shell')] },
        body.tools![2],
      ],
    });
    expect(encoded.body.input[1]).toMatchObject({
      type: 'message', role: 'developer', id: expect.stringMatching(/^msg_[0-9a-f-]{36}$/),
      content: [{ type: 'input_text', text: 'Base instructions' }],
      internal_chat_message_metadata_passthrough: { content_item_kinds: ['model.base_instructions'] },
    });
    expect(encoded.body.input.slice(2)).toEqual(body.input);
    expect(encoded.body.input[3]).toBe(originalCarrier);
    expect(encoded.body.parallel_tool_calls).toBe(false);
    expect(encoded.body.reasoning).toEqual({ effort: 'high', context: 'all_turns' });
    expect(encoded.movedFields).toEqual({ tools: body.tools, instructions: body.instructions });
    expect(body).toEqual(original);
  });

  test('forwards an existing Lite prefix and later additional_tools with their identities', () => {
    const initial = additionalTools('at_initial', [{ type: 'namespace', name: 'functions', description: '', tools: [functionTool('read')] }]);
    const base = {
      type: 'message' as const, role: 'developer' as const, id: 'msg_base',
      content: [{ type: 'input_text' as const, text: 'Caller base instructions' }],
      internal_chat_message_metadata_passthrough: { content_item_kinds: ['model.base_instructions'] },
    };
    const later = additionalTools('at_later', [customTool('write')]);
    const body = requestBody({
      instructions: '',
      input: [initial, base, { type: 'message', role: 'user', content: 'First turn' }, later, { type: 'message', role: 'user', content: 'Second turn' }],
    });
    const encoded = encodeCodexResponsesLiteRequest(body, 'thread');

    expect(encoded.body.input).toEqual(body.input);
    expect(encoded.body.input[0]).toBe(initial);
    expect(encoded.body.input[1]).toBe(base);
    expect(encoded.body.input[3]).toBe(later);
    expect(encoded.body).not.toHaveProperty('instructions');
    expect(encoded.movedFields).toEqual({});
  });

  test('emits an empty tools carrier only when the request has no positional carrier', () => {
    const empty = encodeCodexResponsesLiteRequest(requestBody({ instructions: '' }), 'thread');
    expect(empty.body.input[0]).toMatchObject({ type: 'additional_tools', tools: [] });
    expect(empty.body).not.toHaveProperty('instructions');

    const carrier = additionalTools('at_existing', []);
    const existing = encodeCodexResponsesLiteRequest(requestBody({ input: [carrier] }), 'thread');
    expect(existing.body.input).toEqual([carrier]);
  });

  test('keeps generated IDs stable for one thread and isolates changed instructions', () => {
    const body = requestBody({ tools: [functionTool('read')], instructions: 'First rules' });
    const first = encodeCodexResponsesLiteRequest(body, 'thread-a');
    const retry = encodeCodexResponsesLiteRequest(body, 'thread-a');
    const changed = encodeCodexResponsesLiteRequest({ ...body, instructions: 'Changed rules' }, 'thread-a');
    const otherThread = encodeCodexResponsesLiteRequest(body, 'thread-b');

    expect(retry.body.input.slice(0, 2)).toEqual(first.body.input.slice(0, 2));
    expect(itemId(changed.body.input[0])).toBe(itemId(first.body.input[0]));
    expect(itemId(changed.body.input[1])).not.toBe(itemId(first.body.input[1]));
    expect(itemId(otherThread.body.input[0])).not.toBe(itemId(first.body.input[0]));
  });

  test('strips image detail only from message and callable-output content', () => {
    const image = { type: 'input_image' as const, image_url: 'data:image/png;base64,x', detail: 'high' as const };
    const schemaImage = { type: 'input_image', detail: 'schema-value' };
    const metadataImage = { type: 'input_image', detail: 'metadata-value' };
    const message = {
      type: 'message' as const, role: 'user' as const, content: [image],
      internal_chat_message_metadata_passthrough: { image: metadataImage },
    };
    const encoded = encodeCodexResponsesLiteRequest(requestBody({
      input: [message, { type: 'function_call_output', call_id: 'c1', output: [image] }],
      tools: [{ ...functionTool('inspect'), parameters: { examples: [schemaImage] } }],
    }), 'thread');

    expect(encoded.body.input[1]).toEqual({ ...message, content: [{ type: 'input_image', image_url: image.image_url }] });
    expect(encoded.body.input[2]).toMatchObject({ output: [{ type: 'input_image', image_url: image.image_url }] });
    expect(encoded.body.input[0]).toMatchObject({ tools: [{ tools: [{ parameters: { examples: [schemaImage] } }] }] });
    expect(image.detail).toBe('high');
  });

  test('preserves tool_choice and future request fields', () => {
    const tool_choice: CodexResponsesBody['tool_choice'] = { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'function', name: 'read' }] };
    const body = { ...requestBody({ tools: [functionTool('read')], tool_choice }), future_field: { value: 1 } };
    const encoded = encodeCodexResponsesLiteRequest(body, 'thread');
    expect(encoded.body.tool_choice).toBe(tool_choice);
    expect((encoded.body as unknown as Record<string, unknown>).future_field).toEqual({ value: 1 });
  });
});
