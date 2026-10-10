import { describe, expect, it } from 'vitest';

import { isFirstOutputTokenFrame } from '../../../../src/data-plane/chat/shared/first-output-token.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';

const eventFrame = <T>(event: T): ProtocolFrame<T> => ({ type: 'event', event });

describe('isFirstOutputTokenFrame — messages', () => {
  it('accepts text_delta', () => {
    expect(isFirstOutputTokenFrame(eventFrame({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } }), 'anthropicMessages')).toBe(true);
  });

  it('accepts input_json_delta (tool-call argument delta)', () => {
    expect(isFirstOutputTokenFrame(eventFrame({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{' } }), 'anthropicMessages')).toBe(true);
  });

  it('accepts citations_delta (Anthropic citations / web-search)', () => {
    expect(isFirstOutputTokenFrame(eventFrame({ type: 'content_block_delta', delta: { type: 'citations_delta', citation: {} } }), 'anthropicMessages')).toBe(true);
  });

  it('accepts thinking_delta (extended thinking)', () => {
    expect(isFirstOutputTokenFrame(eventFrame({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '...' } }), 'anthropicMessages')).toBe(true);
  });

  it('rejects message_start / content_block_start (envelope frames)', () => {
    expect(isFirstOutputTokenFrame(eventFrame({ type: 'message_start' }), 'anthropicMessages')).toBe(false);
    expect(isFirstOutputTokenFrame(eventFrame({ type: 'content_block_start', content_block: { type: 'text' } }), 'anthropicMessages')).toBe(false);
  });

  it('rejects empty delta payload (keepalive-style frames)', () => {
    expect(isFirstOutputTokenFrame(eventFrame({ type: 'content_block_delta', delta: { type: 'text_delta', text: '' } }), 'anthropicMessages')).toBe(false);
    expect(isFirstOutputTokenFrame(eventFrame({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '' } }), 'anthropicMessages')).toBe(false);
    expect(isFirstOutputTokenFrame(eventFrame({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '' } }), 'anthropicMessages')).toBe(false);
    expect(isFirstOutputTokenFrame(eventFrame({ type: 'content_block_delta', delta: { type: 'citations_delta' } }), 'anthropicMessages')).toBe(false);
  });
});

describe('isFirstOutputTokenFrame — responses', () => {
  it('accepts response.output_text.delta', () => {
    expect(isFirstOutputTokenFrame(eventFrame({ type: 'response.output_text.delta', delta: 'hi' }), 'openaiResponses')).toBe(true);
  });

  it('accepts response.function_call_arguments.delta', () => {
    expect(isFirstOutputTokenFrame(eventFrame({ type: 'response.function_call_arguments.delta', delta: '{' }), 'openaiResponses')).toBe(true);
  });

  it('accepts response.custom_tool_call_input.delta', () => {
    expect(isFirstOutputTokenFrame(eventFrame({ type: 'response.custom_tool_call_input.delta', delta: 'hi' }), 'openaiResponses')).toBe(true);
  });

  it('accepts response.refusal.delta', () => {
    expect(isFirstOutputTokenFrame(eventFrame({ type: 'response.refusal.delta', delta: 'sorry' }), 'openaiResponses')).toBe(true);
  });

  it('accepts response.reasoning_text.delta and response.reasoning_summary_text.delta', () => {
    expect(isFirstOutputTokenFrame(eventFrame({ type: 'response.reasoning_text.delta', delta: '...' }), 'openaiResponses')).toBe(true);
    expect(isFirstOutputTokenFrame(eventFrame({ type: 'response.reasoning_summary_text.delta', delta: '...' }), 'openaiResponses')).toBe(true);
  });

  it.each(['response.created', 'response.queued', 'response.in_progress', 'response.completed'])('rejects response lifecycle metadata: %s', type => {
    expect(isFirstOutputTokenFrame(eventFrame({ type }), 'openaiResponses')).toBe(false);
  });

  it('rejects known event type with empty delta string', () => {
    expect(isFirstOutputTokenFrame(eventFrame({ type: 'response.output_text.delta', delta: '' }), 'openaiResponses')).toBe(false);
    expect(isFirstOutputTokenFrame(eventFrame({ type: 'response.reasoning_text.delta', delta: '' }), 'openaiResponses')).toBe(false);
  });
});

describe('isFirstOutputTokenFrame — openai-chat-completions', () => {
  it('accepts chunk with delta.content', () => {
    expect(isFirstOutputTokenFrame(eventFrame({ choices: [{ delta: { content: 'hi' } }] }), 'openaiChatCompletions')).toBe(true);
  });

  it('accepts chunk with delta.tool_calls', () => {
    expect(isFirstOutputTokenFrame(eventFrame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{' } }] } }] }), 'openaiChatCompletions')).toBe(true);
  });

  it('accepts reasoning-only chunk (delta.reasoning / delta.reasoning_content / delta.reasoning_text)', () => {
    expect(isFirstOutputTokenFrame(eventFrame({ choices: [{ delta: { reasoning: '...' } }] }), 'openaiChatCompletions')).toBe(true);
    expect(isFirstOutputTokenFrame(eventFrame({ choices: [{ delta: { reasoning_content: '...' } }] }), 'openaiChatCompletions')).toBe(true);
    expect(isFirstOutputTokenFrame(eventFrame({ choices: [{ delta: { reasoning_text: '...' } }] }), 'openaiChatCompletions')).toBe(true);
  });

  it('accepts refusal delta (safety refusals are legitimate generated output)', () => {
    expect(isFirstOutputTokenFrame(eventFrame({ choices: [{ delta: { refusal: "I can't help with that." } }] }), 'openaiChatCompletions')).toBe(true);
  });

  it('rejects role-only chunk', () => {
    expect(isFirstOutputTokenFrame(eventFrame({ choices: [{ delta: { role: 'assistant' } }] }), 'openaiChatCompletions')).toBe(false);
  });

  it('rejects empty-content chunk', () => {
    expect(isFirstOutputTokenFrame(eventFrame({ choices: [{ delta: { content: '' } }] }), 'openaiChatCompletions')).toBe(false);
    expect(isFirstOutputTokenFrame(eventFrame({ choices: [{ delta: { refusal: '' } }] }), 'openaiChatCompletions')).toBe(false);
    expect(isFirstOutputTokenFrame(eventFrame({ choices: [{ delta: {} }] }), 'openaiChatCompletions')).toBe(false);
  });
});

describe('isFirstOutputTokenFrame — done sentinel', () => {
  it('always returns false', () => {
    const done = { type: 'done' as const };
    expect(isFirstOutputTokenFrame(done, 'anthropicMessages')).toBe(false);
    expect(isFirstOutputTokenFrame(done, 'openaiResponses')).toBe(false);
    expect(isFirstOutputTokenFrame(done, 'openaiChatCompletions')).toBe(false);
  });
});

describe('first output across supported stream payloads', () => {
  it.each([
    'response.reasoning.delta',
    'response.reasoning_text.delta',
    'response.reasoning_summary_text.delta',
    'response.output_text.delta',
    'response.refusal.delta',
    'response.function_call_arguments.delta',
    'response.custom_tool_call_input.delta',
    'response.audio.delta',
    'response.audio.transcript.delta',
    'response.code_interpreter_call_code.delta',
    'response.mcp_call_arguments.delta',
    'response.shell_call_command.delta',
    'response.apply_patch_call_operation_diff.delta',
    'response.future_model_output.delta',
  ])('recognizes generated %s content and rejects its empty envelope', type => {
    expect(isFirstOutputTokenFrame(eventFrame({ type, delta: 'output' }), 'openaiResponses')).toBe(true);
    expect(isFirstOutputTokenFrame(eventFrame({ type, delta: '' }), 'openaiResponses')).toBe(false);
  });

  it.each([
    { type: 'reasoning', id: 'rs_1', summary: [] },
    { type: 'message', role: 'assistant', content: [] },
    { type: 'function_call', name: '', arguments: '' },
    { type: 'custom_tool_call', name: '', input: '' },
    { type: 'mcp_call', name: '', arguments: '' },
    { type: 'shell_call', action: { commands: [] } },
    { type: 'future_model_output', id: 'item_1' },
  ])('recognizes any output item at creation: %j', item => {
    expect(isFirstOutputTokenFrame(eventFrame({ type: 'response.output_item.added', item }), 'openaiResponses')).toBe(true);
  });

  it.each([
    { type: 'response.future_model_output.delta', delta: null },
    { type: 'response.future_model_output.delta', delta: {} },
    { type: 'response.future_model_output.done', delta: 'snapshot' },
    { type: 'unrelated.delta', delta: 'text' },
  ])('rejects events outside nonempty Responses string deltas: %j', event => {
    expect(isFirstOutputTokenFrame(eventFrame(event), 'openaiResponses')).toBe(false);
  });

  it('excludes execution output, progress, and completion snapshots', () => {
    for (const event of [
      { type: 'response.shell_call_output_content.delta', delta: { stdout: 'tool output', stderr: '' } },
      { type: 'response.mcp_list_tools.completed', tools: [{ name: 'search' }] },
      { type: 'response.code_interpreter_call.in_progress' },
      { type: 'response.reasoning.done', text: 'complete reasoning' },
    ]) expect(isFirstOutputTokenFrame(eventFrame(event), 'openaiResponses')).toBe(false);
  });

  it.each([
    { function_call: { name: 'search' } },
    { function_call: { arguments: '{' } },
    { tool_calls: [{ index: 0, function: { name: 'search' } }] },
    { tool_calls: [{ index: 0, function: { arguments: '{' } }] },
    { tool_calls: [{ index: 0, custom: { name: 'shell' } }] },
    { tool_calls: [{ index: 0, custom: { input: 'ls' } }] },
    { audio: { data: 'YXVkaW8=' } },
    { audio: { transcript: 'hello' } },
    { reasoning_details: [{ type: 'reasoning.text', text: 'thinking' }] },
    { reasoning_details: [{ type: 'reasoning.summary', summary: 'summary' }] },
    { reasoning_items: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking' }] }] },
  ])('recognizes generated Chat Completions payload %j', delta => {
    expect(isFirstOutputTokenFrame(eventFrame({ choices: [{ delta }] }), 'openaiChatCompletions')).toBe(true);
  });

  it.each([
    { function_call: { name: '', arguments: '' } },
    { tool_calls: [{ index: 0, id: 'call_1', type: 'function' }] },
    { tool_calls: [{ index: 0, function: { name: '', arguments: '' } }] },
    { tool_calls: [{ index: 0, custom: { name: '', input: '' } }] },
    { audio: { id: 'audio_1', expires_at: 10, data: '', transcript: '' } },
    { reasoning_details: [{ type: 'reasoning.text', text: '', signature: 'signature' }] },
    { reasoning_details: [{ type: 'reasoning.summary', summary: '' }] },
    { reasoning_details: [{ type: 'reasoning.encrypted', data: 'opaque' }] },
    { reasoning_items: [{ type: 'reasoning', id: 'rs_1', summary: [] }] },
    { reasoning_items: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: '' }] }] },
    { reasoning_opaque: 'opaque' },
  ])('rejects Chat Completions metadata-only payload %j', delta => {
    expect(isFirstOutputTokenFrame(eventFrame({ choices: [{ delta }] }), 'openaiChatCompletions')).toBe(false);
  });

  it('finds the first generated output across all choices', () => {
    expect(isFirstOutputTokenFrame(eventFrame({
      choices: [
        { index: 0, delta: { role: 'assistant' } },
        { index: 1, delta: { reasoning_content: 'thinking' } },
      ],
    }), 'openaiChatCompletions')).toBe(true);
    expect(isFirstOutputTokenFrame(eventFrame({ choices: [] }), 'openaiChatCompletions')).toBe(false);
  });

  it.each([
    { type: 'tool_use', name: 'search' },
    { type: 'server_tool_use', name: 'web_search' },
    { type: 'text', text: 'hello' },
    { type: 'thinking', thinking: 'thinking' },
  ])('recognizes content already present on an Anthropic block start: %j', content_block => {
    expect(isFirstOutputTokenFrame(eventFrame({ type: 'content_block_start', content_block }), 'anthropicMessages')).toBe(true);
  });

  it('excludes compaction iterations from ordinary output-token timing', () => {
    expect(isFirstOutputTokenFrame(eventFrame({ type: 'content_block_delta', delta: { type: 'compaction_delta', content: 'summary' } }), 'anthropicMessages')).toBe(false);
  });

  it.each([
    { type: 'signature_delta', signature: 'signature' },
    { type: 'compaction_delta', content: '', encrypted_content: 'opaque' },
    { type: 'compaction_delta', content: null, encrypted_content: 'opaque' },
  ])('rejects Anthropic integrity and replay metadata: %j', delta => {
    expect(isFirstOutputTokenFrame(eventFrame({ type: 'content_block_delta', delta }), 'anthropicMessages')).toBe(false);
  });

  it.each([
    { type: 'tool_use', id: 'call_1', name: '', input: {} },
    { type: 'text', text: '' },
    { type: 'thinking', thinking: '', signature: 'signature' },
    { type: 'compaction', content: 'summary' },
    { type: 'compaction', content: '' },
    { type: 'redacted_thinking', data: 'opaque' },
    { type: 'web_search_tool_result', content: [{ title: 'tool output' }] },
  ])('rejects Anthropic empty starts and tool results: %j', content_block => {
    expect(isFirstOutputTokenFrame(eventFrame({ type: 'content_block_start', content_block }), 'anthropicMessages')).toBe(false);
  });
});
