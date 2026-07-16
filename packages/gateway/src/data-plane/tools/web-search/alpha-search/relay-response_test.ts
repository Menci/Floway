import { describe, expect, it } from 'vitest';

import { relayFetchedResponse } from './relay-response.ts';

describe('relayFetchedResponse', () => {
  it('keeps decoded bytes and representation-safe upstream headers', async () => {
    const body = JSON.stringify({ output: 'decoded' });
    const upstream = new Response(body, {
      status: 202,
      statusText: 'Accepted upstream',
      headers: {
        connection: 'close',
        'content-encoding': 'gzip',
        'content-length': '999',
        'content-type': 'application/json',
        'set-cookie': 'session=upstream-secret',
        'transfer-encoding': 'chunked',
        'x-oai-request-id': 'req_search_1',
      },
    });

    const relayed = relayFetchedResponse(upstream);

    expect(relayed.status).toBe(202);
    expect(relayed.statusText).toBe('Accepted upstream');
    expect(await relayed.text()).toBe(body);
    expect(relayed.headers.get('content-type')).toBe('application/json');
    expect(relayed.headers.get('x-oai-request-id')).toBe('req_search_1');
    expect(relayed.headers.get('connection')).toBeNull();
    expect(relayed.headers.get('content-encoding')).toBeNull();
    expect(relayed.headers.get('content-length')).toBeNull();
    expect(relayed.headers.get('set-cookie')).toBeNull();
    expect(relayed.headers.get('transfer-encoding')).toBeNull();
  });
});
