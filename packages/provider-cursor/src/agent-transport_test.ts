import { describe, expect, test, vi } from 'vitest';

import { AgentTransport } from './agent-transport.ts';
import { addConnectEnvelope, encodeMessageField, encodeStringField } from './proto/index.ts';
import type { AgentChatRequest, RequestContextEnv } from './proto/index.ts';

const ENV: RequestContextEnv = { workspacePath: '/tmp', osVersion: 'darwin 24.0.0', shell: '/bin/zsh', timezone: 'UTC' };

function makeTransport(fetchMock: unknown): AgentTransport {
  return new AgentTransport({
    getAuthToken: () => 'tok',
    baseUrl: 'https://api2.cursor.sh',
    env: ENV,
    clientVersion: 'cli-test',
    getChecksum: () => 'checksum-value',
    fetch: fetchMock as typeof fetch,
    maxRetries: 1,
  });
}

// The transport no longer fetches RunSSE itself (the DurableHttpSession owns
// the read socket); it drives a provided read stream. Build one from frames.
function readStreamOf(...frames: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(f);
      controller.close();
    },
  });
}

// Seed + open a turn over a frame stream. fetchMock only serves the BidiAppend
// write channel now.
function openOver(transport: AgentTransport, ...frames: Uint8Array[]): AsyncGenerator {
  transport.seed('req-test', 0n);
  return transport.openChatStream({ readStream: readStreamOf(...frames), request: { message: 'hi', model: 'gpt-4o' } as AgentChatRequest });
}

function okEmptyResponse(): Response {
  return new Response(new Uint8Array(0), { status: 200 });
}

// AgentServerMessage { field 1: InteractionUpdate { field 1: TextDeltaUpdate { field 1: text } } }
function textFrame(text: string): Uint8Array {
  const interactionUpdate = encodeMessageField(1, encodeStringField(1, text));
  const serverMsg = encodeMessageField(1, interactionUpdate);
  return addConnectEnvelope(serverMsg);
}

function turnEndedFrame(): Uint8Array {
  // InteractionUpdate.field 14 (turn_ended), wire type 0, value 0 — presence matters
  const interactionUpdate = new Uint8Array([(14 << 3) | 0, 0]);
  const serverMsg = encodeMessageField(1, interactionUpdate);
  return addConnectEnvelope(serverMsg);
}

function heartbeatFrame(): Uint8Array {
  // InteractionUpdate.field 13 (heartbeat), wire type 0, value 0
  const interactionUpdate = new Uint8Array([(13 << 3) | 0, 0]);
  const serverMsg = encodeMessageField(1, interactionUpdate);
  return addConnectEnvelope(serverMsg);
}

async function collect(gen: AsyncGenerator): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const chunk of gen) out.push(chunk);
  return out;
}

const BIDI_URL = 'https://api2.cursor.sh/aiserver.v1.BidiService/BidiAppend';

describe('AgentTransport.bidiAppend', () => {
  test('POSTs the envelope on the write channel', async () => {
    const fetchMock = vi.fn(async () => okEmptyResponse());
    const transport = makeTransport(fetchMock);
    await transport.bidiAppend('req-1', 0n, new Uint8Array([1, 2, 3]));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [unknown, RequestInit];
    expect(url).toBe(BIDI_URL);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer tok');
    expect(headers['x-cursor-checksum']).toBe('checksum-value');
    expect(headers['content-type']).toBe('application/grpc-web+proto');
  });

  test('retries on transient network errors', async () => {
    const fetchMock = vi.fn(async () => {
      if (fetchMock.mock.calls.length === 1) throw new Error('ECONNRESET socket closed');
      return okEmptyResponse();
    });
    const transport = makeTransport(fetchMock);
    await transport.bidiAppend('req-1', 0n, new Uint8Array([1]));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('does not retry on non-network errors', async () => {
    const fetchMock = vi.fn(async () => {
      if (fetchMock.mock.calls.length === 1) throw new Error('invalid argument');
      return okEmptyResponse();
    });
    const transport = makeTransport(fetchMock);
    await expect(transport.bidiAppend('req-1', 0n, new Uint8Array([1]))).rejects.toThrow('invalid argument');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('surfaces non-ok status as an error', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 401 }));
    const transport = makeTransport(fetchMock);
    await expect(transport.bidiAppend('req-1', 0n, new Uint8Array([1]))).rejects.toThrow('BidiAppend failed: 401');
  });
});

