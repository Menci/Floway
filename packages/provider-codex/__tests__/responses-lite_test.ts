import { describe, expect, test } from 'vitest';

import {
  encodeCodexResponsesLiteRequest,
  restoreCodexResponsesCompactionResult,
  restoreCodexResponsesEvent,
  restoreCodexResponsesFrames,
  restoreCodexResponsesResult,
  type CodexResponsesBody,
} from '../src/responses-lite.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type {
  OpenAIResponsesInputAdditionalToolsItem,
  OpenAIResponsesInputItem,
  OpenAIResponsesOutputItem,
  OpenAIResponsesResult,
  OpenAIResponsesStreamEvent,
  OpenAIResponsesTool,
} from '@floway-dev/protocols/openai-responses';

const requestBody = (overrides: Partial<CodexResponsesBody> = {}): CodexResponsesBody => ({
  input: [{ type: 'message', role: 'user', content: 'hello' }],
  ...overrides,
});
const functionTool = (name: string): Extract<OpenAIResponsesTool, { type: 'function' }> => ({
  type: 'function', name, description: `${name} description`, parameters: { type: 'object' },
});
const customTool = (name: string): Extract<OpenAIResponsesTool, { type: 'custom' }> => ({
  type: 'custom', name, description: `${name} description`,
});
const additionalTools = (id: string, tools: OpenAIResponsesTool[]): OpenAIResponsesInputAdditionalToolsItem => ({
  type: 'additional_tools', role: 'developer', id, tools,
});
const itemId = (item: OpenAIResponsesInputItem | undefined): string | null | undefined =>
  item !== undefined && 'id' in item ? item.id : undefined;
const response = (overrides: Partial<OpenAIResponsesResult> = {}): OpenAIResponsesResult => ({
  id: 'resp_1', object: 'response', model: 'model', output: [], status: 'completed', incomplete_details: null, error: null,
  ...overrides,
});

