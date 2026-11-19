import { describe, expect, it } from 'vitest';

import { firstOutputTokenSignal } from '../../../../src/data-plane/chat/shared/first-output-token.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';

const eventFrame = <T>(event: T): ProtocolFrame<T> => ({ type: 'event', event });

describe('firstOutputTokenSignal — Anthropic Messages', () => {
  it('accepts non-empty output deltas and rejects envelope frames and empty payloads', () => {
    expect(firstOutputTokenSignal(eventFrame({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } }), 'anthropicMessages')).toEqual({ type: 'decode' });
    expect(firstOutputTokenSignal(eventFrame({ type: 'message_start' }), 'anthropicMessages')).toBeNull();
    expect(firstOutputTokenSignal(eventFrame({ type: 'content_block_delta', delta: { type: 'text_delta', text: '' } }), 'anthropicMessages')).toBeNull();
    expect(firstOutputTokenSignal(eventFrame({ type: 'content_block_delta', delta: { type: 'citations_delta' } }), 'anthropicMessages')).toBeNull();
  });

  it('classifies block starts by their content and the block table', () => {
    const start = (content_block: object) => firstOutputTokenSignal(eventFrame({ type: 'content_block_start', content_block }), 'anthropicMessages');
    expect(start({ type: 'text', text: 'hello' })).toEqual({ type: 'decode' });
    expect(start({ type: 'text', text: '' })).toBeNull();
    expect(start({ type: 'web_search_tool_result', content: [] })).toEqual({ type: 'runtime-output', outputType: 'web_search_tool_result' });
  });

  it('identifies program-authored tool calls as runtime output', () => {
    expect(firstOutputTokenSignal(eventFrame({
      type: 'content_block_start', content_block: {
        type: 'tool_use', name: 'lookup', input: {}, caller: { type: 'code_execution_20250825', tool_id: 'program' },
      },
    }), 'anthropicMessages')).toEqual({ type: 'runtime-output', outputType: 'tool_use' });
  });
});

describe('firstOutputTokenSignal — OpenAI Responses', () => {
  it('recognizes non-empty content deltas and snapshots but not lifecycle events', () => {
    expect(firstOutputTokenSignal(eventFrame({ type: 'response.future_model_output.delta', delta: 'output' }), 'openaiResponses')).toEqual({ type: 'decode' });
    expect(firstOutputTokenSignal(eventFrame({ type: 'response.output_text.delta', delta: '' }), 'openaiResponses')).toBeNull();
    expect(firstOutputTokenSignal(eventFrame({ type: 'response.output_text.done', text: 'hello' }), 'openaiResponses')).toEqual({ type: 'decode' });
    expect(firstOutputTokenSignal(eventFrame({ type: 'response.created' }), 'openaiResponses')).toBeNull();
  });

  // `constructor` guards the item-table lookup against prototype keys.
  it.each(['future_model_output', 'constructor'])('recognizes unknown %s items only on added', type => {
    const item = { type, id: 'item_1' };
    expect(firstOutputTokenSignal(eventFrame({ type: 'response.output_item.added', item }), 'openaiResponses')).toEqual({ type: 'decode' });
    expect(firstOutputTokenSignal(eventFrame({ type: 'response.output_item.done', item }), 'openaiResponses')).toBeNull();
  });

  it('distinguishes program-authored calls from model-authored calls', () => {
    const item = { type: 'function_call', caller: { type: 'program', caller_id: 'pg_1' } };
    expect(firstOutputTokenSignal(eventFrame({ type: 'response.output_item.added', item }), 'openaiResponses')).toEqual({ type: 'runtime-output', outputType: 'function_call' });
    expect(firstOutputTokenSignal(eventFrame({ type: 'response.output_item.added', item: { ...item, caller: { type: 'direct' } } }), 'openaiResponses')).toEqual({ type: 'decode' });
  });

  it('reads first model evidence from a terminal snapshot', () => {
    const type = 'response.completed';
    expect(firstOutputTokenSignal(eventFrame({
      type, response: {
        output: [
          { type: 'mcp_list_tools', tools: [] },
          { type: 'shell_call_output', output: [] },
          { type: 'reasoning', summary: [] },
        ],
      },
    }), 'openaiResponses')).toEqual({ type: 'decode' });
    expect(firstOutputTokenSignal(eventFrame({ type, response: { output: [{ type: 'shell_call_output', output: [] }] } }), 'openaiResponses')).toEqual({ type: 'runtime-output', outputType: 'shell_call_output' });
    expect(firstOutputTokenSignal(eventFrame({ type, response: { output: [{ type: 'mcp_list_tools', tools: [] }, { type: 'future_model_output' }] } }), 'openaiResponses')).toBeNull();
  });
});

describe('firstOutputTokenSignal — OpenAI Chat Completions', () => {
  // One row per helper that decides whether a delta carries generated output.
  it.each([
    { content: 'hi' },
    { tool_calls: [{ index: 0, custom: { input: 'ls' } }] },
    { reasoning_details: [{ type: 'reasoning.summary', summary: 'summary' }] },
    { reasoning_items: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking' }] }] },
  ])('recognizes generated payload %j', delta => {
    expect(firstOutputTokenSignal(eventFrame({ choices: [{ delta }] }), 'openaiChatCompletions')).toEqual({ type: 'decode' });
  });

  it.each([
    { role: 'assistant' },
    { tool_calls: [{ index: 0, id: 'call_1', type: 'function' }] },
    { reasoning_details: [{ type: 'reasoning.encrypted', data: 'opaque' }] },
    { reasoning_items: [{ type: 'reasoning', id: 'rs_1', summary: [] }] },
  ])('rejects metadata-only payload %j', delta => {
    expect(firstOutputTokenSignal(eventFrame({ choices: [{ delta }] }), 'openaiChatCompletions')).toBeNull();
  });

  it('finds the first generated output across all choices', () => {
    expect(firstOutputTokenSignal(eventFrame({
      choices: [
        { index: 0, delta: { role: 'assistant' } },
        { index: 1, delta: { reasoning_content: 'thinking' } },
      ],
    }), 'openaiChatCompletions')).toEqual({ type: 'decode' });
    expect(firstOutputTokenSignal(eventFrame({ choices: [] }), 'openaiChatCompletions')).toBeNull();
  });
});

describe('firstOutputTokenSignal — Gemini generateContent', () => {
  it('starts timing at a content-bearing part and ignores signature-only parts and envelopes', () => {
    expect(firstOutputTokenSignal(eventFrame({
      candidates: [{ index: 0, content: { role: 'model', parts: [{ functionCall: { name: 'lookup' } }] } }],
    }), 'geminiGenerateContent')).toEqual({ type: 'decode' });
    expect(firstOutputTokenSignal(eventFrame({
      candidates: [{ index: 0, content: { role: 'model', parts: [{ thoughtSignature: 'sig' }] } }],
    }), 'geminiGenerateContent')).toBeNull();
    expect(firstOutputTokenSignal(eventFrame({ usageMetadata: { promptTokenCount: 3 } }), 'geminiGenerateContent')).toBeNull();
  });
});