describe('AgentTransport.openChatStream', () => {
  const bidiOnlyMock = (): ReturnType<typeof vi.fn> => vi.fn(async (_url: string) => okEmptyResponse());

  test('yields text then done on a clean turn', async () => {
    const transport = makeTransport(bidiOnlyMock());
    const chunks = await collect(openOver(transport, textFrame('hello'), turnEndedFrame()));

    const types = chunks.map(c => (c as { type: string }).type);
    expect(types).toContain('text');
    expect((chunks.find(c => (c as { type: string }).type === 'text') as { content?: string })?.content).toBe('hello');
    expect(types[types.length - 1]).toBe('done');
  });

  test('heartbeats after text do not preempt turn_ended (authoritative end)', async () => {
    // Regression: a raw heartbeat count must NOT end the turn after output has
    // started — cursor interleaves keep-alive heartbeats and KV checkpoints
    // between the final text and the turn_ended (IU field 14) marker. Closing
    // on a beat count truncated short answers whose turn_ended lagged behind.
    const transport = makeTransport(bidiOnlyMock());
    const chunks = await collect(openOver(
      transport,
      textFrame('the answer is 42'),
      heartbeatFrame(), heartbeatFrame(), heartbeatFrame(),
      heartbeatFrame(), heartbeatFrame(), heartbeatFrame(),
      turnEndedFrame(),
    ));
    const types = chunks.map(c => (c as { type: string }).type);

    // The full text survives, and the turn ends on the turn_ended frame (done
    // is the last chunk), not cut short by the six intervening heartbeats.
    expect((chunks.find(c => (c as { type: string }).type === 'text') as { content?: string })?.content).toBe('the answer is 42');
    expect(types[types.length - 1]).toBe('done');
  });

  test('sends the initial RunRequest on the BidiAppend write channel', async () => {
    const fetchMock = bidiOnlyMock();
    const transport = makeTransport(fetchMock);
    await collect(openOver(transport, textFrame('hi'), turnEndedFrame()));

    const bidiCalls = fetchMock.mock.calls.filter(c => String(c[0]).includes('BidiAppend'));
    expect(bidiCalls.length).toBeGreaterThanOrEqual(1);
  });
});

describe('AgentTransport.sendRejectedTool', () => {
  test('sends a result frame then a stream-close control (2 BidiAppends)', async () => {
    // Open a stream first so currentRequestId is set (sendExecAndClose guards it).
    const bidiFetch = vi.fn(async (_url: string) => okEmptyResponse());
    const transport2 = makeTransport(bidiFetch);
    // Drive the stream just enough to set currentRequestId, then reject a shell tool.
    const gen = openOver(transport2, textFrame('hi'), turnEndedFrame());
    await gen.next(); // text chunk, currentRequestId now set

    const bidiBefore = bidiFetch.mock.calls.filter(c => String(c[0]).includes('BidiAppend')).length;
    await transport2.sendRejectedTool({ type: 'shell', id: 9, execId: 'e1', command: 'rm', cwd: '/' }, 'no shell in gateway');
    const bidiAfter = bidiFetch.mock.calls.filter(c => String(c[0]).includes('BidiAppend')).length;
    expect(bidiAfter - bidiBefore).toBe(2); // exec result + control close
    await gen.return(undefined);
  });

  test('throws when no active stream is open', async () => {
    const transport = makeTransport(vi.fn(async () => okEmptyResponse()));
    await expect(
      transport.sendRejectedTool({ type: 'shell', id: 1, command: 'x', cwd: '/' }, 'reason'),
    ).rejects.toThrow('No active chat stream');
  });
});

describe('AgentTransport privacy mode', () => {
  test('x-ghost-mode on the RunSSE init headers reflects privacyMode (default on)', () => {
    const make = (privacyMode: boolean | undefined): Record<string, string> =>
      new AgentTransport({
        getAuthToken: () => 'tok',
        baseUrl: 'https://api2.cursor.sh',
        env: ENV,
        clientVersion: 'cli-test',
        privacyMode,
        getChecksum: () => 'checksum-value',
        fetch: vi.fn() as unknown as typeof fetch,
      }).runSseInit('req-1').headers;

    expect(make(false)['x-ghost-mode']).toBe('false');
    expect(make(true)['x-ghost-mode']).toBe('true');
    expect(make(undefined)['x-ghost-mode']).toBe('true');
  });
});
