import { describe, expect, test } from 'vitest';

import {
  encodeVarint,
  decodeVarint,
  encodeStringField,
  encodeInt64Field,
  encodeMessageField,
  encodeUint32Field,
  encodeInt32Field,
  encodeProtobufValue,
  bytesToHex,
  hexToBytes,
  concatBytes,
  parseProtoFields,
  parseProtobufValue,
  encodeBidiRequestId,
  encodeBidiAppendRequest,
  addConnectEnvelope,
  readConnectFrame,
  isTrailerFrame,
  parseInteractionUpdate,
  parseCheckpointTokenDetails,
  parseExecServerMessage,
  parseKvServerMessage,
  parseToolCall,
  buildKvClientMessage,
  buildExecClientMessageWithMcpResult,
  buildExecClientMessageWithRejectedTool,
  buildAgentClientMessageWithExec,
  AgentMode,
  type ExecRequest,
} from './index.ts';

describe('proto encoding primitives', () => {
  test('encodeVarint matches canonical byte sequences', () => {
    expect(Array.from(encodeVarint(0))).toEqual([0]);
    expect(Array.from(encodeVarint(150))).toEqual([0x96, 0x01]);
    // 1 << 35 = 2^35, which exceeds the 5-byte varint max (2^35 - 1) → 6 bytes
    expect(Array.from(encodeVarint(1n << 35n))).toHaveLength(6);
  });

  test('encodeVarint round-trips through decodeVarint', () => {
    for (const v of [0, 1, 127, 128, 150, 16384, 0x0fffffff]) {
      const bytes = encodeVarint(v);
      const { value, bytesRead } = decodeVarint(bytes, 0);
      expect(value).toBe(v);
      expect(bytesRead).toBe(bytes.length);
    }
  });

  test('encodeStringField round-trips through parseProtoFields', () => {
    const field = encodeStringField(1, 'hello-世界');
    const parsed = parseProtoFields(field);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.fieldNumber).toBe(1);
    expect(parsed[0]!.wireType).toBe(2);
    expect(new TextDecoder().decode(parsed[0]!.value as Uint8Array)).toBe('hello-世界');
  });

  test('bytesToHex / hexToBytes round-trip', () => {
    const bytes = new Uint8Array([0x00, 0xff, 0xab, 0x12, 0x9f]);
    const hex = bytesToHex(bytes);
    expect(hex).toBe('00ffab129f');
    expect(Array.from(hexToBytes(hex))).toEqual(Array.from(bytes));
  });

  test('hexToBytes rejects odd-length input', () => {
    expect(() => hexToBytes('abc')).toThrow(TypeError);
  });

  test('encodeInt64Field carries bigint seqno', () => {
    const field = encodeInt64Field(3, 42n);
    const parsed = parseProtoFields(field);
    expect(parsed[0]!.fieldNumber).toBe(3);
    expect(parsed[0]!.wireType).toBe(0);
    // wire type 0 fields surface as a number value
    expect(parsed[0]!.value).toBe(42);
  });
});

describe('connect envelope', () => {
  test('addConnectEnvelope / readConnectFrame round-trip', () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const framed = addConnectEnvelope(payload, 0);
    expect(framed.length).toBe(5 + payload.length);
    const frame = readConnectFrame(framed, 0);
    expect(frame).not.toBeNull();
    expect(frame!.flags).toBe(0);
    expect(Array.from(frame!.payload)).toEqual([1, 2, 3, 4, 5]);
    expect(frame!.nextOffset).toBe(framed.length);
  });

  test('readConnectFrame returns null for a partial frame', () => {
    const payload = new Uint8Array(10);
    const framed = addConnectEnvelope(payload, 0);
    const partial = framed.slice(0, 7);
    expect(readConnectFrame(partial, 0)).toBeNull();
  });

  test('trailer flag is detected', () => {
    const framed = addConnectEnvelope(new TextEncoder().encode('grpc-status: 0'), 0x80);
    const frame = readConnectFrame(framed, 0);
    expect(isTrailerFrame(frame!.flags)).toBe(true);
  });
});

