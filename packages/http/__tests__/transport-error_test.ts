import { describe, expect, it } from 'vitest';

import { isUpstreamTransportError, UPSTREAM_TRANSPORT_ERROR, UpstreamTransportError } from '../src/index.ts';

describe('isUpstreamTransportError', () => {
  it('recognizes UpstreamTransportError and preserves its cause', () => {
    const cause = new Error('connection refused');
    const error = new UpstreamTransportError(cause);

    expect(isUpstreamTransportError(error)).toBe(true);
    expect(error.name).toBe('UpstreamTransportError');
    expect(error.message).toBe(cause.message);
    expect(error.cause).toBe(cause);
  });

  it('recognizes an Error that carries the transport marker', () => {
    const error = Object.assign(new Error('connection refused'), { [UPSTREAM_TRANSPORT_ERROR]: true });

    expect(isUpstreamTransportError(error)).toBe(true);
    expect(isUpstreamTransportError({ [UPSTREAM_TRANSPORT_ERROR]: true })).toBe(false);
  });

  it('recognizes nested aggregates of transport errors', () => {
    const error = new AggregateError([
      new UpstreamTransportError('connection refused'),
      new AggregateError([new UpstreamTransportError('connection reset')]),
    ]);

    expect(isUpstreamTransportError(error)).toBe(true);
  });

  it('rejects empty aggregates and aggregates containing other failures', () => {
    expect(isUpstreamTransportError(new AggregateError([]))).toBe(false);
    expect(isUpstreamTransportError(new AggregateError([
      new UpstreamTransportError('connection refused'),
      new Error('invalid configuration'),
    ]))).toBe(false);
  });

  it('rejects abort and plain errors', () => {
    expect(isUpstreamTransportError(new DOMException('caller disconnected', 'AbortError'))).toBe(false);
    expect(isUpstreamTransportError(new Error('invalid configuration'))).toBe(false);
  });
});
