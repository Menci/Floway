import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { callCursorChatCompletions, flattenMessages, pullToFirstMeaningful, type CursorCallEffects } from './fetch.ts';
import { addConnectEnvelope, encodeMessageField, encodeStringField, type AgentStreamChunk } from './proto/index.ts';
import type { CursorAccessTokenEntry, CursorAccountCredential, CursorUpstreamState } from './state.ts';
import { initDurableHttpSession, resetDurableHttpSessionForTesting, type DurableHttpSession } from '@floway-dev/platform';
import type { ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { initProviderRepo, type ProviderModel, type UpstreamRecord } from '@floway-dev/provider';
import { noopCursorSessionsRepo, noopUpstreamCallOptions, stubProviderModel } from '@floway-dev/test-utils';

// Minimal DurableHttpSession that does the RunSSE fetch via globalThis.fetch
// (which the tests mock), so the read stream flows through the same channel the
// suite already controls. Mirrors the in-process impl's open() shape.
const testDurableHttpSession: DurableHttpSession = {
  async acquire(_sessionKey, init) {
    if (!init) return null; // resume miss → cold-resume (claim returns null first anyway)
    const resp = await globalThis.fetch(init.url, { method: init.method, headers: init.headers, body: init.body as BodyInit });
    return {
      status: resp.status,
      headers: resp.headers,
      body: resp.body ?? new ReadableStream<Uint8Array>({ start: c => c.close() }),
      release: async () => {},
      discard: async () => {},
    };
  },
};

const makeEffects = (): CursorCallEffects => ({
  persistRefreshTokenRotation: vi.fn(async () => {}),
  persistTerminalState: vi.fn(async () => {}),
});

const farFutureAccessToken: CursorAccessTokenEntry = {
  token: 'at.cursor.test',
  expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  refreshedAt: '2026-01-01T00:00:00Z',
};

const activeAccount: CursorAccountCredential = {
  userId: 'u1',
  refresh_token: 'rt_v1',
  state: 'active',
  state_updated_at: '2026-01-01T00:00:00Z',
  accessToken: farFutureAccessToken,
};

const model: ProviderModel = stubProviderModel({ id: 'gpt-4o', display_name: 'gpt-4o', endpoints: { chatCompletions: {} } });
const upstreamId = 'up_a';

const makeRecord = (state: CursorUpstreamState): UpstreamRecord => ({
  id: upstreamId,
  kind: 'cursor',
  name: 'Cursor',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  config: { accounts: [{ email: 'a@b.com', userId: 'u1' }] },
  state,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
});

let currentRecord: UpstreamRecord;

beforeEach(() => {
  vi.useRealTimers();
  initDurableHttpSession(testDurableHttpSession);
  currentRecord = makeRecord({ accounts: [{ ...activeAccount }] });
  initProviderRepo(() => ({
    cursorSessions: noopCursorSessionsRepo(),
    upstreams: {
      getById: async () => currentRecord,
      saveState: async (_id, newState) => {
        currentRecord = { ...currentRecord, state: newState as CursorUpstreamState };
        return { updated: true };
      },
    },
  }));
});

afterEach(() => {
  resetDurableHttpSessionForTesting();
  vi.restoreAllMocks();
});

// AgentServerMessage { field 1: InteractionUpdate { field 1: TextDeltaUpdate { field 1: text } } }
function textFrame(text: string): Uint8Array {
  const interactionUpdate = encodeMessageField(1, encodeStringField(1, text));
  const serverMsg = encodeMessageField(1, interactionUpdate);
  return addConnectEnvelope(serverMsg);
}

function turnEndedFrame(): Uint8Array {
  const interactionUpdate = new Uint8Array([(14 << 3) | 0, 0]);
  const serverMsg = encodeMessageField(1, interactionUpdate);
  return addConnectEnvelope(serverMsg);
}

// AgentServerMessage { field 3: conversation_checkpoint_update } — a pre-output
// control frame cursor emits before the first token; driveReadLoop yields it as
// { type: 'checkpoint' }.
function checkpointFrame(): Uint8Array {
  const serverMsg = encodeMessageField(3, new Uint8Array([1, 2, 3]));
  return addConnectEnvelope(serverMsg);
}

function streamResponse(...frames: Uint8Array[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(f);
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'application/grpc-web+proto' } });
}

