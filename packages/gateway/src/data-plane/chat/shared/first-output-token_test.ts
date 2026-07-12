import { describe, expect, it } from 'vitest';

import { isFirstOutputTokenFrame } from './first-output-token.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';

const eventFrame = <T>(event: T): ProtocolFrame<T> => ({ type: 'event', event });

describe('isFirstOutputTokenFrame — messages', () => {
  it('accepts text_delta', () => {
    expect(isFirstOutputTokenFrame(eventFrame({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } }), 'messages')).toBe(true);
  });

  it('accepts input_json_delta (tool-call argument delta)', () => {
    expect(isFirstOutputTokenFrame(eventFrame({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{' } }), 'messages')).toBe(true);
  });

  it('accepts citations_delta (Anthropic citations / web-search)', () => {
    expect(isFirstOutputTokenFrame(eventFrame({ type: 'content_block_delta', delta: { type: 'citations_delta', citation: {} } }), 'messages')).toBe(true);
  });

  it('accepts thinking_delta (extended thinking)', () => {
    expect(isFirstOutputTokenFrame(eventFrame({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '...' } }), 'messages')).toBe(true);
  });

  it('rejects message_start / content_block_start (envelope frames)', () => {
    expect(isFirstOutputTokenFrame(eventFrame({ type: 'message_start' }), 'messages')).toBe(false);
    expect(isFirstOutputTokenFrame(eventFrame({ type: 'content_block_start', content_block: { type: 'text' } }), 'messages')).toBe(false);
  });

  it('rejects empty delta payload (keepalive-style frames)', () => {
    expect(isFirstOutputTokenFrame(eventFrame({ type: 'content_block_delta', delta: { type: 'text_delta', text: '' } }), 'messages')).toBe(false);
    expect(isFirstOutputTokenFrame(eventFrame({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '' } }), 'messages')).toBe(false);
    expect(isFirstOutputTokenFrame(eventFrame({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '' } }), 'messages')).toBe(false);
    expect(isFirstOutputTokenFrame(eventFrame({ type: 'content_block_delta', delta: { type: 'citations_delta' } }), 'messages')).toBe(false);
  });
});

describe('isFirstOutputTokenFrame — responses', () => {
  it('accepts response.output_text.delta', () => {
    expect(isFirstOutputTokenFrame(eventFrame({ type: 'response.output_text.delta', delta: 'hi' }), 'responses')).toBe(true);
  });

  it('accepts response.function_call_arguments.delta', () => {
    expect(isFirstOutputTokenFrame(eventFrame({ type: 'response.function_call_arguments.delta', delta: '{' }), 'responses')).toBe(true);
  });

  it('accepts response.custom_tool_call_input.delta', () => {
    expect(isFirstOutputTokenFrame(eventFrame({ type: 'response.custom_tool_call_input.delta', delta: 'hi' }), 'responses')).toBe(true);
  });

  it('accepts response.refusal.delta', () => {
    expect(isFirstOutputTokenFrame(eventFrame({ type: 'response.refusal.delta', delta: 'sorry' }), 'responses')).toBe(true);
  });

  it('accepts response.reasoning_text.delta and response.reasoning_summary_text.delta', () => {
    expect(isFirstOutputTokenFrame(eventFrame({ type: 'response.reasoning_text.delta', delta: '...' }), 'responses')).toBe(true);
    expect(isFirstOutputTokenFrame(eventFrame({ type: 'response.reasoning_summary_text.delta', delta: '...' }), 'responses')).toBe(true);
  });

  it('rejects response.created and response.output_item.added (envelope frames)', () => {
    expect(isFirstOutputTokenFrame(eventFrame({ type: 'response.created' }), 'responses')).toBe(false);
    expect(isFirstOutputTokenFrame(eventFrame({ type: 'response.output_item.added' }), 'responses')).toBe(false);
  });

  it('rejects known event type with empty delta string', () => {
    expect(isFirstOutputTokenFrame(eventFrame({ type: 'response.output_text.delta', delta: '' }), 'responses')).toBe(false);
    expect(isFirstOutputTokenFrame(eventFrame({ type: 'response.reasoning_text.delta', delta: '' }), 'responses')).toBe(false);
  });
});

describe('isFirstOutputTokenFrame — chat-completions', () => {
  it('accepts chunk with delta.content', () => {
    expect(isFirstOutputTokenFrame(eventFrame({ choices: [{ delta: { content: 'hi' } }] }), 'chat-completions')).toBe(true);
  });

  it('accepts chunk with delta.tool_calls', () => {
    expect(isFirstOutputTokenFrame(eventFrame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{' } }] } }] }), 'chat-completions')).toBe(true);
  });

  it('accepts reasoning-only chunk (delta.reasoning / delta.reasoning_content / delta.reasoning_text)', () => {
    expect(isFirstOutputTokenFrame(eventFrame({ choices: [{ delta: { reasoning: '...' } }] }), 'chat-completions')).toBe(true);
    expect(isFirstOutputTokenFrame(eventFrame({ choices: [{ delta: { reasoning_content: '...' } }] }), 'chat-completions')).toBe(true);
    expect(isFirstOutputTokenFrame(eventFrame({ choices: [{ delta: { reasoning_text: '...' } }] }), 'chat-completions')).toBe(true);
  });

  it('accepts refusal delta (safety refusals are legitimate generated output)', () => {
    expect(isFirstOutputTokenFrame(eventFrame({ choices: [{ delta: { refusal: "I can't help with that." } }] }), 'chat-completions')).toBe(true);
  });

  it('rejects role-only chunk', () => {
    expect(isFirstOutputTokenFrame(eventFrame({ choices: [{ delta: { role: 'assistant' } }] }), 'chat-completions')).toBe(false);
  });

  it('rejects empty-content chunk', () => {
    expect(isFirstOutputTokenFrame(eventFrame({ choices: [{ delta: { content: '' } }] }), 'chat-completions')).toBe(false);
    expect(isFirstOutputTokenFrame(eventFrame({ choices: [{ delta: { refusal: '' } }] }), 'chat-completions')).toBe(false);
    expect(isFirstOutputTokenFrame(eventFrame({ choices: [{ delta: {} }] }), 'chat-completions')).toBe(false);
  });
});

describe('isFirstOutputTokenFrame — done sentinel', () => {
  it('always returns false', () => {
    const done = { type: 'done' as const };
    expect(isFirstOutputTokenFrame(done, 'messages')).toBe(false);
    expect(isFirstOutputTokenFrame(done, 'responses')).toBe(false);
    expect(isFirstOutputTokenFrame(done, 'chat-completions')).toBe(false);
  });
});