describe('google.protobuf.Value', () => {
  test.each([
    ['null', null, null],
    ['number', 3.5, 3.5],
    ['string', 'hi', 'hi'],
    ['true', true, true],
    ['false', false, false],
  ])('round-trips %s', (_label, input, expected) => {
    expect(parseProtobufValue(encodeProtobufValue(input))).toBe(expected);
  });

  test('round-trips a nested struct', () => {
    const input = { a: 1, b: 'x', c: [1, 2, { d: true }] };
    expect(parseProtobufValue(encodeProtobufValue(input))).toEqual(input);
  });
});

describe('bidi control messages', () => {
  test('encodeBidiAppendRequest carries hex data + requestId + seqno', () => {
    const hexData = 'deadbeef';
    const requestId = 'req-123';
    const fields = parseProtoFields(encodeBidiAppendRequest(hexData, requestId, 7n));
    expect(fields).toHaveLength(3);

    const data = fields.find(f => f.fieldNumber === 1);
    expect(data?.wireType).toBe(2);
    expect(new TextDecoder().decode(data!.value as Uint8Array)).toBe(hexData);

    const seqno = fields.find(f => f.fieldNumber === 3);
    expect(seqno?.wireType).toBe(0);
    expect(seqno!.value).toBe(7);

    // nested requestId message at field 2
    const reqIdMsg = fields.find(f => f.fieldNumber === 2);
    const inner = parseProtoFields(reqIdMsg!.value as Uint8Array);
    expect(new TextDecoder().decode(inner[0]!.value as Uint8Array)).toBe(requestId);
  });

  test('encodeBidiRequestId is a single string field', () => {
    const fields = parseProtoFields(encodeBidiRequestId('r1'));
    expect(fields).toHaveLength(1);
    expect(fields[0]!.fieldNumber).toBe(1);
    expect(new TextDecoder().decode(fields[0]!.value as Uint8Array)).toBe('r1');
  });
});

describe('parseInteractionUpdate', () => {
  test('extracts text_delta', () => {
    // InteractionUpdate.field1 = TextDeltaUpdate.field1 = text
    const update = encodeMessageField(1, encodeStringField(1, 'hello'));
    const parsed = parseInteractionUpdate(update);
    expect(parsed.text).toBe('hello');
    expect(parsed.isComplete).toBe(false);
  });

  test('extracts thinking_delta', () => {
    const update = encodeMessageField(4, encodeStringField(1, 'reasoning...'));
    expect(parseInteractionUpdate(update).thinking).toBe('reasoning...');
  });

  test('flags turn_ended on field 14', () => {
    // field 14, wire type 0, value 0 — presence is what matters. Build the
    // tag byte explicitly: encodeUint32Field omits zero values.
    const update = new Uint8Array([(14 << 3) | 0, 0]);
    expect(parseInteractionUpdate(update).isComplete).toBe(true);
  });

  test('flags heartbeat on field 13', () => {
    const update = new Uint8Array([(13 << 3) | 0, 0]);
    expect(parseInteractionUpdate(update).isHeartbeat).toBe(true);
  });

  test('reads token_delta (field 8 → TokenDeltaUpdate.tokens=1, a varint)', () => {
    // InteractionUpdate.field8 = TokenDeltaUpdate{ int32 tokens = 1 }.
    const update = encodeMessageField(8, encodeInt32Field(1, 7));
    const parsed = parseInteractionUpdate(update);
    expect(parsed.tokenDelta).toBe(7);
    expect(parsed.text).toBeNull(); // must NOT be mis-decoded as text
  });

  test('token_delta absent → tokenDelta null', () => {
    const update = encodeMessageField(1, encodeStringField(1, 'hi'));
    expect(parseInteractionUpdate(update).tokenDelta).toBeNull();
  });
});

