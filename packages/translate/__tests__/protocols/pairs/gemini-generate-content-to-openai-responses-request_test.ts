import { test } from 'vitest';

import { buildTargetPayloadFor, pairs } from '../../composition/helpers.ts';
import { createTestSidecarCodec } from '../../round-trip/sidecar-codec.ts';
import type { GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';
import { assertEquals, assertFalse } from '@floway-dev/test-utils';

const buildWithTestSidecar = (
  payload: GeminiGenerateContentPayload,
  model: string,
) => buildTargetPayloadFor(pairs.geminiToResponses[0], pairs.geminiToResponses[1], { ...payload, model }, { sidecarCodec: createTestSidecarCodec() });

test('ProtoJSON null configuration members are treated as unset', async () => {
  const absentConfig = await buildWithTestSidecar({ contents: [], generationConfig: null as never }, 'gpt-test');
  assertEquals(absentConfig.reasoning, undefined);

  const nullAllowedNames = await buildWithTestSidecar({
    contents: [], tools: [{ functionDeclarations: [{ name: 'f' }] }],
    toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: null as never } },
  }, 'gpt-test');
  assertEquals(nullAllowedNames.tool_choice, 'required');

  const nullBudget = await buildWithTestSidecar({
    contents: [], generationConfig: { thinkingConfig: { thinkingLevel: 'LOW', thinkingBudget: null as never } },
  }, 'gpt-test');
  assertEquals(nullBudget.reasoning, { effort: 'low' });

  const nullLevel = await buildWithTestSidecar({
    contents: [], generationConfig: { thinkingConfig: { thinkingLevel: null as never, thinkingBudget: 1024 } },
  }, 'gpt-test');
  assertEquals(nullLevel.reasoning, { effort: 'low' });

  const nullScalars = await buildWithTestSidecar({
    contents: [{ role: null as never, parts: [{ text: 'hello' }] }],
    generationConfig: {
      candidateCount: null as never,
      presencePenalty: null as never,
      frequencyPenalty: null as never,
      responseSchema: null as never,
    },
    tools: [{ functionDeclarations: [{ name: 'lookup', parameters: null as never }] }],
  }, 'gpt-test');
  assertEquals(nullScalars.input, [{ type: 'message', role: 'user', content: 'hello' }]);
  assertFalse('presence_penalty' in nullScalars);
  assertFalse('frequency_penalty' in nullScalars);
  assertEquals(nullScalars.text, undefined);
  assertEquals(nullScalars.tools?.[0]?.type === 'function' ? nullScalars.tools[0].parameters : undefined, { type: 'object', properties: {} });
});

test('generated Responses call IDs stay within the wire limit', async () => {
  const name = 'f'.repeat(64);
  const result = await buildWithTestSidecar({
    contents: [
      { role: 'model', parts: [{ functionCall: { name, args: {} } }] },
      { role: 'user', parts: [{ functionResponse: { name, response: { ok: true } } }] },
    ],
  }, 'gpt-test');
  const call = result.input.find(item => item.type === 'function_call');
  const output = result.input.find(item => item.type === 'function_call_output');
  assertEquals(call?.type === 'function_call' ? call.call_id.length : undefined, 64);
  assertEquals(output?.type === 'function_call_output' ? output.call_id : undefined, call?.type === 'function_call' ? call.call_id : undefined);
});

test('buildTargetPayload maps assistant reasoning, function calls, and call-order outputs', async () => {
  const payload: GeminiGenerateContentPayload = {
    contents: [
      {
        role: 'model',
        parts: [
          { text: 'private trace', thought: true, thoughtSignature: 'sig_1' },
          { thoughtSignature: 'sig_only' },
          { text: 'Visible answer.' },
          { functionCall: { name: 'lookup', args: { query: 'first' } } },
          {
            functionCall: {
              id: 'call_explicit',
              name: 'lookup',
              args: { query: 'second' },
            },
          },
        ],
      },
      {
        role: 'user',
        parts: [
          { functionResponse: { name: 'lookup', response: { answer: 'first' } } },
          {
            functionResponse: {
              id: 'call_explicit',
              name: 'lookup',
              response: { answer: 'second' },
            },
          },
        ],
      },
    ],
  };

  assertEquals((await buildWithTestSidecar(payload, 'gpt-test')).input, [
    {
      type: 'reasoning',
      id: 'gemini_reasoning_0_0',
      summary: [{ type: 'summary_text', text: 'private trace' }],
    },
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Visible answer.' }],
    },
    {
      type: 'function_call',
      call_id: 'lookup_call_1',
      name: 'lookup',
      arguments: '{"query":"first"}',
      status: 'completed',
    },
    {
      type: 'function_call',
      call_id: 'call_explicit',
      name: 'lookup',
      arguments: '{"query":"second"}',
      status: 'completed',
    },
    {
      type: 'function_call_output',
      call_id: 'lookup_call_1',
      output: '{"answer":"first"}',
      status: 'completed',
    },
    {
      type: 'function_call_output',
      call_id: 'call_explicit',
      output: '{"answer":"second"}',
      status: 'completed',
    },
  ]);
});

test('buildTargetPayload maps generation config, JSON schema, and reasoning controls', async () => {
  const schema = {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
  };
  const payload: GeminiGenerateContentPayload = {
    contents: [],
    generationConfig: {
      maxOutputTokens: 512,
      temperature: 0.25,
      topP: 0.8,
      responseMimeType: 'application/json',
      responseSchema: schema,
      thinkingConfig: { thinkingLevel: 'medium', includeThoughts: true },
    },
  };

  assertEquals(await buildWithTestSidecar(payload, 'gpt-test'), {
    model: 'gpt-test',
    stream: true,
    input: [],
    max_output_tokens: 512,
    temperature: 0.25,
    top_p: 0.8,
    text: {
      format: {
        type: 'json_schema',
        name: 'gemini_response', schema,
      },
    },
    reasoning: { effort: 'medium' },
  });

  assertEquals((await buildWithTestSidecar({ contents: [], generationConfig: { responseMimeType: 'application/json' } }, 'gpt-test')).text, { format: { type: 'json_object' } });
});
