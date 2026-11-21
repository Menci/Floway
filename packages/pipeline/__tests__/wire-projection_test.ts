import { describe, expect, it } from 'vitest';

import { createDumpDecoder } from '../src/dump-decoder.ts';
import { SECRET_BRAND, SECRET_RENDERED } from '../src/types.ts';
import type { EncodedDumpEvent, Secret, StoredValue, WireHttpUrl } from '../src/types.ts';
import { formatCurlCommand, formatWireUrl, projectWireView } from '../src/wire-projection.ts';

const run: EncodedDumpEvent = {
  k: 'run',
  seq: 1,
  tMs: 0,
  runId: 'run-1',
  pipelineName: 'pipeline-1',
  startedAt: 1_000,
};

const secret = (hash: string) => ({ $secret: { length: 8, hash, redacted: '********' } }) as const;

const rawSecret = (plaintext: string): Secret<string> => ({
  [SECRET_BRAND]: true,
  [SECRET_RENDERED]: plaintext,
  length: plaintext.length,
  hash: `hash-${plaintext}`,
  reveal: () => plaintext,
});

const enterStage = (
  stageId: number,
  parentStageId: number | null,
  edgeKind: 'root' | 'child' | 'subrun',
  name: string,
  tap: 'downstream' | 'upstream',
  tMs: number,
  facts: StoredValue,
): EncodedDumpEvent => ({
  k: 'enter', seq: tMs, tMs, stageId, parentStageId, edgeKind, name, tap, facts,
});

const leaveStage = (stageId: number, tMs: number, outcome: StoredValue): EncodedDumpEvent => ({
  k: 'leave', seq: tMs, tMs, stageId, outcome,
});

const stream = (streamId: number, wraps: number | undefined, label: string, tMs: number): EncodedDumpEvent => ({
  k: 'stream', seq: tMs, tMs, streamId, createdByStageId: 10, ...(wraps === undefined ? {} : { wraps }), label,
});

const frames = (streamId: number, ...values: StoredValue[]): EncodedDumpEvent => ({
  k: 'frames',
  streamId,
  frames: values.map((value, index) => ({ seq: 100 + streamId * 10 + index, tMs: 200 + index * 5, v: value })),
});

