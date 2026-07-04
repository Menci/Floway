import { describe, expect, test } from 'vitest';

import { deriveSessionKey, mintSessionKey, wrapToolCallId, decodeToolCallId } from './session-id.ts';

describe('deriveSessionKey', () => {
  test('priority 1: X-Floway-Conversation-Id header wins', () => {
    const headers = new Headers({ 'x-floway-conversation-id': 'conv-123' });
    const result = deriveSessionKey('up1', 'ak1', headers, [{ role: 'user', content: 'hi' }]);
    expect(result.sessionKey).toBe('cursor:up1:ak1:hdr:conv-123');
    expect(result.isFollowUp).toBe(true);
  });

  test('priority 2: tool_call_id with sess_ prefix in role:tool', () => {
    const result = deriveSessionKey('up1', 'ak1', new Headers(), [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'sess_abc123def456__call_xyz', type: 'function', function: { name: 'f', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'sess_abc123def456__call_xyz', content: '{"result":1}' },
    ]);
    expect(result.sessionKey).toBe('cursor:up1:ak1:auto:abc123def456');
    expect(result.isFollowUp).toBe(true);
  });

  test('priority 2: assistant tool_calls with sess_ prefix (no tool message yet)', () => {
    const result = deriveSessionKey('up1', 'ak1', new Headers(), [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'sess_aabbccdd__call_99', type: 'function', function: { name: 'g', arguments: '{}' } }] },
    ]);
    expect(result.sessionKey).toBe('cursor:up1:ak1:auto:aabbccdd');
    expect(result.isFollowUp).toBe(true);
  });

  test('priority 3: returns null when no correlation found', () => {
    const result = deriveSessionKey('up1', 'ak1', new Headers(), [
      { role: 'user', content: 'What is 2+2?' },
    ]);
    expect(result.sessionKey).toBeNull();
    expect(result.isFollowUp).toBe(false);
  });

  test('scans from the end (latest message wins)', () => {
    const result = deriveSessionKey('up1', 'ak1', new Headers(), [
      { role: 'tool', tool_call_id: 'sess_old__call_1', content: 'x' },
      { role: 'user', content: 'new turn' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'sess_new__call_2', type: 'function', function: { name: 'f', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'sess_new__call_2', content: 'y' },
    ]);
    expect(result.sessionKey).toBe('cursor:up1:ak1:auto:new');
  });

  test('ignores tool_call_ids without the sess_ prefix', () => {
    const result = deriveSessionKey('up1', 'ak1', new Headers(), [
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_plain', type: 'function', function: { name: 'f', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_plain', content: 'z' },
    ]);
    expect(result.sessionKey).toBeNull();
    expect(result.isFollowUp).toBe(false);
  });
});

describe('mintSessionKey', () => {
  test('produces the expected format', () => {
    const key = mintSessionKey('up1', 'ak1');
    expect(key).toMatch(/^cursor:up1:ak1:auto:[a-f0-9]{12}$/);
  });

  test('each call produces a unique key', () => {
    const a = mintSessionKey('up1', 'ak1');
    const b = mintSessionKey('up1', 'ak1');
    expect(a).not.toBe(b);
  });
});

describe('wrapToolCallId / decodeToolCallId', () => {
  test('encodes the session id + exec ref and round-trips', () => {
    const sessionKey = 'cursor:up1:ak1:auto:abc123def456';
    const wrapped = wrapToolCallId(sessionKey, { id: 7, execId: 'fc_01c10a8' });
    expect(wrapped).toBe('sess_abc123def456__7__fc_01c10a8');
    // deriveSessionKey still recovers the session id from the prefix.
    expect(deriveSessionKey('up1', 'ak1', new Headers(), [{ role: 'tool', tool_call_id: wrapped, content: 'x' }]).sessionKey)
      .toBe('cursor:up1:ak1:auto:abc123def456');
    expect(decodeToolCallId(wrapped)).toEqual({ id: 7, execId: 'fc_01c10a8' });
  });

  test('round-trips an absent execId', () => {
    const wrapped = wrapToolCallId('cursor:up1:ak1:auto:aabb', { id: 3, execId: undefined });
    expect(wrapped).toBe('sess_aabb__3__');
    expect(decodeToolCallId(wrapped)).toEqual({ id: 3, execId: undefined });
  });

  test('decode returns null for ids without the sess_ prefix or a non-numeric id', () => {
    expect(decodeToolCallId('call_plain')).toBeNull();
    expect(decodeToolCallId('sess_aabb__notanumber__fc_1')).toBeNull();
  });
});