describe('Standard to Responses Lite encoder', () => {
  test('relocates all declarations in order, retains duplicates and leaves the original request intact', () => {
    const duplicate = functionTool('flat_function');
    const body = requestBody({
      instructions: 'Base instructions',
      tools: [
        { type: 'web_search', external_web_access: true },
        duplicate,
        customTool('flat_custom'),
        { type: 'namespace', name: 'functions', description: 'Caller functions', tools: [functionTool('nested_function')] },
        { type: 'namespace', name: 'database', description: 'Database tools', tools: [customTool('query')] },
      ],
      input: [
        additionalTools('at_first', [duplicate]),
        { type: 'message', role: 'user', content: 'hello' },
        additionalTools('at_later', [functionTool('additional_function')]),
      ],
      parallel_tool_calls: true,
      reasoning: { effort: 'high', summary: 'concise' },
    });
    const original = structuredClone(body);
    const encoded = encodeCodexResponsesLiteRequest(body, 'thread').body;
    expect(encoded).not.toHaveProperty('tools');
    expect(encoded).not.toHaveProperty('instructions');
    expect(encoded.parallel_tool_calls).toBe(false);
    expect(encoded.reasoning).toEqual({ effort: 'high', summary: 'concise', context: 'all_turns' });
    expect(encoded.input[0]).toEqual({
      type: 'additional_tools', role: 'developer', id: expect.stringMatching(/^at_[0-9a-f-]{36}$/),
      tools: [
        body.tools![0],
        {
          type: 'namespace', name: 'functions', description: 'Caller functions',
          tools: [duplicate, customTool('flat_custom'), functionTool('nested_function'), duplicate, functionTool('additional_function')],
        },
        body.tools![4],
      ],
    });
    expect(encoded.input[1]).toEqual({
      type: 'message', role: 'developer', id: expect.stringMatching(/^msg_[0-9a-f-]{36}$/),
      content: [{ type: 'input_text', text: 'Base instructions' }],
      internal_chat_message_metadata_passthrough: { content_item_kinds: ['model.base_instructions'] },
    });
    expect(encoded.input.slice(2)).toEqual([body.input[1]]);
    expect(body).toEqual(original);
  });

  test('encodes a leading Standard additional_tools carrier rather than inferring native Lite', () => {
    const body = requestBody({ input: [additionalTools('at_standard', [functionTool('lookup')])] });
    const encoded = encodeCodexResponsesLiteRequest(body, 'thread');
    expect(encoded.body.input).toEqual([{
      type: 'additional_tools', role: 'developer', id: expect.stringMatching(/^at_[0-9a-f-]{36}$/),
      tools: [{ type: 'namespace', name: 'functions', description: '', tools: [functionTool('lookup')] }],
    }]);
    expect(itemId(encoded.body.input[0])).not.toBe('at_standard');
    expect(encoded.callableIdentities.byNamespace.get('functions')?.size).toBe(1);
  });

  test.each([undefined, null, ''])('emits an empty tools carrier without empty instructions %s', instructions => {
    const encoded = encodeCodexResponsesLiteRequest(requestBody({ instructions }), 'thread').body;
    expect(encoded.input).toHaveLength(2);
    expect(encoded.input[0]).toMatchObject({ type: 'additional_tools', tools: [] });
    expect(encoded).not.toHaveProperty('instructions');
  });

  test('generates stable thread-scoped IDs and keeps historical calls unchanged', () => {
    const body = requestBody({ instructions: 'Stable', tools: [functionTool('lookup'), customTool('shell')] });
    const history: OpenAIResponsesInputItem[] = [
      { type: 'function_call', call_id: 'c1', name: 'lookup', arguments: '{}', status: 'completed' },
      { type: 'function_call_output', call_id: 'c1', output: 'done' },
      { type: 'custom_tool_call', call_id: 'c2', name: 'shell', namespace: 'functions', input: 'ls' },
      { type: 'custom_tool_call_output', call_id: 'c2', output: 'done' },
    ];
    const first = encodeCodexResponsesLiteRequest(body, 'thread-a').body.input;
    const retry = encodeCodexResponsesLiteRequest(body, 'thread-a').body.input;
    const nextTurn = encodeCodexResponsesLiteRequest({ ...body, input: [...body.input, ...history] }, 'thread-a').body.input;
    const otherThread = encodeCodexResponsesLiteRequest(body, 'thread-b').body.input;
    expect(retry.slice(0, 2)).toEqual(first.slice(0, 2));
    expect(nextTurn.slice(0, 2)).toEqual(first.slice(0, 2));
    history.forEach((item, index) => expect(nextTurn[index + 3]).toBe(item));
    expect(itemId(otherThread[0])).not.toBe(itemId(first[0]));
    expect(itemId(otherThread[1])).not.toBe(itemId(first[1]));
    const changed = encodeCodexResponsesLiteRequest({ ...body, instructions: 'Changed' }, 'thread-a').body.input;
    expect(itemId(changed[0])).toBe(itemId(first[0]));
    expect(itemId(changed[1])).not.toBe(itemId(first[1]));
  });

  test('only strips image detail on message and callable-output content paths', () => {
    const text = { type: 'input_text' as const, text: 'hello' };
    const image = { type: 'input_image' as const, image_url: 'data:image/png;base64,x', detail: 'high' as const };
    const schemaImage = { type: 'input_image', detail: 'schema-value' };
    const metadataImage = { type: 'input_image', detail: 'metadata-value' };
    const message = {
      type: 'message' as const, role: 'user' as const, content: [text, image],
      internal_chat_message_metadata_passthrough: { image: metadataImage },
    };
    const opaque = { type: 'future_item', image: metadataImage, encrypted_content: 'opaque' } as unknown as OpenAIResponsesInputItem;
    const input: OpenAIResponsesInputItem[] = [
      { type: 'message', role: 'user', content: [text] },
      { type: 'function_call_output', call_id: 'c1', output: [text] },
      { type: 'custom_tool_call_output', call_id: 'c2', output: [{ type: 'input_image', image_url: image.image_url }] },
      message,
      { type: 'function_call_output', call_id: 'c3', output: [image] },
      { type: 'custom_tool_call_output', call_id: 'c4', output: [image] },
      opaque,
    ];
    const encoded = encodeCodexResponsesLiteRequest(requestBody({
      input, tools: [{ ...functionTool('inspect'), parameters: { examples: [schemaImage] } }],
    }), 'thread').body;
    for (let index = 0; index < 3; index++) expect(encoded.input[index + 1]).toBe(input[index]);
    for (let index = 3; index < 6; index++) expect(encoded.input[index + 1]).not.toBe(input[index]);
    expect(encoded.input[4]).toEqual({
      ...message, content: [text, { type: 'input_image', image_url: image.image_url }],
    });
    expect(encoded.input[5]).toMatchObject({ output: [{ type: 'input_image', image_url: image.image_url }] });
    expect(encoded.input[6]).toMatchObject({ output: [{ type: 'input_image', image_url: image.image_url }] });
    expect(encoded.input[7]).toBe(opaque);
    expect(encoded.input[0]).toMatchObject({ tools: [{ tools: [{ parameters: { examples: [schemaImage] } }] }] });
    expect(image.detail).toBe('high');
  });

  test.each([
    'auto', 'required', 'future_choice',
    { type: 'function', name: 'lookup' },
    { type: 'custom', name: 'query', namespace: 'database' },
    { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'function', name: 'lookup' }, { type: 'custom', name: 'query', namespace: 'database' }] },
  ] as CodexResponsesBody['tool_choice'][])('preserves tool_choice without speculative wire rewrites: %j', tool_choice => {
    const body = requestBody({ tool_choice, tools: [functionTool('lookup')] });
    expect(encodeCodexResponsesLiteRequest(body, 'thread').body.tool_choice).toBe(tool_choice);
  });

  test('indexes a long namespace once rather than repeating it in every callable key', () => {
    const namespace = 'n'.repeat(65_536);
    const tools = Array.from({ length: 1_000 }, (_, index) => functionTool(`tool${index}`));
    const encoded = encodeCodexResponsesLiteRequest(requestBody({
      tools: [{ type: 'namespace', name: namespace, description: '', tools }],
    }), 'thread');
    const scopes = encoded.callableIdentities.byNamespace;
    expect([...scopes.keys()]).toEqual([namespace]);
    const names = scopes.get(namespace)!;
    expect([...names.keys()]).toEqual(tools.map(tool => tool.name));
    expect(namespace.length + [...names.keys()].reduce((size, name) => size + name.length, 0)).toBeLessThan(75_000);
    for (const tool of tools) expect(names.get(tool.name)).toEqual({ namespace, name: tool.name, type: 'function_call' });
  });

  test('keeps namespace/name pairs and callable kinds distinct, including implicit namespace aliases', () => {
    const tools: OpenAIResponsesTool[] = [
      { type: 'namespace', name: 'a.b', description: '', tools: [functionTool('c')] },
      { type: 'namespace', name: 'a', description: '', tools: [customTool('b.c')] },
      { type: 'namespace', name: '', description: '', tools: [customTool('implicit')] },
    ];
    const encoded = encodeCodexResponsesLiteRequest(requestBody({ tools }), 'thread');
    expect(encoded.callableIdentities.byNamespace.get('a.b')?.get('c')).toEqual({ namespace: 'a.b', name: 'c', type: 'function_call' });
    expect(encoded.callableIdentities.byNamespace.get('a')?.get('b.c')).toEqual({ namespace: 'a', name: 'b.c', type: 'custom_tool_call' });
    for (const namespace of [undefined, null, '', 'functions']) {
      expect(restoreCodexResponsesResult(response({
        output: [{
          type: 'function_call', id: 'fc_implicit', call_id: 'call_implicit', name: 'implicit', namespace, arguments: 'text', status: 'completed',
        } as OpenAIResponsesOutputItem],
      }), encoded.callableIdentities).output[0]).toMatchObject({ type: 'custom_tool_call', namespace: '', name: 'implicit', input: 'text' });
    }
    for (const namespace of ['', 'functions']) {
      expect(() => encodeCodexResponsesLiteRequest(requestBody({
        tools: [customTool('same'), { type: 'namespace', name: namespace, description: '', tools: [customTool('same')] }],
      }), 'thread')).toThrow('cannot preserve distinct callable identities');
    }
    expect(() => encodeCodexResponsesLiteRequest(requestBody({
      tools: [functionTool('same'), customTool('same')],
    }), 'thread')).toThrow('cannot preserve distinct callable identities');
  });

  test.each(['function', 'custom'] as const)('rejects a flat callable colliding with a namespaced %s', type => {
    const child = type === 'function' ? functionTool('foo') : customTool('foo');
    expect(() => encodeCodexResponsesLiteRequest(requestBody({
      tools: [functionTool('foo'), { type: 'namespace', name: 'functions', description: '', tools: [child] }],
    }), 'thread')).toThrow('Codex Responses Lite cannot preserve distinct callable identities for ["functions","foo"]');
  });
});