describe('parseCheckpointTokenDetails', () => {
  test('reads used/max tokens (ConversationStateStructure.field5 → {used=1, max=2})', () => {
    // ConversationTokenDetails { used_tokens=1, max_tokens=2 } under field 5.
    const details = concatBytes(encodeUint32Field(1, 21132), encodeUint32Field(2, 262000));
    const checkpoint = encodeMessageField(5, details);
    expect(parseCheckpointTokenDetails(checkpoint)).toEqual({ usedTokens: 21132, maxTokens: 262000 });
  });

  test('no token_details → null', () => {
    // A checkpoint with only root_prompt_messages_json (field 1), no field 5.
    const checkpoint = encodeMessageField(1, new Uint8Array([1, 2, 3]));
    expect(parseCheckpointTokenDetails(checkpoint)).toBeNull();
  });
});

describe('parseExecServerMessage', () => {
  function buildMcpExec(id: number, mcpArgs: Uint8Array): Uint8Array {
    return concatBytes(encodeUint32Field(1, id), encodeMessageField(11, mcpArgs));
  }

  test('parses an mcp exec request', () => {
    // McpArgs: field1 name, field3 toolCallId, field4 providerIdentifier, field5 toolName
    const mcpArgs = concatBytes(
      encodeStringField(1, 'search'),
      encodeStringField(3, 'call_1'),
      encodeStringField(4, 'cursor-tools'),
      encodeStringField(5, 'search'),
    );
    const exec = buildMcpExec(42, mcpArgs);
    const parsed = parseExecServerMessage(exec) as Extract<ExecRequest, { type: 'mcp' }>;
    expect(parsed).not.toBeNull();
    expect(parsed.type).toBe('mcp');
    expect(parsed.id).toBe(42);
    expect(parsed.name).toBe('search');
    expect(parsed.toolCallId).toBe('call_1');
    expect(parsed.providerIdentifier).toBe('cursor-tools');
    expect(parsed.toolName).toBe('search');
  });

  test('parses a shell exec request (field 2)', () => {
    const shellArgs = concatBytes(encodeStringField(1, 'ls -la'), encodeStringField(2, '/tmp'));
    const exec = concatBytes(encodeUint32Field(1, 7), encodeMessageField(2, shellArgs));
    const parsed = parseExecServerMessage(exec) as Extract<ExecRequest, { type: 'shell' }>;
    expect(parsed.type).toBe('shell');
    expect(parsed.id).toBe(7);
    expect(parsed.command).toBe('ls -la');
    expect(parsed.cwd).toBe('/tmp');
  });

  test('parses a request_context exec request (field 10)', () => {
    const exec = concatBytes(encodeUint32Field(1, 9), encodeMessageField(10, new Uint8Array(0)));
    const parsed = parseExecServerMessage(exec) as Extract<ExecRequest, { type: 'request_context' }>;
    expect(parsed.type).toBe('request_context');
    expect(parsed.id).toBe(9);
  });
});

describe('exec result / reject encoders', () => {
  test('buildExecClientMessageWithMcpResult encodes id + mcp success', () => {
    const msg = buildExecClientMessageWithMcpResult(5, undefined, { success: { content: 'ok' } });
    const fields = parseProtoFields(msg);
    expect(fields.find(f => f.fieldNumber === 1)!.value).toBe(5);
    expect(fields.find(f => f.fieldNumber === 11)).toBeDefined();
  });

  test('buildExecClientMessageWithRejectedTool emits a shell failure', () => {
    const req: Extract<ExecRequest, { type: 'shell' }> = {
      type: 'shell',
      id: 3,
      execId: 'e1',
      command: 'rm -rf /',
      cwd: '/',
    };
    const msg = buildExecClientMessageWithRejectedTool(req, 'gateway cannot execute shell');
    const fields = parseProtoFields(msg);
    expect(fields.find(f => f.fieldNumber === 1)!.value).toBe(3);
    // shell result lives at field 2
    expect(fields.find(f => f.fieldNumber === 2)).toBeDefined();
    // execId at field 15
    expect(new TextDecoder().decode(fields.find(f => f.fieldNumber === 15)!.value as Uint8Array)).toBe('e1');
  });

  test('buildAgentClientMessageWithExec wraps at AgentClientMessage field 2', () => {
    const inner = buildExecClientMessageWithMcpResult(1, undefined, { error: 'nope' });
    const wrapped = buildAgentClientMessageWithExec(inner);
    const fields = parseProtoFields(wrapped);
    expect(fields[0]!.fieldNumber).toBe(2);
    expect(fields[0]!.wireType).toBe(2);
  });
});