describe('wire projection', () => {
  it('projects the streaming happy path across raw, protocol, translated, and SSE streams', () => {
    const decoder = createDumpDecoder();
    const model = decoder.pushEvents([
      run,
      enterStage(1, null, 'root', 'client', 'downstream', 10, {
        'request.http': {
          method: 'POST',
          url: { origin: 'https://example.com', pathname: '/v1/messages', query: [['beta', '1']] },
          headers: [['content-type', 'application/json']],
          body: { messages: [] },
          protocol: 'anthropic-messages',
        },
      }),
      enterStage(10, 1, 'child', 'upstream', 'upstream', 20, {
        'request.http': {
          method: 'POST',
          url: 'https://upstream.example/v1/messages?key=real-secret',
          headers: [['authorization', secret('auth-hash')]],
          body: { model: 'upstream-model' },
        },
        'route.candidate': { upstreamId: 'upstream-1', kind: 'anthropic', modelId: 'public-model', upstreamModelId: 'upstream-model' },
      }),
      stream(20, undefined, 'raw.bytes', 21),
      stream(21, 20, 'protocol.events', 22),
      stream(22, 21, 'translated.events', 23),
      stream(23, 22, 'sse.bytes', 24),
      frames(20, { raw: true }),
      frames(21, { type: 'message_start' }),
      frames(22, { type: 'content_block_delta' }),
      frames(23, 'event: content_block_delta\\n\\ndata: {}\\n\\n'),
      { k: 'end', seq: 250, tMs: 250, streamId: 23, how: 'exhausted' },
      leaveStage(10, 260, {
        status: 200,
        headers: [['content-type', 'text/event-stream']],
        body: { $stream: 20 },
        timing: { startedAtMs: 20, headersAtMs: 45 },
      }),
      leaveStage(1, 280, { status: 200, headers: [['content-type', 'text/event-stream']], body: { $stream: 23 } }),
    ]);
    const projection = projectWireView(model);
    expect(projection.downstreamRequest).toMatchObject({
      stageId: 1,
      method: 'POST',
      protocol: 'anthropic-messages',
    });
    expect(projection.upstreamAttempts).toHaveLength(1);
    expect(projection.upstreamAttempts[0]).toMatchObject({
      attemptIndex: 0,
      isSubRun: false,
      winning: true,
      ttfbMs: 25,
      candidate: { upstreamId: 'upstream-1', modelId: 'public-model' },
    });
    expect(projection.upstreamAttempts[0]?.response).toMatchObject({
      status: 200,
      rawStreamId: 20,
      protocolStreamId: 21,
    });
    expect(projection.upstreamAttempts[0]?.response?.protocolFrames).toHaveLength(1);
    expect(projection.downstreamResponse).toMatchObject({
      status: 200,
      rawStreamId: 23,
    });
    expect(projection.downstreamResponse?.protocolFrames[0]?.value).toMatchObject({ type: 'content_block_delta' });
  });

  it('marks the successful failover attempt as the winner', () => {
    const decoder = createDumpDecoder();
    const model = decoder.pushEvents([
      run,
      enterStage(4, null, 'root', 'failover', 'downstream', 10, {}),
      enterStage(5, 4, 'child', 'attempt-0', 'upstream', 20, {
        'request.http': { method: 'POST', url: 'https://one.example', headers: [] },
      }),
      leaveStage(5, 30, { status: 503, headers: [] }),
      enterStage(6, 4, 'child', 'attempt-1', 'upstream', 40, {
        'request.http': { method: 'POST', url: 'https://two.example', headers: [] },
      }),
      leaveStage(6, 60, { status: 200, headers: [] }),
    ]);
    const attempts = projectWireView(model).upstreamAttempts;
    expect(attempts.map(attempt => attempt.winning)).toEqual([false, true]);
    expect(attempts.map(attempt => attempt.response?.status)).toEqual([503, 200]);
  });

  it('badges hosted-tool sub-runs and preserves multiple turns', () => {
    const decoder = createDumpDecoder();
    const model = decoder.pushEvents([
      run,
      enterStage(1, null, 'root', 'turn-1', 'downstream', 1, {}),
      enterStage(2, 1, 'child', 'hostedTools', 'upstream', 2, {}),
      enterStage(3, 2, 'subrun', 'webSearch', 'upstream', 3, {
        'route.candidate': { kind: 'web-search' },
      }),
      leaveStage(3, 4, { status: 200, headers: [] }),
      leaveStage(2, 5, { status: 200, headers: [] }),
      enterStage(4, 1, 'child', 'turn-2', 'upstream', 10, {}),
      leaveStage(4, 20, { status: 200, headers: [] }),
    ]);
    const attempts = projectWireView(model).upstreamAttempts;
    expect(attempts).toHaveLength(3);
    expect(attempts[0]?.isSubRun).toBe(false);
    expect(attempts[1]).toMatchObject({ isSubRun: true, candidate: { kind: 'web-search' } });
    expect(attempts.map(attempt => attempt.stageId)).toEqual([2, 3, 4]);
  });

  it('formats URLs and curl commands with every secret redacted', () => {
    const url: WireHttpUrl = {
      origin: 'https://example.com',
      pathname: '/v1/responses',
      query: [['api_key', rawSecret('query-secret')], ['model', 'public']],
    };
    expect(formatWireUrl(url)).toContain('api_key=***REDACTED***');
    expect(formatWireUrl(url, { maskSecrets: true })).toContain('api_key=***REDACTED***');
    const command = formatCurlCommand({
      stageId: 1,
      tMs: 1,
      method: 'POST',
      url,
      headers: [['authorization', secret('auth-hash')], ['content-type', 'application/json']],
      body: { input: 'hello' },
    });
    expect(command).toContain('***REDACTED***');
    expect(command).toContain('application/json');
    expect(command).not.toContain('********');
    expect(command).toContain('--data-raw');
  });

  it('masks sensitive query keys in string URLs while preserving non-sensitive parameters', () => {
    expect(formatWireUrl('https://example.com/v1?token=secret&keep=value', { maskSecrets: true }))
      .toBe('https://example.com/v1?token=***REDACTED***&keep=value');
  });
});