describe('Responses Lite search-loaded identities', () => {
  test.each([undefined, 'database'])('inventories search tools in namespace %j without changing their load position', async namespace => {
    const tools: OpenAIResponsesTool[] = namespace === undefined
      ? [customTool('edit')]
      : [{ type: 'namespace', name: namespace, description: 'Loaded tools', tools: [customTool('edit')] }];
    const loaded: OpenAIResponsesInputItem = {
      type: 'tool_search_output', id: 'search_output', call_id: 'search_call', execution: 'client', status: 'completed', tools,
    };
    const body = requestBody({
      tools: [{ type: 'tool_search', execution: 'client' }],
      input: [
        { type: 'message', role: 'user', content: 'Find and run edit.' },
        { type: 'tool_search_call', id: 'search_item', call_id: 'search_call', execution: 'client', arguments: { query: 'edit' }, status: 'completed' },
        loaded,
      ],
    });
    const original = structuredClone(body);
    const encoded = encodeCodexResponsesLiteRequest(body, 'thread');
    expect(encoded.body.input[0]).toMatchObject({ type: 'additional_tools', tools: body.tools });
    expect(encoded.body.input.slice(1)).toEqual(body.input);
    expect(encoded.body.input[3]).toBe(loaded);
    expect(encoded.callableIdentities.byNamespace.get(namespace ?? 'functions')?.get('edit')).toEqual({
      name: 'edit', type: 'custom_tool_call', ...(namespace === undefined ? {} : { namespace }),
    });
    expect(body).toEqual(original);

    // Both backend event families are intentional fixtures, not a claim about
    // which family a live search-loaded custom tool will use.
    for (const functionFamily of [true, false]) {
      const item: OpenAIResponsesOutputItem = functionFamily
        ? { type: 'function_call', id: 'edit_item', call_id: 'edit_call', name: 'edit', namespace: namespace ?? 'functions', arguments: 'patch', status: 'completed' }
        : { type: 'custom_tool_call', id: 'edit_item', call_id: 'edit_call', name: 'edit', ...(namespace === undefined ? {} : { namespace }), input: 'patch' };
      const expected = functionFamily
        ? { type: 'custom_tool_call', id: item.id, call_id: item.call_id, name: 'edit', ...(namespace === undefined ? {} : { namespace }), input: 'patch', status: 'completed' }
        : item;
      const wire = response({ output: [item] });
      const restored = restoreCodexResponsesResult(wire, encoded.callableIdentities);
      expect(restored.output).toEqual([expected]);
      if (!functionFamily) expect(restored.output[0]).toBe(item);
      expect(restoreCodexResponsesCompactionResult({
        id: 'cmp_search', object: 'response.compaction', output: [item],
      }, encoded.callableIdentities, encoded.generatedPrefix).output).toEqual([expected]);
      const events: OpenAIResponsesStreamEvent[] = [
        { type: 'response.output_item.added', output_index: 0, item },
        { type: functionFamily ? 'response.function_call_arguments.delta' : 'response.custom_tool_call_input.delta', item_id: 'edit_item', output_index: 0, delta: 'patch' },
        functionFamily
          ? { type: 'response.function_call_arguments.done', item_id: 'edit_item', output_index: 0, arguments: 'patch' }
          : { type: 'response.custom_tool_call_input.done', item_id: 'edit_item', output_index: 0, input: 'patch' },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: wire },
      ];
      const frames = (async function* (): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEvent>> {
        for (const event of events) yield { type: 'event', event };
      })();
      const output: ProtocolFrame<OpenAIResponsesStreamEvent>[] = [];
      for await (const frame of restoreCodexResponsesFrames(frames, encoded.callableIdentities)) output.push(frame);
      expect(output[0]).toMatchObject({ event: { item: expected } });
      expect(output[1]).toEqual({ type: 'event', event: { ...events[1], type: 'response.custom_tool_call_input.delta' } });
      expect(output[2]).toMatchObject({ event: { type: 'response.custom_tool_call_input.done', input: 'patch' } });
      expect(output[2]).not.toHaveProperty('event.arguments');
      expect(output[3]).toMatchObject({ event: { item: expected } });
      expect(output[4]).toMatchObject({ event: { response: { output: [expected] } } });
      if (!functionFamily) expect(output).toEqual(events.map(event => ({ type: 'event', event })));
    }
  });

  test('keeps search-loaded type/identity collision guards without relocating declarations', () => {
    expect(() => encodeCodexResponsesLiteRequest(requestBody({
      tools: [functionTool('edit')],
      input: [{ type: 'tool_search_output', tools: [customTool('edit')] }],
    }), 'thread')).toThrow('cannot preserve distinct callable identities');
  });
});

