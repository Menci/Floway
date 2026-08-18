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

  it('rejects response.created and response.output_item.added (envelope frames)', () => {
    expect(isFirstOutputTokenFrame(eventFrame({ type: 'response.created' }), 'openaiResponses')).toBe(false);
    expect(isFirstOutputTokenFrame(eventFrame({ type: 'response.output_item.added' }), 'openaiResponses')).toBe(false);
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
