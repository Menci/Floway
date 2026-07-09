import { describe, expect, it } from 'vitest';

import { isFirstGeneratedTokenFrame } from './first-generated-token.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';

const eventFrame = <T>(event: T): ProtocolFrame<T> => ({ type: 'event', event });

describe('isFirstGeneratedTokenFrame — messages', () => {
  it('accepts text_delta', () => {
    expect(isFirstGeneratedTokenFrame(eventFrame({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } }), 'messages')).toBe(true);
  });

  it('accepts input_json_delta (tool-call argument delta)', () => {
    expect(isFirstGeneratedTokenFrame(eventFrame({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{' } }), 'messages')).toBe(true);
  });

  it('accepts citations_delta (Anthropic citations / web-search)', () => {
    expect(isFirstGeneratedTokenFrame(eventFrame({ type: 'content_block_delta', delta: { type: 'citations_delta', citation: {} } }), 'messages')).toBe(true);
  });

  it('accepts thinking_delta (extended thinking)', () => {
    expect(isFirstGeneratedTokenFrame(eventFrame({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '...' } }), 'messages')).toBe(true);
  });

  it('rejects message_start / content_block_start (envelope frames)', () => {
    expect(isFirstGeneratedTokenFrame(eventFrame({ type: 'message_start' }), 'messages')).toBe(false);
    expect(isFirstGeneratedTokenFrame(eventFrame({ type: 'content_block_start', content_block: { type: 'text' } }), 'messages')).toBe(false);
  });
});

describe('isFirstGeneratedTokenFrame — responses', () => {
  it('accepts response.output_text.delta', () => {
    expect(isFirstGeneratedTokenFrame(eventFrame({ type: 'response.output_text.delta', delta: 'hi' }), 'responses')).toBe(true);
  });

  it('accepts response.function_call_arguments.delta', () => {
    expect(isFirstGeneratedTokenFrame(eventFrame({ type: 'response.function_call_arguments.delta', delta: '{' }), 'responses')).toBe(true);
  });

  it('accepts response.custom_tool_call_input.delta', () => {
    expect(isFirstGeneratedTokenFrame(eventFrame({ type: 'response.custom_tool_call_input.delta', delta: 'hi' }), 'responses')).toBe(true);
  });

  it('accepts response.refusal.delta', () => {
    expect(isFirstGeneratedTokenFrame(eventFrame({ type: 'response.refusal.delta', delta: 'sorry' }), 'responses')).toBe(true);
  });

  it('accepts response.reasoning_text.delta and response.reasoning_summary_text.delta', () => {
    expect(isFirstGeneratedTokenFrame(eventFrame({ type: 'response.reasoning_text.delta', delta: '...' }), 'responses')).toBe(true);
    expect(isFirstGeneratedTokenFrame(eventFrame({ type: 'response.reasoning_summary_text.delta', delta: '...' }), 'responses')).toBe(true);
  });

  it('rejects response.created and response.output_item.added (envelope frames)', () => {
    expect(isFirstGeneratedTokenFrame(eventFrame({ type: 'response.created' }), 'responses')).toBe(false);
    expect(isFirstGeneratedTokenFrame(eventFrame({ type: 'response.output_item.added' }), 'responses')).toBe(false);
  });
});

describe('isFirstGeneratedTokenFrame — chat-completions', () => {
  it('accepts chunk with delta.content', () => {
    expect(isFirstGeneratedTokenFrame(eventFrame({ choices: [{ delta: { content: 'hi' } }] }), 'chat-completions')).toBe(true);
  });

  it('accepts chunk with delta.tool_calls', () => {
    expect(isFirstGeneratedTokenFrame(eventFrame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{' } }] } }] }), 'chat-completions')).toBe(true);
  });

  it('accepts reasoning-only chunk (delta.reasoning / delta.reasoning_content)', () => {
    expect(isFirstGeneratedTokenFrame(eventFrame({ choices: [{ delta: { reasoning: '...' } }] }), 'chat-completions')).toBe(true);
    expect(isFirstGeneratedTokenFrame(eventFrame({ choices: [{ delta: { reasoning_content: '...' } }] }), 'chat-completions')).toBe(true);
  });

  it('rejects role-only chunk', () => {
    expect(isFirstGeneratedTokenFrame(eventFrame({ choices: [{ delta: { role: 'assistant' } }] }), 'chat-completions')).toBe(false);
  });

  it('rejects empty-content chunk', () => {
    expect(isFirstGeneratedTokenFrame(eventFrame({ choices: [{ delta: { content: '' } }] }), 'chat-completions')).toBe(false);
    expect(isFirstGeneratedTokenFrame(eventFrame({ choices: [{ delta: {} }] }), 'chat-completions')).toBe(false);
  });
});

describe('isFirstGeneratedTokenFrame — done sentinel', () => {
  it('always returns false', () => {
    const done = { type: 'done' as const };
    expect(isFirstGeneratedTokenFrame(done, 'messages')).toBe(false);
    expect(isFirstGeneratedTokenFrame(done, 'responses')).toBe(false);
    expect(isFirstGeneratedTokenFrame(done, 'chat-completions')).toBe(false);
  });
});