describe('Responses Lite compact prefix provenance', () => {
  const compact = (output: readonly OpenAIResponsesInputItem[]) => ({
    id: 'cmp_resource', object: 'response.compaction', output: output as OpenAIResponsesOutputItem[],
  });
  const opaque: OpenAIResponsesInputItem = { type: 'compaction', id: 'cmp_item', encrypted_content: 'opaque+encrypted==' };

  test.each(['top-level', 'input', 'mixed'] as const)('restores only generated %s representations before replay', source => {
    const callerTools = source === 'top-level' ? [] : [additionalTools('at_caller', [customTool('patch')])];
    const callerDeveloper = {
      type: 'message' as const, role: 'developer' as const, id: 'msg_caller', content: [{ type: 'input_text' as const, text: 'Caller history' }],
      internal_chat_message_metadata_passthrough: { content_item_kinds: ['model.base_instructions'] },
    };
    const body = requestBody({
      ...(source === 'input' ? {} : { tools: [functionTool('lookup')] }),
      instructions: 'Old instructions',
      input: [
        ...callerTools, callerDeveloper, { type: 'message', role: 'user', content: 'Continue' },
        { type: 'function_call', id: 'past_call', call_id: 'past', name: 'historical', arguments: '{}', status: 'completed' },
        { type: 'function_call_output', call_id: 'past', output: 'done' },
      ],
    });
    const original = structuredClone(body);
    const encoded = encodeCodexResponsesLiteRequest(body, 'thread');
    // Deliberately echoed prefixes model the supported synthetic compact case.
    const wire = compact(structuredClone([...encoded.body.input, opaque]));
    const restored = restoreCodexResponsesCompactionResult(wire, encoded.callableIdentities, encoded.generatedPrefix);
    expect(restored.output).toEqual([...body.input, opaque]);
    callerTools.forEach((item, index) => expect(restored.output[index]).toBe(item));
    const replay = encodeCodexResponsesLiteRequest({
      ...body, instructions: 'New instructions', input: restored.output as OpenAIResponsesInputItem[],
    }, 'thread');
    expect(replay.body.input[0]).toEqual(encoded.body.input[0]);
    expect(replay.body.input[1]).toMatchObject({ content: [{ type: 'input_text', text: 'New instructions' }] });
    expect(replay.body.input.slice(2)).toEqual([...body.input.filter(item => item.type !== 'additional_tools'), opaque]);
    expect(body).toEqual(original);
    expect(wire.output).toEqual([...encoded.body.input, opaque]);
  });

  test('does not reconstruct source carriers or instructions when no generated prefix is echoed', () => {
    const user: OpenAIResponsesInputItem = { type: 'message', role: 'user', content: 'Retained' };
    const encoded = encodeCodexResponsesLiteRequest(requestBody({
      input: [additionalTools('at_source', [functionTool('lookup')]), user], instructions: 'Base',
    }), 'thread');
    const wire = compact([user, opaque]);
    const restored = restoreCodexResponsesCompactionResult(wire, encoded.callableIdentities, encoded.generatedPrefix);
    expect(restored).toEqual(wire);
    expect(restored.output[0]).toBe(user);
    expect(restored.output[1]).toBe(opaque);
    expect(() => encodeCodexResponsesLiteRequest({
      input: restored.output as OpenAIResponsesInputItem[], tools: [functionTool('lookup')],
    }, 'thread')).not.toThrow();
  });

  test('preserves caller carriers, developer history and modified or opaque lookalikes', () => {
    const encoded = encodeCodexResponsesLiteRequest(requestBody({ tools: [functionTool('lookup')], instructions: 'Base' }), 'thread');
    const generated = encoded.body.input[0] as OpenAIResponsesInputAdditionalToolsItem;
    const base = encoded.body.input[1]!;
    const output: OpenAIResponsesInputItem[] = [
      additionalTools('at_caller', [customTool('caller')]),
      { ...generated, id: 'at_other' },
      { ...generated, tools: [customTool('changed')] },
      { ...generated, extra: 'caller extension' } as OpenAIResponsesInputItem,
      { ...generated, role: 'user' } as unknown as OpenAIResponsesInputItem,
      { ...base, id: 'msg_caller' } as OpenAIResponsesInputItem,
      { ...base, content: [{ type: 'input_text', text: 'Changed' }] } as OpenAIResponsesInputItem,
      { type: 'future_output', id: generated.id, encrypted_content: 'opaque' } as unknown as OpenAIResponsesInputItem,
      opaque,
    ];
    const wire = compact(output);
    const restored = restoreCodexResponsesCompactionResult(wire, encoded.callableIdentities, encoded.generatedPrefix);
    expect(restored).toEqual(wire);
    output.forEach((item, index) => expect(restored.output[index]).toBe(item));
  });

  test('matches generated JSON independent of key order, without removing identical caller history', () => {
    const seed = encodeCodexResponsesLiteRequest(requestBody({ instructions: 'Base' }), 'thread');
    const callerBase = seed.body.input[1]!;
    const encoded = encodeCodexResponsesLiteRequest(requestBody({ instructions: 'Base', input: [callerBase] }), 'thread');
    const reordered = Object.fromEntries(Object.entries(encoded.body.input[1]!).reverse()) as unknown as OpenAIResponsesInputItem;
    const withEcho = restoreCodexResponsesCompactionResult(compact([reordered, callerBase, opaque]), encoded.callableIdentities, encoded.generatedPrefix);
    expect(withEcho.output).toEqual([callerBase, opaque]);
    expect(withEcho.output[0]).toBe(callerBase);
    const withoutEcho = restoreCodexResponsesCompactionResult(compact([callerBase, opaque]), encoded.callableIdentities, encoded.generatedPrefix);
    expect(withoutEcho.output).toEqual([callerBase, opaque]);
    expect(withoutEcho.output[0]).toBe(callerBase);
  });
});