const mockCursorFetch = (runSse: Response): ReturnType<typeof vi.spyOn> =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = String(typeof input === 'string' ? input : (input as URL).toString());
    if (url.includes('RunSSE')) return runSse;
    if (url.includes('BidiAppend')) return new Response(new Uint8Array(0), { status: 200 });
    return new Response('', { status: 404 });
  });

const collectEvents = async (result: { ok: true; events: AsyncIterable<ProtocolFrame<ChatCompletionsStreamEvent>> }): Promise<ChatCompletionsStreamEvent[]> => {
  const events: ChatCompletionsStreamEvent[] = [];
  for await (const frame of result.events) {
    if (frame.type === 'event') events.push(frame.event);
    else break;
  }
  return events;
};

describe('callCursorChatCompletions', () => {
  test('refuses non-active state with synthetic 503', async () => {
    const result = await callCursorChatCompletions({
      upstreamId,
      account: { ...activeAccount, state: 'session_terminated' },
      model,
      body: { messages: [{ role: 'user', content: 'hi' }] },
      headers: new Headers(),
      effects: makeEffects(),
      privacyMode: true,
      call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(503);
      expect(await result.response.text()).toMatch(/session_terminated/);
    }
  });

  test('streams text + finish_reason=stop on a clean turn', async () => {
    mockCursorFetch(streamResponse(textFrame('hello'), turnEndedFrame()));
    const result = await callCursorChatCompletions({
      upstreamId,
      account: activeAccount,
      model,
      body: { messages: [{ role: 'user', content: 'hi' }] },
      headers: new Headers(),
      effects: makeEffects(),
      privacyMode: true,
      call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const events = await collectEvents(result);
    const contents = events.map(e => e.choices[0]?.delta?.content ?? '').filter(c => c !== '');
    expect(contents).toContain('hello');
    expect(events.some(e => e.choices[0]?.finish_reason === 'stop')).toBe(true);
    // Trailing zero-usage frame (choices: []) so the gateway counts the request.
    const usageFrame = events.find(e => e.choices.length === 0 && e.usage);
    expect(usageFrame?.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  });

  test('surfaces a non-ok RunSSE as a thrown stream error', async () => {
    mockCursorFetch(new Response('upstream down', { status: 503 }));
    const result = await callCursorChatCompletions({
      upstreamId,
      account: activeAccount,
      model,
      body: { messages: [{ role: 'user', content: 'hi' }] },
      headers: new Headers(),
      effects: makeEffects(),
      privacyMode: true,
      call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await expect(collectEvents(result)).rejects.toThrow(/SSE stream failed: 503/);
  });

  test('records TTFT: the latency wrap resolves to the first token frame, past control frames', async () => {
    mockCursorFetch(streamResponse(checkpointFrame(), textFrame('hello'), turnEndedFrame()));
    // Mirror the real recorder: last-settled promise wins. The acquire/BidiAppend
    // wraps settle first; the pull-to-first-token wrap settles last, so its value
    // (the first meaningful IteratorResult) is what upstream_success would record.
    const settled: unknown[] = [];
    const call = noopUpstreamCallOptions({
      recordUpstreamLatency: <T>(promise: Promise<T>): Promise<T> => {
        void promise.then(v => settled.push(v)).catch(() => {});
        return promise;
      },
    });
    const result = await callCursorChatCompletions({
      upstreamId, account: activeAccount, model,
      body: { messages: [{ role: 'user', content: 'hi' }] },
      headers: new Headers(), effects: makeEffects(), privacyMode: true, call,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const events = await collectEvents(result);
    expect(events.map(e => e.choices[0]?.delta?.content ?? '').filter(Boolean)).toContain('hello');

    // Only the pull wrap resolves to an IteratorResult (acquire→handle,
    // BidiAppend→Response). It must carry the text token, not the checkpoint.
    const pullResults = settled.filter(
      (v): v is IteratorResult<AgentStreamChunk> => !!v && typeof v === 'object' && 'done' in v,
    );
    expect(pullResults.at(-1)).toEqual({ done: false, value: { type: 'text', content: 'hello' } });
  });
});

describe('pullToFirstMeaningful', () => {
  async function* chunkGen(chunks: AgentStreamChunk[]): AsyncGenerator<AgentStreamChunk> {
    for (const c of chunks) yield c;
  }

  test('skips pre-output control frames and stops at the first text token', async () => {
    const r = await pullToFirstMeaningful(chunkGen([
      { type: 'checkpoint' }, { type: 'heartbeat' }, { type: 'text', content: 'hi' },
    ]));
    expect(r).toEqual({ done: false, value: { type: 'text', content: 'hi' } });
  });

  test('skips empty text/thinking deltas, stops at the first non-empty one', async () => {
    const r = await pullToFirstMeaningful(chunkGen([
      { type: 'text', content: '' }, { type: 'thinking', content: '' }, { type: 'thinking', content: 'reasoning' },
    ]));
    expect(r).toEqual({ done: false, value: { type: 'thinking', content: 'reasoning' } });
  });

  test('stops at exec_request when the model goes straight to a tool call', async () => {
    const r = await pullToFirstMeaningful(chunkGen([{ type: 'checkpoint' }, { type: 'exec_request' }]));
    expect(r.done).toBe(false);
    expect((r.value as AgentStreamChunk).type).toBe('exec_request');
  });

  test('stops at a terminal done frame on an empty (all-heartbeat) turn', async () => {
    const r = await pullToFirstMeaningful(chunkGen([
      { type: 'heartbeat' }, { type: 'heartbeat' }, { type: 'done' },
    ]));
    expect(r).toEqual({ done: false, value: { type: 'done' } });
  });

  test('returns the done result when the generator ends with only control frames', async () => {
    const r = await pullToFirstMeaningful(chunkGen([{ type: 'checkpoint' }]));
    expect(r.done).toBe(true);
  });
});

describe('flattenMessages', () => {
  test('folds a completed tool round with framing and tool-name labels', () => {
    const out = flattenMessages([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'weather in Tokyo?' },
      { role: 'assistant', content: 'Plan: check the weather.', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '{"temperature":18,"condition":"cloudy"}' },
      { role: 'assistant', content: 'Tokyo is cloudy, 18C.' },
      { role: 'user', content: 'thanks' },
    ]);
    expect(out).toContain('[System]\nYou are helpful.');
    expect(out).toContain('[User]\nweather in Tokyo?');
    expect(out).toContain('[Assistant]\nPlan: check the weather.\n→ called get_weather({"city":"Tokyo"})');
    expect(out).toContain('[Tool result: get_weather]\n{"temperature":18,"condition":"cloudy"}');
    expect(out).toContain('[Assistant]\nTokyo is cloudy, 18C.');
  });

  test('folds a trailing pending tool round instead of dropping it (full reconstruction)', () => {
    const out = flattenMessages([
      { role: 'user', content: 'weather?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'get_weather', arguments: '{"city":"NYC"}' } }] },
      { role: 'tool', tool_call_id: 'c', content: '{"t":20}' },
    ]);
    expect(out).toContain('→ called get_weather({"city":"NYC"})');
    expect(out.endsWith('[Tool result: get_weather]\n{"t":20}')).toBe(true);
  });

  test('renders an assistant turn that carried only tool_calls (no text)', () => {
    const out = flattenMessages([
      { role: 'assistant', content: null, tool_calls: [{ id: 'x', type: 'function', function: { name: 'search', arguments: '{}' } }] },
    ]);
    expect(out).toBe('[Assistant]\n→ called search({})');
  });

  test('plain-text conversation keeps the role-tagged shape', () => {
    const out = flattenMessages([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
    expect(out).toBe('[System]\nsys\n\n[User]\nhi\n\n[Assistant]\nhello');
  });

  test('normalizes tool-result content (array parts) and keeps the frame on empty/unknown', () => {
    const arr = flattenMessages([
      { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 't', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'a', content: [{ type: 'text', text: 'part1' }, { type: 'text', text: 'part2' }] },
    ]);
    expect(arr).toContain('[Tool result: t]\npart1\npart2');
    // Unknown id (no matching assistant tool_call) → labelled by the id itself.
    const nul = flattenMessages([{ role: 'tool', tool_call_id: 'z', content: null }]);
    expect(nul).toBe('[Tool result: z]\n');
  });
});
