import { describe, expect, it } from 'vitest';

import { firstOutputTokenSignal } from '../../../../src/data-plane/chat/shared/first-output-token.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';

const eventFrame = <T>(event: T): ProtocolFrame<T> => ({ type: 'event', event });

it('never starts timing on the done sentinel', () => {
  expect(firstOutputTokenSignal({ type: 'done' }, 'openaiChatCompletions')).toBeNull();
});

describe('firstOutputTokenSignal — Anthropic Messages', () => {
  it('accepts text_delta', () => {
    expect(firstOutputTokenSignal(eventFrame({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } }), 'anthropicMessages')).toEqual({ type: 'decode' });
  });

  it('rejects envelope frames and empty delta payloads (keepalive-style frames)', () => {
    expect(firstOutputTokenSignal(eventFrame({ type: 'message_start' }), 'anthropicMessages')).toBeNull();
    expect(firstOutputTokenSignal(eventFrame({ type: 'content_block_delta', delta: { type: 'text_delta', text: '' } }), 'anthropicMessages')).toBeNull();
    expect(firstOutputTokenSignal(eventFrame({ type: 'content_block_delta', delta: { type: 'citations_delta' } }), 'anthropicMessages')).toBeNull();
  });

  it.each([
    { type: 'text', text: 'hello' },
    { type: 'thinking', thinking: '', signature: '' },
  ])('recognizes content already present on a block start: %j', content_block => {
    expect(firstOutputTokenSignal(eventFrame({ type: 'content_block_start', content_block }), 'anthropicMessages')).toEqual({ type: 'decode' });
  });

  it.each([
    { type: 'tool_use', id: 'call_1', name: '', input: {} },
    { type: 'text', text: '' },
    { type: 'compaction', content: 'summary' },
  ])('rejects empty text/tool starts and compaction: %j', content_block => {
    expect(firstOutputTokenSignal(eventFrame({ type: 'content_block_start', content_block }), 'anthropicMessages')).toBeNull();
  });

  it('rejects signature deltas as integrity metadata', () => {
    expect(firstOutputTokenSignal(eventFrame({ type: 'content_block_delta', delta: { type: 'signature_delta', signature: 'signature' } }), 'anthropicMessages')).toBeNull();
  });

  it('identifies server tool results as runtime output', () => {
    expect(firstOutputTokenSignal(eventFrame({ type: 'content_block_start', content_block: { type: 'web_search_tool_result', content: [] } }), 'anthropicMessages'))
      .toEqual({ type: 'runtime-output', outputType: 'web_search_tool_result' });
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
  it.each(['response.output_text.delta', 'response.future_model_output.delta'])('recognizes generated %s content and rejects its empty envelope', type => {
    expect(firstOutputTokenSignal(eventFrame({ type, delta: 'output' }), 'openaiResponses')).toEqual({ type: 'decode' });
    expect(firstOutputTokenSignal(eventFrame({ type, delta: '' }), 'openaiResponses')).toBeNull();
  });

  it.each([
    { type: 'response.created' },
    { type: 'response.completed' },
    { type: 'response.future_model_output.done', delta: 'snapshot' },
    { type: 'unrelated.delta', delta: 'text' },
  ])('rejects lifecycle metadata and events outside Responses string deltas: %j', event => {
    expect(firstOutputTokenSignal(eventFrame(event), 'openaiResponses')).toBeNull();
  });

  // `constructor` guards the item-table lookup against prototype keys.
  it.each(['future_model_output', 'constructor'])('recognizes unknown %s items only on added', type => {
    const item = { type, id: 'item_1' };
    expect(firstOutputTokenSignal(eventFrame({ type: 'response.output_item.added', item }), 'openaiResponses')).toEqual({ type: 'decode' });
    expect(firstOutputTokenSignal(eventFrame({ type: 'response.output_item.done', item }), 'openaiResponses')).toBeNull();
  });

  describe.each(['response.output_item.added', 'response.output_item.done'])('item timing signals on %s', type => {
    it('identifies hosted runtime results', () => {
      expect(firstOutputTokenSignal(eventFrame({ type, item: { type: 'shell_call_output', output: [{ stdout: 'tool output' }] } }), 'openaiResponses'))
        .toEqual({ type: 'runtime-output', outputType: 'shell_call_output' });
    });

    it.each([
      { type: 'message', content: [] },
      { type: 'reasoning', summary: [], encrypted_content: 'private reasoning' },
    ])('counts model-output item %j before its payload is streamed', item => {
      expect(firstOutputTokenSignal(eventFrame({ type, item }), 'openaiResponses')).toEqual({ type: 'decode' });
    });

    it.each([
      { type: 'function_call_output', output: 'tool output' },
      { type: 'mcp_list_tools', tools: [{ name: 'search' }] },
      { type: 'compaction', encrypted_content: 'opaque' },
    ])('ignores input, discovery, and compaction items: %j', item => {
      expect(firstOutputTokenSignal(eventFrame({ type, item }), 'openaiResponses')).toBeNull();
    });

    it('ignores a valid nullable item', () => {
      expect(firstOutputTokenSignal(eventFrame({ type, item: null, output_index: 0 }), 'openaiResponses')).toBeNull();
    });
  });

  it.each([
    { type: 'response.content_part.done', part: { type: 'refusal', refusal: 'declined' } },
    { type: 'response.output_text.done', text: 'hello' },
    { type: 'response.refusal.done', refusal: 'declined' },
    { type: 'response.function_call_arguments.done', arguments: '{}' },
    { type: 'response.custom_tool_call_input.done', input: 'ls' },
    { type: 'response.code_interpreter_call_code.done', code: 'print(1)' },
    { type: 'response.shell_call_command.added', command: 'ls' },
    { type: 'response.apply_patch_call_operation_diff.done', diff: 'content' },
  ])('recognizes known content arriving on %j', event => {
    expect(firstOutputTokenSignal(eventFrame(event), 'openaiResponses')).toEqual({ type: 'decode' });
  });

  it('excludes progress and empty content snapshots', () => {
    for (const event of [
      { type: 'response.code_interpreter_call.in_progress' },
      { type: 'response.reasoning.done', text: '' },
      { type: 'response.content_part.added', part: { type: 'output_text', text: '' } },
    ]) expect(firstOutputTokenSignal(eventFrame(event), 'openaiResponses')).toBeNull();
  });

  it('recognizes shell runtime output outside item lifecycle and ignores empty shell deltas', () => {
    expect(firstOutputTokenSignal(eventFrame({ type: 'response.shell_call_output_content.delta', delta: { stdout: '', stderr: 'error' } }), 'openaiResponses'))
      .toEqual({ type: 'runtime-output', outputType: 'shell_call_output' });
    expect(firstOutputTokenSignal(eventFrame({ type: 'response.shell_call_output_content.delta', delta: { stdout: '', stderr: '' } }), 'openaiResponses')).toBeNull();
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
  it.each([
    { content: 'hi' },
    { refusal: "I can't help with that." },
    { reasoning_content: '...' },
    { function_call: { name: 'search' } },
    { tool_calls: [{ index: 0, custom: { input: 'ls' } }] },
    { audio: { transcript: 'hello' } },
    { reasoning_details: [{ type: 'reasoning.summary', summary: 'summary' }] },
    { reasoning_items: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking' }] }] },
  ])('recognizes generated payload %j', delta => {
    expect(firstOutputTokenSignal(eventFrame({ choices: [{ delta }] }), 'openaiChatCompletions')).toEqual({ type: 'decode' });
  });

  it.each([
    { role: 'assistant' },
    { content: '' },
    { tool_calls: [{ index: 0, id: 'call_1', type: 'function' }] },
    { audio: { id: 'audio_1', expires_at: 10, data: '', transcript: '' } },
    { reasoning_details: [{ type: 'reasoning.encrypted', data: 'opaque' }] },
    { reasoning_items: [{ type: 'reasoning', id: 'rs_1', summary: [] }] },
    { reasoning_opaque: 'opaque' },
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
  it('starts timing at the first content-bearing part, including a function call name', () => {
    expect(firstOutputTokenSignal(eventFrame({
      candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'Hello' }] } }],
    }), 'geminiGenerateContent')).toEqual({ type: 'decode' });
    expect(firstOutputTokenSignal(eventFrame({
      candidates: [{ index: 0, content: { role: 'model', parts: [{ functionCall: { name: 'lookup' } }] } }],
    }), 'geminiGenerateContent')).toEqual({ type: 'decode' });
  });

  it('ignores signature-only parts and pure envelopes', () => {
    expect(firstOutputTokenSignal(eventFrame({
      candidates: [{ index: 0, content: { role: 'model', parts: [{ thoughtSignature: 'sig' }] } }],
    }), 'geminiGenerateContent')).toBeNull();
    expect(firstOutputTokenSignal(eventFrame({ usageMetadata: { promptTokenCount: 3 } }), 'geminiGenerateContent')).toBeNull();
  });
});