describe('Responses Lite inverse repair', () => {
  test.each(['response.queued', 'response.created', 'response.in_progress', 'response.completed', 'response.incomplete', 'response.failed'] as const)(
    'restores Standard request echoes on %s without changing other fields', type => {
      const body = requestBody({
        tools: [functionTool('lookup')], instructions: 'Base', parallel_tool_calls: true,
        reasoning: { effort: 'future_effort', context: 'current_turn' }, tool_choice: 'auto',
      });
      const encoded = encodeCodexResponsesLiteRequest(body, 'thread');
      const wire = {
        ...response({
          tools: [], instructions: null, parallel_tool_calls: false,
          reasoning: { effort: 'normalized_effort', summary: 'detailed', context: 'all_turns', mode: 'future_mode' }, tool_choice: 'auto',
          service_tier: 'future_tier',
        }),
        future: { untouched: true },
      };
      const restored = restoreCodexResponsesResult(wire, encoded.callableIdentities, encoded.requestEchoes);
      expect(restored).toEqual({ ...wire, ...encoded.requestEchoes });
      expect(restored.tools).toBe(body.tools);
      expect(restored.reasoning).toBe(wire.reasoning);
      expect(restored.parallel_tool_calls).toBe(false);
      expect(restored.tool_choice).toBe('auto');
      expect(restoreCodexResponsesEvent({ type, response: wire }, encoded.callableIdentities, encoded.requestEchoes)).toEqual({ type, response: restored });
      expect(wire.parallel_tool_calls).toBe(false);
    },
  );

  test('removes only encoder-created echoes absent from the Standard request', () => {
    const encoded = encodeCodexResponsesLiteRequest(requestBody(), 'thread');
    const restored = restoreCodexResponsesResult(response({
      instructions: null, tools: [], parallel_tool_calls: false, reasoning: { context: 'all_turns' }, tool_choice: 'auto',
    }), encoded.callableIdentities, encoded.requestEchoes);
    for (const field of ['instructions', 'tools']) expect(restored).not.toHaveProperty(field);
    expect(restored.parallel_tool_calls).toBe(false);
    expect(restored.reasoning).toEqual({ context: 'all_turns' });
    expect(restored.tool_choice).toBe('auto');
  });

  test.each([
    { reasoning: null, parallel_tool_calls: false },
    { reasoning: {}, parallel_tool_calls: true },
    { reasoning: { effort: 'effective', summary: 'future_summary', context: 'future_context', mode: { native: true } }, parallel_tool_calls: false },
    {},
  ])('preserves effective reasoning and parallel settings without request substitution: %j', effective => {
    const encoded = encodeCodexResponsesLiteRequest(requestBody({
      reasoning: { effort: 'requested', context: 'current_turn' }, parallel_tool_calls: true,
    }), 'thread');
    const restored = restoreCodexResponsesResult(response(effective), encoded.callableIdentities, encoded.requestEchoes);
    expect(restored.reasoning).toBe(effective.reasoning);
    expect(restored.parallel_tool_calls).toBe(effective.parallel_tool_calls);
    if (!('reasoning' in effective)) expect(restored).not.toHaveProperty('reasoning');
    if (!('parallel_tool_calls' in effective)) expect(restored).not.toHaveProperty('parallel_tool_calls');
  });

  test.each([undefined, '', 'functions'])('repairs interleaved callable event families with default namespace %j', async namespace => {
    const encoded = encodeCodexResponsesLiteRequest(requestBody({ tools: [functionTool('lookup'), customTool('shell')] }), 'thread');
    const vendor = { encrypted_content: 'opaque+encrypted==', input: 'opaque input', arguments: 'opaque arguments' };
    const wireNamespace = namespace === undefined ? {} : { namespace };
    const lookup = { type: 'custom_tool_call' as const, id: 'item_lookup', call_id: 'call_lookup', ...wireNamespace, name: 'lookup', input: '', vendor };
    const shell = { type: 'function_call' as const, id: 'item_shell', call_id: 'call_shell', ...wireNamespace, name: 'shell', arguments: '', status: 'in_progress' as const, vendor };
    const standardLookup = { type: 'function_call' as const, id: lookup.id, call_id: lookup.call_id, name: lookup.name, arguments: '', status: 'in_progress' as const, vendor };
    const standardShell = { type: 'custom_tool_call' as const, id: shell.id, call_id: shell.call_id, name: shell.name, input: '', status: 'in_progress' as const, vendor };
    const opaque = { type: 'reasoning' as const, id: 'rs_opaque', summary: [], encrypted_content: 'reasoning+opaque==' };
    const unknown = { type: 'response.future', item_id: lookup.id, output_index: 0, input: 'future input', vendor };
    const unknownItemDelta = { type: 'response.function_call_arguments.delta', item_id: 'item_unknown', output_index: 2, delta: 'opaque delta', vendor };
    const output = [{ ...lookup, input: '{}' }, { ...shell, arguments: 'ls', status: 'completed' as const }, opaque];
    const standardOutput = [{ ...standardLookup, arguments: '{}', status: 'completed' as const }, { ...standardShell, input: 'ls', status: 'completed' as const }, opaque];
    const events = [
      { type: 'response.output_item.added', output_index: 0, item: lookup, vendor },
      { type: 'response.output_item.added', output_index: 1, item: shell, vendor },
      { type: 'response.custom_tool_call_input.delta', item_id: lookup.id, output_index: 0, delta: '{}', vendor },
      unknown,
      { type: 'response.function_call_arguments.delta', item_id: shell.id, output_index: 1, delta: 'ls', vendor },
      unknownItemDelta,
      { type: 'response.custom_tool_call_input.done', item_id: lookup.id, output_index: 0, input: '{}', vendor },
      { type: 'response.function_call_arguments.done', item_id: shell.id, output_index: 1, name: 'shell', arguments: 'ls', vendor },
      { type: 'response.output_item.done', output_index: 1, item: output[1], vendor },
      { type: 'response.output_item.done', output_index: 0, item: output[0], vendor },
      { type: 'response.completed', response: response({ output }), vendor },
    ].map((event, sequence_number) => ({ ...event, sequence_number }));
    const expected = [
      { ...events[0], item: standardLookup },
      { ...events[1], item: standardShell },
      { ...events[2], type: 'response.function_call_arguments.delta' },
      events[3],
      { ...events[4], type: 'response.custom_tool_call_input.delta' },
      events[5],
      { type: 'response.function_call_arguments.done', item_id: lookup.id, output_index: 0, name: 'lookup', arguments: '{}', vendor, sequence_number: 6 },
      { type: 'response.custom_tool_call_input.done', item_id: shell.id, output_index: 1, name: 'shell', input: 'ls', vendor, sequence_number: 7 },
      { ...events[8], item: standardOutput[1] },
      { ...events[9], item: standardOutput[0] },
      { ...events[10], response: response({ output: standardOutput }) },
    ];
    const original = structuredClone(events);
    const done = { type: 'done' } as const;
    const frames = (async function* (): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEvent>> {
      for (const event of events) yield { type: 'event', event: event as OpenAIResponsesStreamEvent };
      yield done;
    })();
    const restored: ProtocolFrame<OpenAIResponsesStreamEvent>[] = [];
    for await (const frame of restoreCodexResponsesFrames(frames, encoded.callableIdentities)) restored.push(frame);
    expect(restored).toEqual([...expected.map(event => ({ type: 'event', event })), done]);
    expect(restored.at(-1)).toBe(done);
    expect(events).toEqual(original);
  });

  test.each([undefined, 'incomplete', 'future_status', null])('uses lifecycle defaults only when converted function status is missing: %s', status => {
    const encoded = encodeCodexResponsesLiteRequest(requestBody({ tools: [functionTool('lookup')] }), 'thread');
    const item = {
      type: 'custom_tool_call', id: 'item_lookup', call_id: 'call_lookup', namespace: 'functions', name: 'lookup', input: '{}',
      ...(status === undefined ? {} : { status }),
    } as OpenAIResponsesOutputItem;
    for (const type of ['response.output_item.added', 'response.output_item.done'] as const) {
      expect(restoreCodexResponsesEvent({ type, output_index: 0, item }, encoded.callableIdentities)).toMatchObject({
        item: { type: 'function_call', status: status === undefined ? type === 'response.output_item.added' ? 'in_progress' : 'completed' : status },
      });
    }
    for (const responseStatus of ['queued', 'in_progress', 'completed', 'incomplete', 'failed'] as const) {
      const resource = response({ status: responseStatus, output: [item] });
      const expectedStatus = status === undefined ? responseStatus === 'queued' || responseStatus === 'in_progress' ? 'in_progress' : 'completed' : status;
      expect(restoreCodexResponsesResult(resource, encoded.callableIdentities).output[0]).toMatchObject({ type: 'function_call', status: expectedStatus });
      expect(restoreCodexResponsesEvent({ type: `response.${responseStatus}`, response: resource } as OpenAIResponsesStreamEvent, encoded.callableIdentities)).toMatchObject({
        response: { output: [{ type: 'function_call', status: expectedStatus }] },
      });
    }
    expect(restoreCodexResponsesCompactionResult({ id: 'cmp_1', object: 'response.compaction', output: [item] }, encoded.callableIdentities).output[0]).toMatchObject({
      type: 'function_call', status: status === undefined ? 'completed' : status,
    });
  });

  test.each([undefined, '', 'functions'])('repairs default namespace %j on items, results, compact and frames', async namespace => {
    const encoded = encodeCodexResponsesLiteRequest(requestBody({
      tools: [
        functionTool('lookup'), customTool('shell'),
        { type: 'namespace', name: 'database', description: '', tools: [customTool('query')] },
        { type: 'namespace', name: 'functions', description: '', tools: [functionTool('explicit')] },
      ],
    }), 'thread');
    const wireNamespace = namespace === undefined ? {} : { namespace };
    const wire: OpenAIResponsesOutputItem[] = [
      { type: 'custom_tool_call', id: 'c1', call_id: 'c1', name: 'lookup', ...wireNamespace, input: '{}' },
      { type: 'function_call', id: 'c2', call_id: 'c2', name: 'shell', ...wireNamespace, arguments: 'ls', status: 'completed' },
      { type: 'function_call', id: 'c3', call_id: 'c3', name: 'query', namespace: 'database', arguments: 'select', status: 'completed' },
      { type: 'function_call', id: 'c4', call_id: 'c4', name: 'explicit', ...wireNamespace, arguments: '{}', status: 'completed' },
      { type: 'function_call', id: 'c5', call_id: 'c5', name: 'shell', namespace: 'unknown', arguments: 'opaque', status: 'completed' },
      { type: 'function_call', id: 'c6', call_id: 'c6', name: 'future', ...wireNamespace, arguments: 'opaque', status: 'completed' },
      { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'encrypted+opaque==' },
      { type: 'future_output', encrypted_content: 'future+opaque==', extra: { value: true } } as unknown as OpenAIResponsesOutputItem,
    ];
    const expected = [
      { type: 'function_call', id: 'c1', call_id: 'c1', name: 'lookup', arguments: '{}', status: 'completed' },
      { type: 'custom_tool_call', id: 'c2', call_id: 'c2', name: 'shell', input: 'ls', status: 'completed' },
      { type: 'custom_tool_call', id: 'c3', call_id: 'c3', name: 'query', namespace: 'database', input: 'select', status: 'completed' },
      { type: 'function_call', id: 'c4', call_id: 'c4', name: 'explicit', namespace: 'functions', arguments: '{}', status: 'completed' },
      ...wire.slice(4),
    ];
    for (const type of ['response.output_item.added', 'response.output_item.done'] as const) {
      wire.forEach((item, output_index) => expect(restoreCodexResponsesEvent({ type, output_index, item }, encoded.callableIdentities)).toEqual({
        type, output_index, item: type === 'response.output_item.added' && output_index === 0 ? { ...expected[0], status: 'in_progress' } : expected[output_index],
      }));
    }
    expect(restoreCodexResponsesResult(response({ output: wire }), encoded.callableIdentities).output).toEqual(expected);
    const compact = { id: 'cmp_1', object: 'response.compaction', output: wire, future: 'retained' };
    expect(restoreCodexResponsesCompactionResult(compact, encoded.callableIdentities)).toEqual({ ...compact, output: expected });
    const future = { type: 'response.future', response: { output: wire, tools: ['opaque'] }, extra: 'retained' } as unknown as OpenAIResponsesStreamEvent;
    expect(restoreCodexResponsesEvent(future, encoded.callableIdentities, encoded.requestEchoes)).toBe(future);
    const done = { type: 'done' } as const;
    const frames = (async function* (): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEvent>> {
      yield { type: 'event', event: { type: 'response.output_item.done', output_index: 0, item: wire[0]! } };
      yield { type: 'event', event: future };
      yield done;
    })();
    const restored: ProtocolFrame<OpenAIResponsesStreamEvent>[] = [];
    for await (const frame of restoreCodexResponsesFrames(frames, encoded.callableIdentities, encoded.requestEchoes)) restored.push(frame);
    expect(restored[0]).toMatchObject({ type: 'event', event: { item: expected[0] } });
    expect(restored[1]).toEqual({ type: 'event', event: future });
    expect(restored[2]).toBe(done);
  });
});
