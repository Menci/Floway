import { describe, expect, it } from 'vitest';

import { firstOutputTokenSignal } from '../../../../src/data-plane/chat/shared/first-output-token.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';

const eventFrame = <T>(event: T): ProtocolFrame<T> => ({ type: 'event', event });

describe('firstOutputTokenSignal — messages', () => {
  it('accepts text_delta', () => {
    expect(firstOutputTokenSignal(eventFrame({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } }), 'anthropicMessages')).toEqual({ type: 'decode' });
  });

  it('accepts input_json_delta (tool-call argument delta)', () => {
    expect(firstOutputTokenSignal(eventFrame({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{' } }), 'anthropicMessages')).toEqual({ type: 'decode' });
  });

  it('accepts citations_delta (Anthropic citations / web-search)', () => {
    expect(firstOutputTokenSignal(eventFrame({ type: 'content_block_delta', delta: { type: 'citations_delta', citation: {} } }), 'anthropicMessages')).toEqual({ type: 'decode' });
  });

  it('accepts thinking_delta (extended thinking)', () => {
    expect(firstOutputTokenSignal(eventFrame({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '...' } }), 'anthropicMessages')).toEqual({ type: 'decode' });
  });

  it('rejects message_start / content_block_start (envelope frames)', () => {
    expect(firstOutputTokenSignal(eventFrame({ type: 'message_start' }), 'anthropicMessages')).toBeNull();
    expect(firstOutputTokenSignal(eventFrame({ type: 'content_block_start', content_block: { type: 'text' } }), 'anthropicMessages')).toBeNull();
  });

  it('rejects empty delta payload (keepalive-style frames)', () => {
    expect(firstOutputTokenSignal(eventFrame({ type: 'content_block_delta', delta: { type: 'text_delta', text: '' } }), 'anthropicMessages')).toBeNull();
    expect(firstOutputTokenSignal(eventFrame({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '' } }), 'anthropicMessages')).toBeNull();
    expect(firstOutputTokenSignal(eventFrame({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '' } }), 'anthropicMessages')).toBeNull();
    expect(firstOutputTokenSignal(eventFrame({ type: 'content_block_delta', delta: { type: 'citations_delta' } }), 'anthropicMessages')).toBeNull();
  });
});

describe('firstOutputTokenSignal — responses', () => {
  it('accepts response.output_text.delta', () => {
    expect(firstOutputTokenSignal(eventFrame({ type: 'response.output_text.delta', delta: 'hi' }), 'openaiResponses')).toEqual({ type: 'decode' });
  });

  it('accepts response.function_call_arguments.delta', () => {
    expect(firstOutputTokenSignal(eventFrame({ type: 'response.function_call_arguments.delta', delta: '{' }), 'openaiResponses')).toEqual({ type: 'decode' });
  });

  it('accepts response.custom_tool_call_input.delta', () => {
    expect(firstOutputTokenSignal(eventFrame({ type: 'response.custom_tool_call_input.delta', delta: 'hi' }), 'openaiResponses')).toEqual({ type: 'decode' });
  });

  it('accepts response.refusal.delta', () => {
    expect(firstOutputTokenSignal(eventFrame({ type: 'response.refusal.delta', delta: 'sorry' }), 'openaiResponses')).toEqual({ type: 'decode' });
  });

  it('accepts response.reasoning_text.delta and response.reasoning_summary_text.delta', () => {
    expect(firstOutputTokenSignal(eventFrame({ type: 'response.reasoning_text.delta', delta: '...' }), 'openaiResponses')).toEqual({ type: 'decode' });
    expect(firstOutputTokenSignal(eventFrame({ type: 'response.reasoning_summary_text.delta', delta: '...' }), 'openaiResponses')).toEqual({ type: 'decode' });
  });

  it.each(['response.created', 'response.queued', 'response.in_progress', 'response.completed'])('rejects response lifecycle metadata: %s', type => {
    expect(firstOutputTokenSignal(eventFrame({ type }), 'openaiResponses')).toBeNull();
  });

  it('rejects known event type with empty delta string', () => {
    expect(firstOutputTokenSignal(eventFrame({ type: 'response.output_text.delta', delta: '' }), 'openaiResponses')).toBeNull();
    expect(firstOutputTokenSignal(eventFrame({ type: 'response.reasoning_text.delta', delta: '' }), 'openaiResponses')).toBeNull();
  });
});

describe('firstOutputTokenSignal — openai-chat-completions', () => {
  it('accepts chunk with delta.content', () => {
    expect(firstOutputTokenSignal(eventFrame({ choices: [{ delta: { content: 'hi' } }] }), 'openaiChatCompletions')).toEqual({ type: 'decode' });
  });

  it('accepts chunk with delta.tool_calls', () => {
    expect(firstOutputTokenSignal(eventFrame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{' } }] } }] }), 'openaiChatCompletions')).toEqual({ type: 'decode' });
  });

  it('accepts reasoning-only chunk (delta.reasoning / delta.reasoning_content / delta.reasoning_text)', () => {
    expect(firstOutputTokenSignal(eventFrame({ choices: [{ delta: { reasoning: '...' } }] }), 'openaiChatCompletions')).toEqual({ type: 'decode' });
    expect(firstOutputTokenSignal(eventFrame({ choices: [{ delta: { reasoning_content: '...' } }] }), 'openaiChatCompletions')).toEqual({ type: 'decode' });
    expect(firstOutputTokenSignal(eventFrame({ choices: [{ delta: { reasoning_text: '...' } }] }), 'openaiChatCompletions')).toEqual({ type: 'decode' });
  });

  it('accepts refusal delta (safety refusals are legitimate generated output)', () => {
    expect(firstOutputTokenSignal(eventFrame({ choices: [{ delta: { refusal: "I can't help with that." } }] }), 'openaiChatCompletions')).toEqual({ type: 'decode' });
  });

  it('rejects role-only chunk', () => {
    expect(firstOutputTokenSignal(eventFrame({ choices: [{ delta: { role: 'assistant' } }] }), 'openaiChatCompletions')).toBeNull();
  });

  it('rejects empty-content chunk', () => {
    expect(firstOutputTokenSignal(eventFrame({ choices: [{ delta: { content: '' } }] }), 'openaiChatCompletions')).toBeNull();
    expect(firstOutputTokenSignal(eventFrame({ choices: [{ delta: { refusal: '' } }] }), 'openaiChatCompletions')).toBeNull();
    expect(firstOutputTokenSignal(eventFrame({ choices: [{ delta: {} }] }), 'openaiChatCompletions')).toBeNull();
  });
});

describe('firstOutputTokenSignal — done sentinel', () => {
  it('always returns null', () => {
    const done = { type: 'done' as const };
    expect(firstOutputTokenSignal(done, 'anthropicMessages')).toBeNull();
    expect(firstOutputTokenSignal(done, 'openaiResponses')).toBeNull();
    expect(firstOutputTokenSignal(done, 'openaiChatCompletions')).toBeNull();
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
    expect(firstOutputTokenSignal(eventFrame({ type, delta: 'output' }), 'openaiResponses')).toEqual({ type: 'decode' });
    expect(firstOutputTokenSignal(eventFrame({ type, delta: '' }), 'openaiResponses')).toBeNull();
  });

  it.each(['future_model_output', 'constructor'])('recognizes unknown %s items only on added', type => {
    const item = { type, id: 'item_1' };
    expect(firstOutputTokenSignal(eventFrame({ type: 'response.output_item.added', item }), 'openaiResponses')).toEqual({ type: 'decode' });
    expect(firstOutputTokenSignal(eventFrame({ type: 'response.output_item.done', item }), 'openaiResponses')).toBeNull();
  });

  describe.each(['response.output_item.added', 'response.output_item.done'])('item timing signals on %s', type => {
    it.each([
      { type: 'tool_search_output', tools: [{ name: 'search' }] },
      { type: 'program_output', result: 'tool output' },
      { type: 'multi_agent_call_output', output: [{ type: 'output_text', text: 'tool output' }] },
      { type: 'shell_call_output', output: [{ stdout: 'tool output' }] },
    ])('identifies runtime results that require a warning if they start timing: %j', item => {
      expect(firstOutputTokenSignal(eventFrame({ type, item }), 'openaiResponses')).toEqual({ type: 'runtime-result', itemType: item.type });
    });

    it.each([
      { type: 'message', content: [] },
      { type: 'reasoning', summary: [] },
      { type: 'reasoning', summary: [], encrypted_content: 'private reasoning' },
      { type: 'function_call', name: '', arguments: '' },
      { type: 'custom_tool_call', name: '', input: '' },
      { type: 'mcp_call', name: '', arguments: '' },
      { type: 'mcp_approval_request', name: '', arguments: '' },
      { type: 'web_search_call', action: null },
      { type: 'file_search_call', queries: [] },
      { type: 'computer_call', actions: [] },
      { type: 'tool_search_call', arguments: {} },
      { type: 'program', code: '' },
      { type: 'agent_message', content: [] },
      { type: 'multi_agent_call', action: 'list_agents', arguments: '' },
      { type: 'code_interpreter_call', code: null },
      { type: 'local_shell_call', action: { command: [] } },
      { type: 'shell_call', action: { commands: [] } },
      { type: 'apply_patch_call', operation: { type: 'create_file', path: '', diff: '' } },
      { type: 'image_generation_call', status: 'in_progress' },
    ])('counts model-output item %j before its payload is streamed', item => {
      expect(firstOutputTokenSignal(eventFrame({ type, item }), 'openaiResponses')).toEqual({ type: 'decode' });
    });

    it.each([
      { type: 'function_call_output', output: 'tool output' },
      { type: 'custom_tool_call_output', output: 'tool output' },
      { type: 'computer_call_output', output: { type: 'computer_screenshot', image_url: 'data:image/png;base64,AAAA' } },
      { type: 'local_shell_call_output', output: 'tool output' },
      { type: 'apply_patch_call_output', output: 'tool output' },
      { type: 'additional_tools', tools: [{ name: 'search' }] },
      { type: 'mcp_list_tools', tools: [] },
      { type: 'mcp_list_tools', tools: [{ name: 'search' }] },
      { type: 'mcp_approval_response', approve: true },
      { type: 'compaction', encrypted_content: 'opaque' },
      { type: 'compaction_summary', encrypted_content: 'opaque' },
      { type: 'context_compaction', encrypted_content: 'opaque' },
    ])('ignores input, discovery, and compaction items: %j', item => {
      expect(firstOutputTokenSignal(eventFrame({ type, item }), 'openaiResponses')).toBeNull();
    });
  });

  it.each([
    { type: 'response.content_part.added', part: { type: 'output_text', text: 'hello' } },
    { type: 'response.content_part.done', part: { type: 'refusal', refusal: 'declined' } },
    { type: 'response.reasoning_summary_part.added', part: { type: 'summary_text', text: 'thinking' } },
    { type: 'response.reasoning_summary_part.done', part: { type: 'summary_text', text: 'thinking' } },
    { type: 'response.output_text.done', text: 'hello' },
    { type: 'response.reasoning.done', text: 'thinking' },
    { type: 'response.reasoning_text.done', text: 'thinking' },
    { type: 'response.reasoning_summary_text.done', text: 'thinking' },
    { type: 'response.refusal.done', refusal: 'declined' },
    { type: 'response.function_call_arguments.done', arguments: '{}' },
    { type: 'response.mcp_call_arguments.done', arguments: '{}' },
    { type: 'response.custom_tool_call_input.done', input: 'ls' },
    { type: 'response.code_interpreter_call_code.done', code: 'print(1)' },
    { type: 'response.shell_call_command.added', command: 'ls' },
    { type: 'response.shell_call_command.done', command: 'ls' },
    { type: 'response.apply_patch_call_operation_diff.done', diff: 'content' },
  ])('recognizes known content arriving on %j', event => {
    expect(firstOutputTokenSignal(eventFrame(event), 'openaiResponses')).toEqual({ type: 'decode' });
  });

  it.each([
    { type: 'response.future_model_output.delta', delta: null },
    { type: 'response.future_model_output.delta', delta: {} },
    { type: 'response.future_model_output.done', delta: 'snapshot' },
    { type: 'unrelated.delta', delta: 'text' },
  ])('rejects events outside nonempty Responses string deltas: %j', event => {
    expect(firstOutputTokenSignal(eventFrame(event), 'openaiResponses')).toBeNull();
  });

  it('excludes execution output, progress, and empty content snapshots', () => {
    for (const event of [
      { type: 'response.shell_call_output_content.delta', delta: { stdout: 'tool output', stderr: '' } },
      { type: 'response.mcp_list_tools.completed', tools: [{ name: 'search' }] },
      { type: 'response.code_interpreter_call.in_progress' },
      { type: 'response.reasoning.done', text: '' },
      { type: 'response.content_part.added', part: { type: 'output_text', text: '' } },
      { type: 'response.reasoning_summary_part.added', part: { type: 'summary_text', text: '' } },
      { type: 'response.shell_call_command.added', command: '' },
    ]) expect(firstOutputTokenSignal(eventFrame(event), 'openaiResponses')).toBeNull();
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
    expect(firstOutputTokenSignal(eventFrame({ choices: [{ delta }] }), 'openaiChatCompletions')).toEqual({ type: 'decode' });
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

  it.each([
    { type: 'tool_use', name: 'search' },
    { type: 'server_tool_use', name: 'web_search' },
    { type: 'text', text: 'hello' },
    { type: 'thinking', thinking: 'thinking' },
  ])('recognizes content already present on an Anthropic block start: %j', content_block => {
    expect(firstOutputTokenSignal(eventFrame({ type: 'content_block_start', content_block }), 'anthropicMessages')).toEqual({ type: 'decode' });
  });

  it('excludes compaction iterations from ordinary output-token timing', () => {
    expect(firstOutputTokenSignal(eventFrame({ type: 'content_block_delta', delta: { type: 'compaction_delta', content: 'summary' } }), 'anthropicMessages')).toBeNull();
  });

  it.each([
    { type: 'signature_delta', signature: 'signature' },
    { type: 'compaction_delta', content: '', encrypted_content: 'opaque' },
    { type: 'compaction_delta', content: null, encrypted_content: 'opaque' },
  ])('rejects Anthropic integrity and replay metadata: %j', delta => {
    expect(firstOutputTokenSignal(eventFrame({ type: 'content_block_delta', delta }), 'anthropicMessages')).toBeNull();
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
    expect(firstOutputTokenSignal(eventFrame({ type: 'content_block_start', content_block }), 'anthropicMessages')).toBeNull();
  });
});