describe('parseKvServerMessage', () => {
  test('parses set_blob_args', () => {
    const blobId = new Uint8Array([1, 2, 3]);
    const blobData = new Uint8Array([0xaa, 0xbb]);
    const setBlobArgs = concatBytes(encodeMessageField(1, blobId), encodeMessageField(2, blobData));
    const kv = concatBytes(encodeUint32Field(1, 99), encodeMessageField(3, setBlobArgs));
    const parsed = parseKvServerMessage(kv);
    expect(parsed.id).toBe(99);
    expect(parsed.messageType).toBe('set_blob_args');
    expect(Array.from(parsed.blobId!)).toEqual([1, 2, 3]);
    expect(Array.from(parsed.blobData!)).toEqual([0xaa, 0xbb]);
  });
});

describe('AgentMode enum', () => {
  test('has the expected modes', () => {
    expect(AgentMode.AGENT).toBe(1);
    expect(AgentMode.ASK).toBe(2);
    expect(AgentMode.UNSPECIFIED).toBe(0);
  });
});

describe('buildKvClientMessage', () => {
  test('wraps get_blob_result payload as GetBlobResult{ blob_data = 1 }', () => {
    const blob = new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x7d]); // {"a"}
    const msg = buildKvClientMessage(7, 'get_blob_result', blob);
    const fields = parseProtoFields(msg);
    expect((fields.find(f => f.fieldNumber === 1)!.value as number)).toBe(7); // id
    // field 2 is the GetBlobResult message, whose field 1 carries the raw blob —
    // cursor parses field 2 as the result message, so the bytes must NOT sit
    // directly in field 2 (that regressed to a stall).
    const getBlobResult = fields.find(f => f.fieldNumber === 2)!.value as Uint8Array;
    const inner = parseProtoFields(getBlobResult);
    expect(Array.from(inner.find(f => f.fieldNumber === 1)!.value as Uint8Array)).toEqual(Array.from(blob));
  });

  test('set_blob_result stays an empty SetBlobResult message (field 3)', () => {
    const msg = buildKvClientMessage(3, 'set_blob_result', new Uint8Array(0));
    const fields = parseProtoFields(msg);
    const setBlobResult = fields.find(f => f.fieldNumber === 3)!.value as Uint8Array;
    expect(setBlobResult.length).toBe(0);
  });
});

describe('parseToolCall nested-wrapper heuristic', () => {
  test('preserves a shell command that starts with a newline', () => {
    // 0x0a is byte-identical with the UTF-8 encoding of `\n`, so a leading
    // LF in a scalar string used to false-positive into the nested-wrapper
    // reparse and corrupt the command. The strict length-consistency check
    // now keeps such strings intact.
    const shellArgs = encodeStringField(1, '\ncat foo');
    const toolCall = encodeMessageField(1, shellArgs);
    const parsed = parseToolCall(toolCall);
    expect(parsed.toolType).toBe('shell_tool_call');
    expect(parsed.arguments.command).toBe('\ncat foo');
  });

  test('preserves a multi-line edit oldString that starts with a newline', () => {
    const editArgs = concatBytes(
      encodeStringField(1, 'foo.ts'),
      encodeStringField(2, '\nconst x = 1;\n'),
      encodeStringField(3, '\nconst y = 2;\n'),
    );
    const toolCall = encodeMessageField(12, editArgs);
    const parsed = parseToolCall(toolCall);
    expect(parsed.toolType).toBe('edit_tool_call');
    expect(parsed.arguments.oldString).toBe('\nconst x = 1;\n');
    expect(parsed.arguments.newString).toBe('\nconst y = 2;\n');
  });
});
